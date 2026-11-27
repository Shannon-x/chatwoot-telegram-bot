import axios from 'axios';
import http from 'http';
import https from 'https';
import { config } from './config';
import { bot } from './bot-instance';
import { saveMapping } from './database';
import { createLogger } from './logger';
import type { ChatwootAttachment, ChatwootMessageEvent } from './types';

const log = createLogger('attachments');

const TELEGRAM_MAX_FILE_SIZE_BYTES = 45 * 1024 * 1024;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const downloadClient = axios.create({
    timeout: 20_000,
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
    headers: { api_access_token: config.chatwootAccessToken },
    maxContentLength: TELEGRAM_MAX_FILE_SIZE_BYTES + 1024 * 1024,
    maxBodyLength: TELEGRAM_MAX_FILE_SIZE_BYTES + 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 400,
});

// ============ Helpers ============

export function extractAttachments(event: ChatwootMessageEvent): ChatwootAttachment[] {
    if (Array.isArray(event?.attachments)) return event.attachments;
    if (Array.isArray(event?.message?.attachments)) return event.message.attachments;
    return [];
}

function pickAttachmentUrl(att: ChatwootAttachment): string | undefined {
    return att.data_url || att.file_url || att.download_url || att.url || att.thumb_url;
}

function attachmentFilename(att: ChatwootAttachment, url: string): string {
    if (att.file_name) return att.file_name;

    const fallback = `attachment-${att.id || Date.now()}`;
    let filename = '';
    try {
        // Active Storage URLs contain a signed blob ID followed by the original filename.
        // Require both parts so a signed ID is never used as a filename.
        const path = new URL(url, config.chatwootBaseUrl).pathname;
        const match = path.match(/^\/rails\/active_storage\/blobs\/(?:redirect|proxy)\/[^/]+\/([^/]+)$/);
        if (match) filename = decodeURIComponent(match[1]);
    } catch {
        // A malformed URL or filename falls back to a neutral name.
    }

    const basename = filename.replace(/\\/g, '/').split('/').pop() || '';
    const safe = basename.replace(/[\x00-\x1f\x7f"]/g, '').trim();
    const name = safe && safe !== '.' && safe !== '..' ? safe : fallback;
    const metadataExtension = typeof att.extension === 'string' && /^[a-z0-9]{1,10}$/i.test(att.extension)
        ? att.extension : '';
    const suffix = metadataExtension ? `.${metadataExtension}` : (safe.match(/\.[a-z0-9]{1,10}$/i)?.[0] || '');
    if (suffix && !name.toLowerCase().endsWith(suffix.toLowerCase())) {
        return name.slice(0, 200 - suffix.length) + suffix;
    }
    return name.length > 200 && suffix
        ? name.slice(0, 200 - suffix.length) + suffix : name.slice(0, 200);
}

function parseDataUrl(dataUrl: string): { mimeType?: string; buffer: Buffer } | null {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

function guessTelegramSendKind(att: ChatwootAttachment, mimeType?: string): 'photo' | 'video' | 'audio' | 'document' {
    const ft = (att.file_type || '').toLowerCase();
    const mt = (mimeType || att.content_type || '').toLowerCase();
    if (ft === 'image' || mt.startsWith('image/')) return 'photo';
    if (ft === 'video' || mt.startsWith('video/')) return 'video';
    if (ft === 'audio' || mt.startsWith('audio/')) return 'audio';
    return 'document';
}

async function downloadAttachment(att: ChatwootAttachment): Promise<{ buffer: Buffer; mimeType?: string; filename: string; size: number; sourceUrl?: string }> {
    const url = pickAttachmentUrl(att);
    if (!url) throw new Error('附件缺少可下载的 URL');
    const filename = attachmentFilename(att, url);

    if (url.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (!parsed) throw new Error('无法解析 data_url');
        return { buffer: parsed.buffer, mimeType: parsed.mimeType, filename, size: parsed.buffer.length };
    }

    const declaredSize = typeof att.file_size === 'number' ? att.file_size : (typeof att.size === 'number' ? att.size : undefined);
    if (declaredSize && declaredSize > TELEGRAM_MAX_FILE_SIZE_BYTES) {
        return { buffer: Buffer.alloc(0), filename, size: declaredSize, sourceUrl: url };
    }

    log.debug('Downloading attachment from Chatwoot', { url: url.substring(0, 120) });
    const resp = await downloadClient.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(resp.data);
    const mimeTypeHeader = (resp.headers?.['content-type'] as string | undefined) || undefined;
    log.debug('Attachment downloaded', { sizeBytes: buffer.length });
    return { buffer, mimeType: mimeTypeHeader || att.content_type, filename, size: buffer.length, sourceUrl: url };
}

// ============ Send to Telegram ============

export async function sendAttachmentToTelegram(params: {
    chatId: string;
    att: ChatwootAttachment;
    conversationId: number;
    accountId: number;
    chatwootMessageId?: number;
    messageThreadId?: number;
}) {
    const { chatId, att, conversationId, accountId, chatwootMessageId, messageThreadId } = params;
    const sendOptions: { message_thread_id?: number } = {};
    if (messageThreadId) sendOptions.message_thread_id = messageThreadId;

    log.debug('Sending attachment to Telegram', {
        conversationId,
        filename: att.file_name,
        fileType: att.file_type,
    });

    const directUrl = pickAttachmentUrl(att);
    if (directUrl && !directUrl.startsWith('data:')) {
        const kind = guessTelegramSendKind(att, att.content_type);
        try {
            let sent;
            if (kind === 'photo') sent = await bot.telegram.sendPhoto(chatId, directUrl, sendOptions);
            else if (kind === 'video') sent = await bot.telegram.sendVideo(chatId, directUrl, sendOptions);
            else if (kind === 'audio') sent = await bot.telegram.sendAudio(chatId, directUrl, sendOptions);
            else sent = await bot.telegram.sendDocument(chatId, directUrl, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
            log.debug('Attachment sent via direct URL', { filename: att.file_name, kind });
            return;
        } catch {
            log.warn('Direct URL send failed, falling back to download+upload', { filename: att.file_name });
        }
    }

    let downloaded: Awaited<ReturnType<typeof downloadAttachment>>;
    try {
        downloaded = await downloadAttachment(att);
    } catch (err) {
        log.error('Attachment download failed', { filename: att.file_name, error: String(err) });
        const url = pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(chatId, `📎 附件下载失败：${att.file_name || att.id || ''}\n${url ? `链接：${url}` : ''}`, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        return;
    }

    if (downloaded.size > TELEGRAM_MAX_FILE_SIZE_BYTES || downloaded.buffer.length === 0) {
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(
            chatId,
            `📎 附件过大（${Math.ceil(downloaded.size / 1024 / 1024)}MB）\n文件：${downloaded.filename}\n${url ? `下载链接：${url}` : ''}`,
            sendOptions,
        );
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        log.warn('Attachment too large for Telegram', { sizeMB: Math.ceil(downloaded.size / 1024 / 1024) });
        return;
    }

    const kind = guessTelegramSendKind(att, downloaded.mimeType);
    const inputFile = { source: downloaded.buffer, filename: downloaded.filename };

    try {
        let sent;
        if (kind === 'photo') sent = await bot.telegram.sendPhoto(chatId, inputFile, sendOptions);
        else if (kind === 'video') sent = await bot.telegram.sendVideo(chatId, inputFile, sendOptions);
        else if (kind === 'audio') sent = await bot.telegram.sendAudio(chatId, inputFile, sendOptions);
        else sent = await bot.telegram.sendDocument(chatId, inputFile, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        log.debug('Attachment sent via download+upload', { kind });
    } catch (err) {
        log.error('Attachment send to Telegram failed', { error: String(err) });
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(chatId, `📎 附件发送失败：${downloaded.filename}\n${url ? `链接：${url}` : ''}`, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
    }
}

/**
 * 串行发送多个附件，保留 Chatwoot 中的原始顺序。
 * 注意：并发发送会让 Telegram 客户端按到达顺序而非 Chatwoot 中的顺序排列。
 */
export async function sendAttachmentsSequentially(
    attachments: ChatwootAttachment[],
    params: {
        chatId: string;
        conversationId: number;
        accountId: number;
        chatwootMessageId?: number;
        messageThreadId?: number;
    },
) {
    for (const att of attachments) {
        try {
            await sendAttachmentToTelegram({
                chatId: params.chatId,
                att,
                conversationId: params.conversationId,
                accountId: params.accountId,
                chatwootMessageId: params.chatwootMessageId,
                messageThreadId: params.messageThreadId,
            });
        } catch (err) {
            // 单条失败不影响下一条
            log.error('sendAttachmentToTelegram threw, continuing', { filename: att.file_name, error: String(err) });
        }
    }
}
