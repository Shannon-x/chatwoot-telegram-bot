import { config } from './config';
import { bot } from './bot-instance';
import { saveMapping } from './database';
import { createLogger } from './logger';
import type { ChatwootAttachment, ChatwootMessageEvent } from './types';
import { isTelegramRejection, isRejectedFileUrl } from './delivery-safety';
import { downloadSafeChatwootAttachment } from './safe-download';

const log = createLogger('attachments');

const TELEGRAM_MAX_FILE_SIZE_BYTES = 45 * 1024 * 1024;

// ============ Helpers ============

export function extractAttachments(event: ChatwootMessageEvent): ChatwootAttachment[] {
    if (Array.isArray(event?.attachments)) return event.attachments;
    if (Array.isArray(event?.message?.attachments)) return event.message.attachments;
    return [];
}

function pickAttachmentUrl(att: ChatwootAttachment): string | undefined {
    return att.data_url || att.file_url || att.download_url || att.url || att.thumb_url;
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
    const filename = att.file_name || `attachment-${att.id || Date.now()}`;
    const url = pickAttachmentUrl(att);
    if (!url) throw new Error('附件缺少可下载的 URL');

    if (url.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (!parsed) throw new Error('无法解析 data_url');
        return { buffer: parsed.buffer, mimeType: parsed.mimeType, filename, size: parsed.buffer.length };
    }

    const declaredSize = typeof att.file_size === 'number' ? att.file_size : (typeof att.size === 'number' ? att.size : undefined);
    if (declaredSize && declaredSize > TELEGRAM_MAX_FILE_SIZE_BYTES) {
        return { buffer: Buffer.alloc(0), filename, size: declaredSize, sourceUrl: url };
    }

    const { buffer, mimeType } = await downloadSafeChatwootAttachment(url, config.chatwootBaseUrl, config.chatwootAccessToken,
        {allowedExternalOrigins: config.attachmentDownloadOrigins});
    log.debug('Attachment downloaded', { filename, sizeBytes: buffer.length });
    return { buffer, mimeType: mimeType || att.content_type, filename, size: buffer.length, sourceUrl: url };
}

// ============ Send to Telegram ============

export async function sendAttachmentToTelegram(params: {
    chatId: string;
    att: ChatwootAttachment;
    conversationId: number;
    accountId: number;
    chatwootMessageId?: number;
    messageThreadId?: number;
    recordSent?: (telegramMessageId: number) => void;
    beginSend?: () => void;
    clearSend?: () => void;
}) {
    const { chatId, att, conversationId, accountId, chatwootMessageId, messageThreadId, recordSent, beginSend, clearSend } = params;
    const commit = (id: number) => recordSent ? recordSent(id) : saveMapping(id, conversationId, accountId, chatwootMessageId);
    const send = async (fn: () => Promise<{message_id: number}>) => {
        beginSend?.();
        let result: {message_id: number};
        try { result = await fn(); }
        catch (error) { if (isTelegramRejection(error)) clearSend?.(); throw error; }
        commit(result.message_id);
        return result;
    };
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
        let sent: { message_id: number } | undefined;
        try {
            if (kind === 'photo') sent = await send(() => bot.telegram.sendPhoto(chatId, directUrl, sendOptions));
            else if (kind === 'video') sent = await send(() => bot.telegram.sendVideo(chatId, directUrl, sendOptions));
            else if (kind === 'audio') sent = await send(() => bot.telegram.sendAudio(chatId, directUrl, sendOptions));
            else sent = await send(() => bot.telegram.sendDocument(chatId, directUrl, sendOptions));
        } catch (error) {
            // A timeout/network failure may mean Telegram already accepted the
            // file. Never immediately send another copy on an unknown outcome.
            if (!isRejectedFileUrl(error)) throw error;
            log.warn('Direct URL send failed, falling back to download+upload', { filename: att.file_name });
        }
        if (sent) {
            log.debug('Attachment sent via direct URL', { filename: att.file_name, kind });
            return;
        }
    }

    let downloaded: Awaited<ReturnType<typeof downloadAttachment>>;
    try {
        downloaded = await downloadAttachment(att);
    } catch (err) {
        // No Telegram side effect has occurred for this attempt. Keep the
        // file pending rather than acknowledging a link as a delivered file.
        if (err instanceof Error && /Untrusted attachment URL|Invalid object storage origin/.test(err.message)) {
            log.error('Attachment origin rejected; configure ATTACHMENT_DOWNLOAD_ORIGINS for trusted HTTPS object storage');
        } else log.error('Attachment download failed; retained for retry');
        throw err;
    }

    if (downloaded.size > TELEGRAM_MAX_FILE_SIZE_BYTES || downloaded.buffer.length === 0) {
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        await send(() => bot.telegram.sendMessage(
            chatId,
            `📎 附件过大（${Math.ceil(downloaded.size / 1024 / 1024)}MB）\n文件：${downloaded.filename}\n${url ? `下载链接：${url}` : ''}`,
            sendOptions,
        ));
        log.warn('Attachment too large for Telegram', { filename: downloaded.filename, sizeMB: Math.ceil(downloaded.size / 1024 / 1024) });
        return;
    }

    const kind = guessTelegramSendKind(att, downloaded.mimeType);
    const inputFile = { source: downloaded.buffer, filename: downloaded.filename };

    let sent: { message_id: number } | undefined;
    try {
        if (kind === 'photo') sent = await send(() => bot.telegram.sendPhoto(chatId, inputFile, sendOptions));
        else if (kind === 'video') sent = await send(() => bot.telegram.sendVideo(chatId, inputFile, sendOptions));
        else if (kind === 'audio') sent = await send(() => bot.telegram.sendAudio(chatId, inputFile, sendOptions));
        else sent = await send(() => bot.telegram.sendDocument(chatId, inputFile, sendOptions));
    } catch (err) {
        if (!isTelegramRejection(err) || (err as { response?: { error_code?: number } }).response?.error_code !== 400) throw err;
        log.error('Attachment send to Telegram was rejected');
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        sent = await send(() => bot.telegram.sendMessage(chatId, `📎 附件发送失败：${downloaded.filename}\n${url ? `链接：${url}` : ''}`, sendOptions));
    }
    log.debug('Attachment sent via download+upload', { filename: downloaded.filename, kind });
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
