import axios from 'axios';
import http from 'http';
import https from 'https';
import FormData from 'form-data';
import { config } from './config';
import { createLogger, extractAxiosError } from './logger';
import { KeyedMutex } from './mutex';
import type { CannedResponse, CustomAttributeDefinition, ChatwootContactDetail, ChatwootConversation } from './types';
import { MessageRangeTooLarge } from './reconciliation';

const log = createLogger('chatwoot');

/** 对外暴露：同会话写操作互斥（顺序：发送 + 标记已读 + 状态切换 …） */
export const conversationMutex = new KeyedMutex();

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const client = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 15_000,
    httpAgent,
    httpsAgent,
    headers: {
        'api_access_token': config.chatwootAccessToken,
        'Content-Type': 'application/json',
    },
});

// The fixed base URL and no redirects keep credentials on the configured host.
const reconciliationClient = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 15_000,
    maxRedirects: 0,
    maxContentLength: 20 * 1024 * 1024,
    headers: { api_access_token: config.chatwootAccessToken },
});

export async function verifyReconciliationInbox(): Promise<unknown> {
    const response = await reconciliationClient.get(`/api/v1/accounts/${config.chatwootAccountId}/inboxes/${config.reconciliationInboxId}`);
    return response.data;
}

export async function listChangedConversations(updatedWithin: number): Promise<unknown> {
    const response = await reconciliationClient.get(`/api/v1/accounts/${config.chatwootAccountId}/conversations`, {
        params: { inbox_id: config.reconciliationInboxId, status: 'all', assignee_type: 'all', updated_within: updatedWithin },
    });
    return response.data;
}

export async function listConversationMessages(conversationId: number, after: number, before: number): Promise<unknown> {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(before) || after < 0 || before > 2147483648 || after >= before) {
        throw new Error('Invalid reconciliation ID');
    }
    const maxContentLength = 20 * 1024 * 1024;
    try {
        const response = await reconciliationClient.get(`/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/messages`, {
            params: { after, before }, maxContentLength,
        });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error) && error.code === 'ERR_BAD_RESPONSE' &&
            error.message === `maxContentLength size of ${maxContentLength} exceeded`) throw new MessageRangeTooLarge();
        throw error;
    }
}

const uploadClient = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 60_000,
    httpAgent,
    httpsAgent,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
});

// ============ Retry with Exponential Backoff ============

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3, baseDelay = 1000): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: unknown) {
            lastError = error;
            if (attempt === maxRetries) break;

            const axErr = error as { response?: { status?: number } };
            const status = axErr?.response?.status;

            // Don't retry client errors (except 429 Too Many Requests)
            if (status && status >= 400 && status < 500 && status !== 429) {
                log.error(`${label} failed with client error (not retriable)`, extractAxiosError(error));
                break;
            }

            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
            log.warn(`${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`, {
                status,
                ...extractAxiosError(error),
            });
            await new Promise(r => setTimeout(r, delay));
        }
    }

    log.error(`${label} exhausted all retries`, extractAxiosError(lastError));
    throw lastError;
}

// ============ Outgoing Message Loop Prevention ============

const SENT_ID_TTL_MS = 120_000;
const recentlySentIds = new Map<number, number>();

const sentIdCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - SENT_ID_TTL_MS;
    for (const [id, ts] of recentlySentIds) {
        if (ts < cutoff) recentlySentIds.delete(id);
    }
}, SENT_ID_TTL_MS);
sentIdCleanupTimer.unref();

function trackSentMessage(chatwootMessageId: number) {
    recentlySentIds.set(chatwootMessageId, Date.now());
    log.debug('Tracked sent message for dedup', { chatwootMessageId });
}

export function isSelfSentMessage(chatwootMessageId: number | undefined): boolean {
    if (!chatwootMessageId) return false;
    return recentlySentIds.has(chatwootMessageId);
}

// ============ Messages ============

/**
 * 注意：mutex 只包提交动作本身（保证同会话写入顺序），不包 withRetry 重试。
 * 这样 5xx 重试期间不会阻塞同会话的后续读写。
 */
async function postMessage(conversationId: number, body: Record<string, unknown>, label: string) {
    const accountId = config.chatwootAccountId;
    const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const data = await withRetry(async () => {
        const response = await client.post(url, body);
        return response.data;
    }, label);
    if (data?.id) trackSentMessage(data.id);
    return data;
}

export async function createMessage(conversationId: number, content: string) {
    log.debug('Creating message in Chatwoot', {
        conversationId,
        contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
    });

    const result = await conversationMutex.runExclusive(`conv_${conversationId}`, () =>
        postMessage(conversationId, { content, message_type: 'outgoing', private: false }, `createMessage(conv=${conversationId})`)
    );

    log.info('Message created in Chatwoot', { conversationId, chatwootMessageId: result?.id });
    // 发送成功后主动关闭输入状态，避免后台一直显示"客服正在输入"
    void toggleTypingStatus(conversationId, 'off');
    return result;
}

export async function createPrivateNote(conversationId: number, content: string) {
    log.debug('Creating private note in Chatwoot', { conversationId });

    const result = await conversationMutex.runExclusive(`conv_${conversationId}`, () =>
        postMessage(conversationId, { content, message_type: 'outgoing', private: true }, `createPrivateNote(conv=${conversationId})`)
    );

    log.info('Private note created in Chatwoot', { conversationId, chatwootMessageId: result?.id });
    return result;
}

