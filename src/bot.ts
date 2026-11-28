import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { bot } from './bot-instance';
import { config } from './config';
import { getMapping, getTopicByTopicId } from './database';
import {
    createMessage,
    createMessageWithAttachment,
    UnknownChatwootSend,
    toggleTypingStatus,
    getCannedResponses,
} from './chatwoot';
import { createLogger, extractAxiosError } from './logger';
import { dispatchCallback } from './callback-router';
import { sendCannedResponsePage } from './canned';

const log = createLogger('bot');

export { bot };

// ============ Helpers ============

function isFromForum(ctx: Context): boolean {
    return !!config.telegramForumChatId && ctx.chat?.id.toString() === config.telegramForumChatId;
}

function isAdmin(ctx: Context): boolean {
    return ctx.from?.id.toString() === config.telegramAdminId;
}

/**
 * Set a reaction emoji on a message to provide visual feedback.
 * Returns true if successful, false if failed (caller can use fallback).
 */
async function setMessageReaction(chatId: string | number, messageId: number, emoji: string): Promise<boolean> {
    try {
        await (bot.telegram as unknown as { callApi: (m: string, p: unknown) => Promise<unknown> }).callApi('setMessageReaction', {
            chat_id: chatId,
            message_id: messageId,
            reaction: [{ type: 'emoji', emoji }],
        });
        return true;
    } catch (err) {
        log.debug('Failed to set message reaction', { chatId, messageId, emoji, error: String(err) });
        return false;
    }
}

/** 从消息中安全提取 reply_to_message（避免大量 as 断言） */
function getReplyTo(msg: Message | undefined): Message | undefined {
    return msg && 'reply_to_message' in msg ? (msg.reply_to_message as Message | undefined) : undefined;
}

/** 从消息中安全提取 thread id */
function getThreadId(msg: Message | undefined): number | undefined {
    return msg && 'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
}

/**
 * Resolve the Chatwoot conversation ID from either forum topic or reply context.
 */
function resolveConversationId(ctx: Context): number | null {
    if (isFromForum(ctx)) {
        const threadId = getThreadId(ctx.message);
        if (threadId) {
            const mapping = getTopicByTopicId(threadId);
            return mapping ? mapping.chatwoot_conversation_id : null;
        }
        return null;
    }

    if (!isAdmin(ctx)) return null;

    const replyTo = getReplyTo(ctx.message);
    if (!replyTo) return null;

    const mapping = getMapping(replyTo.message_id);
    return mapping ? mapping.chatwoot_conversation_id : null;
}

// ============ /canned Command ============

bot.command('canned', async (ctx) => {
    const conversationId = resolveConversationId(ctx);
    if (!conversationId) {
        await ctx.reply('请在对话话题中使用此命令，或回复一条客户消息。');
        return;
    }

    try {
        const searchTerm = ctx.message.text.replace(/^\/canned\s*/, '').trim() || undefined;
        const responses = await getCannedResponses(searchTerm);

        if (responses.length === 0) {
            await ctx.reply(searchTerm ? `未找到匹配 "${searchTerm}" 的预设回复。` : '暂无预设回复。');
            return;
        }

        await sendCannedResponsePage(ctx, responses, 0, conversationId);
    } catch (error) {
        log.error('Failed to fetch canned responses', extractAxiosError(error));
        await ctx.reply('获取预设回复失败，请检查日志。');
    }
});

// ============ Text Message Handler ============

async function reactSuccess(ctx: Context, msg: Message) {
    const reacted = await setMessageReaction(ctx.chat!.id, msg.message_id, '👍');
    if (!reacted) {
        await ctx.reply('✅ 已发送', { reply_parameters: { message_id: msg.message_id } });
    }
}

async function reactFailure(ctx: Context, msg: Message, hint?: string) {
    const reacted = await setMessageReaction(ctx.chat!.id, msg.message_id, '👎');
    if (!reacted) {
        await ctx.reply('❌ 发送失败', { reply_parameters: { message_id: msg.message_id } });
    }
    if (hint) await ctx.reply(hint);
}

bot.on('text', async (ctx) => {
    const msg = ctx.message;

    // Skip bot commands (already handled above)
    if (msg.text.startsWith('/')) return;

    const conversationId = resolveConversationId(ctx);
    if (!conversationId) {
        if (!isFromForum(ctx) && isAdmin(ctx)) {
            const replyTo = getReplyTo(msg);
            await ctx.reply(replyTo ? '找不到与此消息关联的会话。可能已过期或不是来自机器人。' : '请回复客户消息来发送回复。');
        }
        return;
    }

    log.debug('Processing user text message', {
        conversationId,
        fromForum: isFromForum(ctx),
    });

    try {
        void toggleTypingStatus(conversationId, 'on');
        await createMessage(conversationId, msg.text, {chatId: String(ctx.chat.id), eventId: `message:${msg.message_id}`});
        await reactSuccess(ctx, msg);
        log.info('Message sent to Chatwoot', { conversationId });
    } catch (error) {
        log.error('Failed to send message to Chatwoot', { conversationId, ...extractAxiosError(error) });
        if (error instanceof UnknownChatwootSend) await ctx.reply('⚠️ 发送结果未知。请先检查 Chatwoot 对话，再决定是否重试。');
        else await reactFailure(ctx, msg, '❌ 发送消息到 Chatwoot 失败，请查看日志。');
    }
});

