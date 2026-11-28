import crypto from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { bot } from './bot-instance';
import { getTopic, enqueueWebhook, nextQueuedWebhook, completeQueuedWebhook, retryQueuedWebhook, webhookQueueHealth, markQueuedTextSent, recordQueuedTextChunkSent, recordQueuedAttachmentSent, beginQueuedSend, clearQueuedSend, matchesOutgoingSource } from './database';
import type { QueuedWebhook } from './database';
import { isSelfSentMessage, conversationMutex, unresolvedOutgoingCount } from './chatwoot';
import { createLogger } from './logger';
import { renderForwardedMessage, extractContactCard, extractSenderName } from './formatters';
import { extractAttachments, sendAttachmentToTelegram } from './attachments';
import {
    getOrCreateTopic,
    closeTopicForConversation,
    reopenTopicForConversation,
    dropTopic,
    buildForumInlineKeyboard,
    buildLegacyKeyboard,
} from './topics';
import type { ChatwootMessageEvent, ChatwootConversationStatusEvent } from './types';
import { splitPlainText } from './telegram-chunks';
import { isReconciliationFailed } from './reconciliation';
import { isTelegramRejection } from './delivery-safety';

const log = createLogger('server');

export const app = express();

// ============ Raw Body Capture for Signature Verification ============

interface RawBodyRequest extends Request {
    rawBody?: Buffer;
}

app.use(express.json({
    limit: '2mb',
    verify: (req: RawBodyRequest, _res: Response, buf: Buffer) => {
        req.rawBody = buf;
    },
} as Parameters<typeof express.json>[0]));

// ============ Webhook Signature Verification ============

function verifySignature(req: RawBodyRequest, res: Response, next: NextFunction): void {
    if (!config.chatwootWebhookSecret) {
        next();
        return;
    }
    const signatureHeader = req.headers['x-chatwoot-signature'];
    const timestampHeader = req.headers['x-chatwoot-timestamp'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

    if (!signature) {
        log.warn('Webhook request missing X-Chatwoot-Signature header', { ip: req.ip });
        res.status(401).json({ error: 'Missing signature' });
        return;
    }

    if (!req.rawBody) {
        res.status(400).json({ error: 'Missing body' });
        return;
    }

    const normalizedSignature = signature.startsWith('sha256=')
        ? signature.slice('sha256='.length)
        : signature;

    const candidates = [crypto.createHmac('sha256', config.chatwootWebhookSecret).update(req.rawBody).digest('hex')];
    if (timestamp) candidates.push(crypto.createHmac('sha256', config.chatwootWebhookSecret)
        .update(`${timestamp}.${req.rawBody.toString('utf8')}`).digest('hex'));

    const valid = /^[0-9a-f]{64}$/.test(normalizedSignature) && candidates.some((candidate) => (
        candidate.length === normalizedSignature.length
        && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalizedSignature))
    ));

    if (!valid) {
        log.warn('Webhook signature verification failed', { ip: req.ip, hasTimestamp: !!timestamp });
        res.status(401).json({ error: 'Invalid signature' });
        return;
    }

    next();
}

// ============ Message Handling ============

