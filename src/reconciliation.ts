// Chatwoot 4.20.1 sorts messages by created_at, so a naive before/after cursor
// can silently miss backdated ids. The two-bound API filters an ID interval and
// limits to 1000; recursively divide full intervals until each is complete.
// Exactly-once delivery to Telegram is not possible here.
type Json = Record<string, any>;
export class MessageRangeTooLarge extends Error {}
const MAX_AGE_MS = 5 * 60_000;
let enabled = false;
export class ReconciliationHealth {
    private startedAt: number | undefined;
    private lastSuccessfulPassStart: number | undefined;
    private failed = false;
    constructor(private readonly now: () => number = () => performance.now()) {}
    start(): void { this.startedAt = this.now(); }
    finish(success: boolean): void {
        this.failed = !success;
        if (success) this.lastSuccessfulPassStart = this.startedAt;
        this.startedAt = undefined;
    }
    isFailed(): boolean {
        if (this.failed || this.lastSuccessfulPassStart === undefined) return true;
        const age = this.now() - this.lastSuccessfulPassStart;
        return !Number.isFinite(age) || age < 0 || age >= MAX_AGE_MS;
    }
}
const health = new ReconciliationHealth();
export function startReconciliationPass(): void { enabled = true; health.start(); }
export function finishReconciliationPass(success: boolean): void { health.finish(success); }
export function isReconciliationFailed(): boolean {
    return enabled && health.isFailed();
}
export interface ReconcileDependencies {
    accountId: number;
    inboxId: number;
    state(now: number): { baseline: number; checkpoint: number };
    advance(checkpoint: number): void;
    enqueue(key: string, conversationId: number, payload: string): boolean;
    verifyInbox(): Promise<unknown>;
    conversations(within: number): Promise<unknown>;
    messages(conversationId: number, after: number, before: number): Promise<unknown>;
    now(): number;
}

function validId(n: unknown): n is number { return Number.isSafeInteger(n) && (n as number) > 0; }
function object(n: unknown): n is Json { return !!n && typeof n === 'object' && !Array.isArray(n); }

export async function reconcileOnce(d: ReconcileDependencies): Promise<void> {
    if (!validId(d.accountId) || !validId(d.inboxId)) throw new Error('Invalid account or inbox');
    const started = Math.floor(d.now() / 1000);
    const { baseline, checkpoint } = d.state(started);
    if (!Number.isSafeInteger(baseline) || !Number.isSafeInteger(checkpoint) || checkpoint < baseline || started + 1 < checkpoint) {
        throw new Error('Invalid reconciliation clock or checkpoint');
    }
    // Strict > filter on the server, plus overlap for clock skew and commit latency.
    const within = Math.max(120, started - checkpoint + 120);
    const since = Math.max(baseline, checkpoint - 120);
    const ensureInbox = async () => {
        const inbox = await d.verifyInbox();
        if (!object(inbox) || inbox.id !== d.inboxId) throw new Error('Configured inbox is not accessible');
        // The full inbox response may contain channel secrets: retain only fields
        // needed for the card, and never persist or log the full response.
        return { id: d.inboxId, name: typeof inbox.name === 'string' ? inbox.name : undefined,
            channel_type: typeof inbox.channel_type === 'string' ? inbox.channel_type : undefined };
    };
    const inbox = await ensureInbox();
    const data = await d.conversations(within);
    if (!object(data) || !object(data.data) || !Array.isArray(data.data.payload)) throw new Error('Invalid conversation response');
    for (const conv of data.data.payload) {
        if (!object(conv) || !validId(conv.id) || conv.account_id !== d.accountId || conv.inbox_id !== d.inboxId) {
            throw new Error('Conversation outside configured scope');
        }
        const recovered: Json[] = [];
        const seen = new Set<number>();
        const intervals: Array<[number, number]> = [[0, 2147483648]];
        let pageNumber = 0;
        while (intervals.length) {
            if (++pageNumber > 10000) throw new Error('Message interval limit exceeded');
            const [after, before] = intervals.pop()!;
            let response: unknown;
            try {
                response = await d.messages(conv.id, after, before);
            } catch (error) {
                if (!(error instanceof MessageRangeTooLarge) || before - after <= 1) throw error;
                const middle = after + Math.floor((before - after) / 2);
                intervals.push([middle, before], [after, middle]);
                continue;
            }
            if (!object(response) || !Array.isArray(response.payload)) throw new Error('Invalid message response');
            const page: unknown[] = response.payload;
            if (page.length > 1000) throw new Error('Unexpected message page size');
            const pageIds = new Set<number>();
            for (const msg of page) {
                if (!object(msg) || !validId(msg.id) || msg.id < after || msg.id >= before || pageIds.has(msg.id) ||
                    msg.conversation_id !== conv.id || msg.inbox_id !== d.inboxId ||
                    !Number.isSafeInteger(msg.created_at) || msg.created_at < 0 ||
                    typeof msg.private !== 'boolean' || !Number.isSafeInteger(msg.message_type)) {
                    throw new Error('Invalid message response');
                }
                pageIds.add(msg.id);
            }
            if (page.length === 1000) {
                if (before - after <= 1) throw new Error('Unsplitable message interval');
                const middle = after + Math.floor((before - after) / 2);
                // Low ranges are scanned first. Later scans cover concurrent inserts.
                intervals.push([middle, before], [after, middle]);
                continue;
            }
            for (const msg of page as Json[]) {
                if (seen.has(msg.id)) throw new Error('Repeated message');
                seen.add(msg.id);
                if (msg.created_at >= since && msg.message_type === 0 && msg.private === false && msg.content_attributes?.deleted !== true) {
                    recovered.push(msg);
                }
            }
        }
        recovered.sort((a, b) => a.id - b.id);
        for (const msg of recovered) {
            // The conversation index includes the last message, which could be
            // a private note. Never persist the whole response in the queue.
            const sourceId = conv.messages?.[0]?.conversation?.contact_inbox?.source_id;
            const conversation = {
                id: conv.id, account_id: d.accountId, inbox_id: d.inboxId,
                additional_attributes: conv.additional_attributes, custom_attributes: conv.custom_attributes,
                labels: conv.labels, meta: { sender: conv.meta?.sender }, channel: conv.meta?.channel,
                contact_inbox: typeof sourceId === 'string' ? { source_id: sourceId } : undefined,
            };
            const event = {
                event: 'message_created', id: msg.id, account: { id: d.accountId }, inbox,
                message_type: 'incoming', private: false, content: msg.content, content_attributes: msg.content_attributes,
                sender: msg.sender, attachments: msg.attachments, created_at: msg.created_at, conversation,
            };
            d.enqueue(`message:${d.accountId}:${msg.id}`, conv.id, JSON.stringify(event));
        }
    }
    // Each queue insert commits before this checkpoint, so any crash replays a safe overlap.
    await ensureInbox();
    d.advance(started);
}