export async function createMessageWithAttachment(
    conversationId: number,
    content: string,
    attachment: { buffer: Buffer; filename: string; mimeType?: string }
) {
    log.debug('Creating message with attachment in Chatwoot', {
        conversationId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.buffer.length,
    });

    const result = await conversationMutex.runExclusive(`conv_${conversationId}`, async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;

        const data = await withRetry(async () => {
            // FormData 必须每次重建：内部流不可重放，重试时复用会导致 0 字节请求
            const formData = new FormData();
            formData.append('content', content || '');
            formData.append('message_type', 'outgoing');
            formData.append('private', 'false');
            formData.append('attachments[]', attachment.buffer, {
                filename: attachment.filename,
                contentType: attachment.mimeType || 'application/octet-stream',
            });
            const response = await uploadClient.post(url, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'api_access_token': config.chatwootAccessToken,
                },
            });
            return response.data;
        }, `createMessageWithAttachment(conv=${conversationId})`);

        if (data?.id) trackSentMessage(data.id);
        return data;
    });

    log.info('Attachment message created in Chatwoot', {
        conversationId,
        chatwootMessageId: result?.id,
        filename: attachment.filename,
    });
    void toggleTypingStatus(conversationId, 'off');
    return result;
}

// ============ Conversation Status ============

export async function toggleConversationStatus(conversationId: number, status: 'open' | 'resolved') {
    log.debug('Toggling conversation status', { conversationId, status });

    const result = await conversationMutex.runExclusive(`conv_${conversationId}`, () =>
        withRetry(async () => {
            const accountId = config.chatwootAccountId;
            const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
            const response = await client.post(url, { status });
            return response.data;
        }, `toggleStatus(conv=${conversationId}, status=${status})`)
    );

    log.info('Conversation status toggled', { conversationId, status });
    return result;
}

// ============ Typing Status ============

export async function toggleTypingStatus(conversationId: number, typingStatus: 'on' | 'off') {
    try {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_typing_status`;
        await client.post(url, { typing_status: typingStatus });
        log.debug('Typing status toggled', { conversationId, typingStatus });
    } catch (error) {
        log.debug('Failed to toggle typing status (non-critical)', { conversationId, typingStatus, ...extractAxiosError(error) });
    }
}

// ============ Custom Attribute Definitions (with cache) ============

/**
 * 属性定义变化频率极低，缓存 10 分钟。
 * 分别缓存 contact_attribute 和 conversation_attribute。
 */
const CAD_CACHE_TTL_MS = 10 * 60 * 1000;
const cadCache = new Map<string, { data: CustomAttributeDefinition[]; ts: number }>();

export async function getCustomAttributeDefinitions(
    model: 'contact_attribute' | 'conversation_attribute' = 'contact_attribute'
): Promise<CustomAttributeDefinition[]> {
    const cached = cadCache.get(model);
    if (cached && Date.now() - cached.ts < CAD_CACHE_TTL_MS) {
        return cached.data;
    }

    try {
        const data = await withRetry(async () => {
            const accountId = config.chatwootAccountId;
            const url = `/api/v1/accounts/${accountId}/custom_attribute_definitions`;
            const response = await client.get<CustomAttributeDefinition[]>(url, {
                params: { attribute_model: model },
            });
            return response.data;
        }, `getCustomAttributeDefinitions(${model})`);

        cadCache.set(model, { data, ts: Date.now() });
        log.debug('Fetched custom attribute definitions', { model, count: data.length });
        return data;
    } catch (err) {
        log.warn('Failed to fetch custom attribute definitions, using cache or empty', {
            model,
            ...extractAxiosError(err),
        });
        return cached?.data || [];
    }
}

// ============ Contact Detail (按需拉取联系人完整资料) ============

/** 拉取联系人完整资料（不缓存：点击按钮才调，要拿到最新值） */
export async function getContact(contactId: number): Promise<ChatwootContactDetail> {
    return withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/contacts/${contactId}`;
        const response = await client.get<{ payload?: ChatwootContactDetail } | ChatwootContactDetail>(url);
        // Chatwoot v3 包了一层 payload，v2 直接返回
        const body = response.data as { payload?: ChatwootContactDetail };
        return body.payload ?? (response.data as ChatwootContactDetail);
    }, `getContact(${contactId})`);
}

/**
 * 拉取单个会话完整资料（不缓存：点击「刷新最新资料」才调，要拿到最新值）。
 * 用于补齐 contact API 拿不到的会话维度信息：
 * source_id、渠道、浏览器/IP/referer/语言/发起时间（均在 conversation.additional_attributes）。
 */
export async function getConversation(conversationId: number): Promise<ChatwootConversation> {
    return withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}`;
        const response = await client.get<{ payload?: ChatwootConversation } | ChatwootConversation>(url);
        // 兼容可能的 payload 包裹
        const body = response.data as { payload?: ChatwootConversation };
        return body.payload ?? (response.data as ChatwootConversation);
    }, `getConversation(${conversationId})`);
}

// ============ Canned Responses (with short-lived cache) ============

const CANNED_CACHE_TTL_MS = 30_000;
let cannedCache: { data: CannedResponse[]; key: string; ts: number } | null = null;

export async function getCannedResponses(search?: string): Promise<CannedResponse[]> {
    const cacheKey = search || '__all__';
    if (cannedCache && cannedCache.key === cacheKey && Date.now() - cannedCache.ts < CANNED_CACHE_TTL_MS) {
        log.debug('Returning cached canned responses', { count: cannedCache.data.length });
        return cannedCache.data;
    }

    const data = await withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/canned_responses`;
        const params: Record<string, string> = {};
        if (search) params.search = search;
        const response = await client.get(url, { params });
        return response.data as CannedResponse[];
    }, 'getCannedResponses');

    log.debug('Fetched canned responses', { count: data.length, search });
    cannedCache = { data, key: cacheKey, ts: Date.now() };
    return data;
}