async function handleMessageCreated(event: ChatwootMessageEvent, item: QueuedWebhook) {
    const messageType = event?.message_type;
    if (messageType !== 'incoming' && messageType !== 'outgoing') {
        log.debug('Skipping non-message event', { messageType, eventId: event?.id });
        return;
    }

    // Skip private/internal notes
    if (event?.private) {
        log.debug('Skipping private message', { eventId: event?.id });
        return;
    }

    // Prevent outgoing message loop: skip messages we sent ourselves
    if (messageType === 'outgoing' && isSelfSentMessage(event?.id)) {
        log.debug('Skipping self-sent outgoing message', { messageId: event?.id });
        return;
    }

    if (messageType === 'outgoing' && config.chatwootWebhookSecret && config.chatwootBridgeUserId &&
        typeof event.content_attributes?.telegram_bridge_origin_token === 'string' && event.account?.id === Number(config.chatwootAccountId) &&
        event.sender?.id === Number(config.chatwootBridgeUserId) && event.conversation?.id &&
        matchesOutgoingSource(event.content_attributes.telegram_bridge_origin_token, event.account.id, event.conversation.id, event.sender.id)) return;

    const conversationId = event?.conversation?.id;
    const accountId = event?.account?.id;
    if (!conversationId || !accountId) {
        log.warn('Webhook event missing conversation or account ID', { conversationId, accountId, eventId: event?.id });
        return;
    }

    const attachments = extractAttachments(event);
    const messageContent = event?.content || (attachments.length > 0 ? '[附件]' : '[无内容]');
    const { name: senderName, email: senderEmail } = extractSenderName(event);
    const contactCard = extractContactCard(event);

    log.info('Processing webhook message', {
        conversationId,
        messageType,
        attachmentCount: attachments.length,
        chatwootMessageId: event?.id,
    });

    const newTopic = !!config.telegramForumChatId && !getTopic(conversationId);
    if (newTopic) beginQueuedSend(item.id, 'topic');
    const topicId = await getOrCreateTopic(conversationId, accountId, contactCard, newTopic ? item.id : undefined);
    if (config.telegramForumChatId && !topicId) {
        throw new Error('Cannot obtain Telegram topic');
    }
    const isForumMode = !!topicId && !!config.telegramForumChatId;
    const chatId = isForumMode ? config.telegramForumChatId : config.telegramAdminId;

    const text = renderForwardedMessage({
        messageType,
        senderName,
        senderEmail,
        content: messageContent,
        attachmentCount: attachments.length,
    });

    const replyMarkup = isForumMode
        ? buildForumInlineKeyboard(conversationId, accountId, contactCard.contactId)
        : buildLegacyKeyboard(conversationId, accountId);

    const commonOptions = {
        message_thread_id: topicId,
        reply_markup: replyMarkup,
        link_preview_options: { is_disabled: true },
    };

    const plain = `${messageType === 'incoming' ? '👤' : '🤖'} ${senderName}${senderEmail ? ` (${senderEmail})` : ''}\n${messageType === 'incoming' ? '💬' : '📤'} ${messageContent}${attachments.length ? `\n📎 附件: ${attachments.length}` : ''}`;
    const htmlMode = text.length <= 3000;
    const chunks = htmlMode ? [text] : splitPlainText(plain);
    const sendOptions = htmlMode ? { ...commonOptions, parse_mode: 'HTML' as const } : commonOptions;

    const deliverRemaining = async () => {
        if (!item.text_sent) {
            for (let i = item.text_chunk_index ?? 0; i < chunks.length; i++) {
                beginQueuedSend(item.id, `text:${i}`);
                let sentMessage;
                try { sentMessage = await bot.telegram.sendMessage(chatId, chunks[i], sendOptions); }
                catch (error) { if (isTelegramRejection(error)) clearQueuedSend(item.id); throw error; }
                recordQueuedTextChunkSent(item.id, i + 1, sentMessage.message_id, conversationId, accountId, event?.id);
                item.text_chunk_index = i + 1;
            }
            markQueuedTextSent(item.id);
            item.text_sent = 1;
        }
        for (let i = item.attachment_index; i < attachments.length; i++) {
            await sendAttachmentToTelegram({ chatId, att: attachments[i], conversationId, accountId,
                chatwootMessageId: event?.id, messageThreadId: topicId,
                beginSend: () => beginQueuedSend(item.id, `attachment:${i}`),
                clearSend: () => clearQueuedSend(item.id),
                recordSent: id => recordQueuedAttachmentSent(item.id, i + 1, id, conversationId, accountId, event?.id) });
            item.attachment_index = i + 1;
        }
    };

    try {
        await deliverRemaining();
    } catch (error: unknown) {
        const errObj = error as { response?: { description?: string }; message?: string };
        if (isTelegramRejection(error) && errObj?.response?.description?.includes('TOPIC_CLOSED')) {
            // Reopen the same mapped topic. A later queued open event can then
            // be acknowledged as a no-op if Telegram reports NOT_MODIFIED.
            if (await reopenTopicForConversation(conversationId)) {
                await deliverRemaining();
                return;
            }
        }
        if (isTelegramRejection(error) && errObj?.response?.description?.includes('TOPIC_DELETED')) {
            if (item.text_sent || item.text_chunk_index || item.attachment_index) {
                // The old topic contained confirmed parts. Recreating it and
                // sending only the remainder would lose the visible context.
                log.error('Topic deleted after partial delivery; manual recovery required', { conversationId });
            } else {
                // No content was confirmed in that topic; recreate on retry.
                dropTopic(conversationId);
            }
        }
        // A deleted topic or a failed reopen needs operator attention. Do not
        // silently replace its mapping, and do not lose the pending event.
        log.error('Failed to send message to Telegram', { conversationId });
        throw error;
    }
}