// ============ Callback Query Handler ============

bot.on('callback_query', async (ctx) => {
    await dispatchCallback(ctx);
});

// ============ Media Message Handlers ============

async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
    log.debug('Downloading Telegram file', { fileId });
    const file = await bot.telegram.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error('无法获取文件路径');

    const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`下载文件失败: ${response.status} ${response.statusText}`);

    const arrayBuffer = await response.arrayBuffer();
    log.debug('Telegram file downloaded', { fileId, filePath, sizeBytes: arrayBuffer.byteLength });
    return { buffer: Buffer.from(arrayBuffer), filePath };
}

async function handleMediaMessage(
    ctx: Context,
    fileId: string,
    filename: string,
    mimeType: string | undefined,
    caption?: string,
) {
    const conversationId = resolveConversationId(ctx);
    if (!conversationId) {
        if (!isFromForum(ctx) && isAdmin(ctx) && !getReplyTo(ctx.message)) {
            await ctx.reply('请回复客户消息来发送附件。');
        }
        return;
    }

    log.debug('Processing media message', { conversationId, filename, mimeType, fileId });
    const msg = ctx.message!;

    try {
        void toggleTypingStatus(conversationId, 'on');
        const { buffer, filePath } = await downloadTelegramFile(fileId);
        const finalFilename = filename || filePath.split('/').pop() || `file_${Date.now()}`;

        await createMessageWithAttachment(conversationId, caption || '', {
            buffer,
            filename: finalFilename,
            mimeType,
        }, {chatId: String(ctx.chat!.id), eventId: `message:${msg.message_id}`});
        await reactSuccess(ctx, msg);
        log.info('Attachment sent to Chatwoot', { conversationId, filename: finalFilename });
    } catch (error) {
        log.error('Failed to send attachment to Chatwoot', { conversationId, filename, ...extractAxiosError(error) });
        if (error instanceof UnknownChatwootSend) await ctx.reply('⚠️ 发送结果未知。请先检查 Chatwoot 对话，再决定是否重试。');
        else await reactFailure(ctx, msg, '❌ 发送附件到 Chatwoot 失败，请查看日志。');
    }
}

bot.on('photo', async (ctx) => {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    await handleMediaMessage(ctx, photo.file_id, `photo_${Date.now()}.jpg`, 'image/jpeg', ctx.message.caption || '');
});

bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    await handleMediaMessage(ctx, doc.file_id, doc.file_name || `document_${Date.now()}`, doc.mime_type, ctx.message.caption || '');
});

bot.on('video', async (ctx) => {
    const video = ctx.message.video;
    await handleMediaMessage(ctx, video.file_id, video.file_name || `video_${Date.now()}.mp4`, video.mime_type || 'video/mp4', ctx.message.caption || '');
});

bot.on('audio', async (ctx) => {
    const audio = ctx.message.audio;
    await handleMediaMessage(ctx, audio.file_id, audio.file_name || `audio_${Date.now()}.mp3`, audio.mime_type || 'audio/mpeg', ctx.message.caption || '');
});

bot.on('voice', async (ctx) => {
    await handleMediaMessage(ctx, ctx.message.voice.file_id, `voice_${Date.now()}.ogg`, ctx.message.voice.mime_type || 'audio/ogg', '');
});

bot.on('video_note', async (ctx) => {
    await handleMediaMessage(ctx, ctx.message.video_note.file_id, `video_note_${Date.now()}.mp4`, 'video/mp4', '');
});

bot.on('sticker', async (ctx) => {
    const sticker = ctx.message.sticker;
    const isAnimated = sticker.is_animated || sticker.is_video;
    const ext = isAnimated ? 'webm' : 'webp';
    const mimeType = isAnimated ? 'video/webm' : 'image/webp';
    await handleMediaMessage(ctx, sticker.file_id, `sticker_${Date.now()}.${ext}`, mimeType, sticker.emoji || '');
});

bot.on('animation', async (ctx) => {
    const anim = ctx.message.animation;
    await handleMediaMessage(ctx, anim.file_id, anim.file_name || `animation_${Date.now()}.mp4`, anim.mime_type || 'video/mp4', ctx.message.caption || '');
});