async function handleConversationStatusChanged(event: ChatwootConversationStatusEvent) {
    const conversationId = event?.id || event?.conversation?.id;
    const status = event?.status;
    if (!conversationId) return;
    // A previous forum deployment may have left mappings in the database.
    // In legacy mode there is no Telegram topic status to change.
    if (!config.telegramForumChatId) return;
    // A conversation with no topic has no Telegram state to update.
    if (!getTopic(conversationId)) return;

    log.info('Conversation status changed', { conversationId, status });

    if (status === 'resolved') {
        const closed = await closeTopicForConversation(conversationId);
        if (!closed) throw new Error('Failed to close topic');
        if (closed) log.info('Conversation resolved, topic closed', { conversationId });
    } else if (status === 'open') {
        // 后台重开会话时，自动重开 Telegram 话题
        const reopened = await reopenTopicForConversation(conversationId);
        if (!reopened) throw new Error('Failed to reopen topic');
        if (reopened) log.info('Conversation reopened, topic reopened', { conversationId });
    }
}

// ============ Routes ============

app.get('/health', (_req: Request, res: Response) => {
    try {
        const queue = webhookQueueHealth(activeQueueId);
        const failed = !!queue.failed || !!unresolvedOutgoingCount() || isReconciliationFailed() || queueWorkerHealth.isStalled();
        res.status(failed ? 503 : 200).json({ status: failed ? 'degraded' : 'ok', queue });
    } catch {
        res.status(503).json({ status: 'unavailable' });
    }
});

app.post('/webhook', verifySignature, (req: RawBodyRequest, res: Response) => {
    const event = req.body;

    const eventType = event?.event as string | undefined;
    const eventId = event?.id;

    // Chatwoot v4.20.1 message.webhook_data has account/inbox objects;
    // conversation.webhook_data used by status events has account + inbox_id.
    const accountId = event?.account?.id;
    // Preserve the existing webhook scope; reconciliation is explicitly scoped
    // separately. The shared account/message key deduplicates either route.

    if (eventType !== 'message_created' && eventType !== 'conversation_status_changed') {
        res.sendStatus(200);
        return;
    }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        res.status(400).json({ error: 'Invalid account identifier' });
        return;
    }
    // These do not need to be stored as message content.
    if (eventType === 'message_created' && (event?.private || !['incoming', 'outgoing'].includes(event?.message_type))) {
        res.sendStatus(200);
        return;
    }
    // Check this before queuing: processing can be delayed past the in-memory TTL.
    if (eventType === 'message_created' && event?.message_type === 'outgoing' && isSelfSentMessage(eventId)) {
        res.sendStatus(200);
        return;
    }

    const convId = eventType === 'message_created' ? event?.conversation?.id : (event?.id || event?.conversation?.id);
    if (!Number.isSafeInteger(convId) || convId <= 0 ||
        (eventType === 'message_created' && (!Number.isSafeInteger(eventId) || eventId <= 0))) {
        res.status(400).json({ error: 'Invalid event identifiers' });
        return;
    }

    // A marker is generated and persisted locally before the bridge's POST.
    // Never trust a claimed marker alone: require signed webhook verification,
    // the configured dedicated bridge sender, and exact account/conversation.
    if (eventType === 'message_created' && event?.message_type === 'outgoing' &&
        config.chatwootWebhookSecret && config.chatwootBridgeUserId && typeof event?.content_attributes?.telegram_bridge_origin_token === 'string' &&
        Number.isSafeInteger(event?.sender?.id) && event.sender.id === Number(config.chatwootBridgeUserId) &&
        accountId === Number(config.chatwootAccountId) &&
        matchesOutgoingSource(event.content_attributes.telegram_bridge_origin_token, accountId, convId, event.sender.id)) {
        res.sendStatus(200);
        return;
    }

    log.debug('Webhook received', {
        eventType,
        eventId,
        conversationId: event?.conversation?.id,
        messageType: event?.message_type,
    });

    const deliveryHeader = req.headers['x-chatwoot-delivery'];
    const deliveryId = typeof deliveryHeader === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(deliveryHeader)
        ? deliveryHeader : crypto.randomUUID();
    const eventKey = eventType === 'message_created'
        ? `message:${accountId}:${eventId}` : `delivery:${deliveryId}`;
    try {
        // better-sqlite3 executes and commits synchronously before returning.
        enqueueWebhook(eventKey, convId, req.rawBody!.toString('utf8'));
    } catch {
        // Account webhooks are not automatically retried by Chatwoot v4.20.1.
        log.error('Webhook could not be persisted; reconciliation is required', { eventType, eventId, convId });
        res.status(503).json({ error: 'Unable to persist event' });
        return;
    }
    res.sendStatus(200);
    setImmediate(() => { void drainWebhookQueue(); });
});

let draining = false;
let stoppingQueue = false;
let activeQueueId: number | undefined;
export class QueueWorkerHealth {
    private startedAt: number | undefined;
    constructor(private readonly now: () => number = () => performance.now()) {}
    start(): void { this.startedAt = this.now(); }
    finish(): void { this.startedAt = undefined; }
    isStalled(): boolean {
        if (this.startedAt === undefined) return false;
        const age = this.now() - this.startedAt;
        return !Number.isFinite(age) || age < 0 || age >= 5 * 60_000;
    }
}
const queueWorkerHealth = new QueueWorkerHealth();
export async function drainWebhookQueue(): Promise<void> {
    if (draining || stoppingQueue) return;
    draining = true;
    try {
        // This is deliberately a single worker: one bridge, and ordered effects.
        while (!stoppingQueue) {
            const item = nextQueuedWebhook();
            if (!item) break;
            activeQueueId = item.id;
            queueWorkerHealth.start();
            try {
                const event = JSON.parse(item.payload);
                await conversationMutex.runExclusive(`conv_${item.conversation_id}`, async () => {
                    if (event.event === 'message_created') await handleMessageCreated(event as ChatwootMessageEvent, item);
                    else if (event.event === 'conversation_status_changed') await handleConversationStatusChanged(event as ChatwootConversationStatusEvent);
                    else throw new Error('Unknown queued event');
                });
                completeQueuedWebhook(item.id);
            } catch {
                // Do not log the exception: it may contain message bodies or tokens.
                log.error('Queued webhook delivery failed; retry or manual review required', { queueId: item.id, conversationId: item.conversation_id });
                retryQueuedWebhook(item.id, item.attempts);
            } finally {
                queueWorkerHealth.finish();
                activeQueueId = undefined;
            }
        }
    } catch {
        log.error('Webhook queue unavailable; reconciliation may be required');
    } finally {
        draining = false;
    }
}

// Recovers persisted pending rows after restart and retries temporary errors.
const queueTimer = setInterval(() => { void drainWebhookQueue(); }, 1_000);
queueTimer.unref();

export async function stopWebhookQueue(): Promise<void> {
    stoppingQueue = true;
    clearInterval(queueTimer);
    while (draining) await new Promise(resolve => setTimeout(resolve, 50));
}

export { closeTopicForConversation };
