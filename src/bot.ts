import { Telegraf } from 'telegraf';
import { config } from './config';
import { getMapping, getTopic, getTopicByTopicId, deleteTopic } from './database';
import { createMessage, createMessageWithAttachment, toggleConversationStatus } from './chatwoot';

export const bot = new Telegraf(config.telegramToken);

// ============ 文本消息处理（回复客户） ============

bot.on('text', async (ctx) => {
    const fromId = ctx.from.id.toString();
    const messageText = ctx.message.text;

    // Forum 模式：检查是否来自 Forum 群组
    const isFromForum = config.telegramForumChatId && ctx.chat.id.toString() === config.telegramForumChatId;

    // 原有模式：仅限 Admin
    if (!isFromForum && fromId !== config.telegramAdminId) {
        return;
    }

    // Forum 模式：在话题中的消息转发到 Chatwoot
    if (isFromForum) {
        const threadId = ctx.message.message_thread_id;
        if (threadId) {
            const topicMapping = getTopicByTopicId(threadId);
            if (topicMapping) {
                // 普通消息：发送到 Chatwoot
                try {
                    await createMessage(topicMapping.chatwoot_conversation_id, messageText);
                    // 静默成功，减少噪音
                } catch (error) {
                    console.error('Failed to send message to Chatwoot:', error);
                    await ctx.reply('发送消息到 Chatwoot 失败，请检查日志。');
                }
                return;
            }
        }
        // 非话题消息（如一般消息区），忽略
        return;
    }

    // 原有模式：必须回复消息
    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) {
        await ctx.reply('请回复客户消息来发送回复。');
        return;
    }

    const mapping = getMapping(replyTo.message_id);
    if (!mapping) {
        await ctx.reply('找不到与此消息关联的会话。可能已过期或不是来自机器人。');
        return;
    }

    try {
        await createMessage(mapping.chatwoot_conversation_id, messageText);
        // 静默成功
    } catch (error) {
        console.error('Failed to send message to Chatwoot:', error);
        await ctx.reply('发送消息到 Chatwoot 失败，请检查日志。');
    }
});

// ============ 按钮回调处理 ============

bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data as string;
    // @ts-ignore
    const messageId = ctx.callbackQuery.message?.message_id;

    if (!data) return;

    // Forum 模式：resolve:conversationId:accountId
    if (data.startsWith('resolve:')) {
        const parts = data.split(':');
        const conversationId = parseInt(parts[1], 10);
        const accountId = parseInt(parts[2], 10);

        if (conversationId) {
            try {
                await toggleConversationStatus(conversationId, 'resolved');
                await ctx.answerCbQuery('✅ 会话已标记为已解决，话题将自动关闭！');

                // 更新控制面板，显示已解决状态（保留按钮以便重新打开）
                // @ts-ignore
                const messageText = ctx.callbackQuery.message?.text || '';
                // 移除之前可能存在的状态后缀，然后添加新状态
                const cleanText = messageText.replace(/\n\n[✅🔓] \*\*状态：.*\*\*$/, '');
                const updatedText = cleanText + '\n\n✅ **状态：已解决**';

                try {
                    await ctx.editMessageText(updatedText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ 标记已解决', callback_data: `resolve:${conversationId}:${accountId}` },
                                    { text: '🔓 重新打开', callback_data: `reopen:${conversationId}:${accountId}` },
                                ],
                                [
                                    { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
                                ],
                            ],
                        },
                    });
                } catch (err) {
                    // 如果编辑失败（消息内容相同），忽略错误
                    console.debug('控制面板更新失败（可能内容相同）');
                }

                // 话题关闭由 webhook 的 conversation_status_changed 事件处理
            } catch (error) {
                console.error('Failed to resolve conversation:', error);
                await ctx.answerCbQuery('❌ 操作失败，请重试');
            }
        }
        return;
    }

    // Forum 模式：reopen:conversationId:accountId - 重新打开对话
    if (data.startsWith('reopen:')) {
        const parts = data.split(':');
        const conversationId = parseInt(parts[1], 10);
        const accountId = parseInt(parts[2], 10);

        if (conversationId) {
            try {
                await toggleConversationStatus(conversationId, 'open');
                await ctx.answerCbQuery('🔓 对话已重新打开！');

                // 重新打开 Forum Topic（如果已关闭）
                const topic = getTopic(conversationId);
                if (topic && config.telegramForumChatId) {
                    try {
                        await bot.telegram.reopenForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
                        console.log(`重新打开话题 (topic_id: ${topic.telegram_topic_id})`);
                    } catch (err) {
                        // 话题可能本来就是打开的，忽略错误
                        console.debug('重新打开话题失败（可能已经是打开状态）:', err);
                    }
                }

                // 更新控制面板，显示打开状态
                // @ts-ignore
                const messageText = ctx.callbackQuery.message?.text || '';
                const updatedText = messageText.replace(/\n\n✅ \*\*状态：已解决\*\*$/, '') + '\n\n🔓 **状态：进行中**';

                try {
                    await ctx.editMessageText(updatedText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ 标记已解决', callback_data: `resolve:${conversationId}:${accountId}` },
                                    { text: '🔓 重新打开', callback_data: `reopen:${conversationId}:${accountId}` },
                                ],
                                [
                                    { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
                                ],
                            ],
                        },
                    });
                } catch (err) {
                    console.debug('控制面板更新失败（可能内容相同）');
                }
            } catch (error) {
                console.error('Failed to reopen conversation:', error);
                await ctx.answerCbQuery('❌ 操作失败，请重试');
            }
        }
        return;
    }

    // Forum 模式：close_topic:conversationId
    if (data.startsWith('close_topic:')) {
        const conversationId = parseInt(data.split(':')[1], 10);
        const topic = getTopic(conversationId);

        if (topic && config.telegramForumChatId) {
            try {
                await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
                await ctx.answerCbQuery('话题已关闭！🔒');
                console.log(`手动关闭话题: ${topic.topic_name}`);
            } catch (error) {
                console.error('Failed to close topic:', error);
                await ctx.answerCbQuery('关闭话题失败。');
            }
        } else {
            await ctx.answerCbQuery('找不到对应的话题。');
        }
        return;
    }

    // 原有模式：resolve（无参数）
    if (data === 'resolve' && messageId) {
        const mapping = getMapping(messageId);
        if (mapping) {
            try {
                await toggleConversationStatus(mapping.chatwoot_conversation_id, 'resolved');
                await ctx.answerCbQuery('会话已解决！✅');
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
                await ctx.reply(`会话 #${mapping.chatwoot_conversation_id} 已标记为已解决。`);
            } catch (error) {
                console.error('Failed to resolve conversation:', error);
                await ctx.answerCbQuery('解决失败。');
            }
        } else {
            await ctx.answerCbQuery('消息已过期或未知。');
        }
        return;
    }
});

// ============ 媒体消息处理（图片、文件、视频、音频等） ============

/**
 * 下载 Telegram 文件并返回 Buffer
 */
async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
    const file = await bot.telegram.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) {
        throw new Error('无法获取文件路径');
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
        throw new Error(`下载文件失败: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), filePath };
}

/**
 * 获取对话 ID（根据 Forum 模式或原有模式）
 */
function getConversationId(ctx: any): number | null {
    const fromId = ctx.from.id.toString();
    const isFromForum = config.telegramForumChatId && ctx.chat.id.toString() === config.telegramForumChatId;

    if (isFromForum) {
        const threadId = ctx.message?.message_thread_id;
        if (threadId) {
            const topicMapping = getTopicByTopicId(threadId);
            if (topicMapping) {
                return topicMapping.chatwoot_conversation_id;
            }
        }
        return null;
    }

    // 原有模式：仅限 Admin，必须回复消息
    if (fromId !== config.telegramAdminId) {
        return null;
    }

    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
        return null;
    }

    const mapping = getMapping(replyTo.message_id);
    return mapping ? mapping.chatwoot_conversation_id : null;
}

/**
 * 处理媒体消息的通用函数
 */
async function handleMediaMessage(
    ctx: any,
    fileId: string,
    filename: string,
    mimeType: string | undefined,
    caption?: string
) {
    const conversationId = getConversationId(ctx);
    
    if (!conversationId) {
        // Forum 模式下静默忽略，原有模式下提示
        const fromId = ctx.from.id.toString();
        const isFromForum = config.telegramForumChatId && ctx.chat.id.toString() === config.telegramForumChatId;
        if (!isFromForum && fromId === config.telegramAdminId && !ctx.message?.reply_to_message) {
            await ctx.reply('请回复客户消息来发送附件。');
        }
        return;
    }

    try {
        const { buffer, filePath } = await downloadTelegramFile(fileId);
        
        // 如果没有指定文件名，从路径中提取
        const finalFilename = filename || filePath.split('/').pop() || `file_${Date.now()}`;
        
        await createMessageWithAttachment(conversationId, caption || '', {
            buffer,
            filename: finalFilename,
            mimeType,
        });
        
        console.log(`附件已发送到 Chatwoot (conversation: ${conversationId}, file: ${finalFilename})`);
    } catch (error) {
        console.error('Failed to send attachment to Chatwoot:', error);
        await ctx.reply('发送附件到 Chatwoot 失败，请检查日志。');
    }
}

// 处理图片消息
// @ts-ignore - Telegraf types
bot.on('photo', async (ctx) => {
    // 获取最高分辨率的图片
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const caption = ctx.message.caption || '';
    
    await handleMediaMessage(
        ctx,
        photo.file_id,
        `photo_${Date.now()}.jpg`,
        'image/jpeg',
        caption
    );
});

// 处理文档/文件消息
// @ts-ignore - Telegraf types
bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || '';
    
    await handleMediaMessage(
        ctx,
        doc.file_id,
        doc.file_name || `document_${Date.now()}`,
        doc.mime_type,
        caption
    );
});

// 处理视频消息
// @ts-ignore - Telegraf types
bot.on('video', async (ctx) => {
    const video = ctx.message.video;
    const caption = ctx.message.caption || '';
    
    await handleMediaMessage(
        ctx,
        video.file_id,
        video.file_name || `video_${Date.now()}.mp4`,
        video.mime_type || 'video/mp4',
        caption
    );
});

// 处理音频消息
// @ts-ignore - Telegraf types
bot.on('audio', async (ctx) => {
    const audio = ctx.message.audio;
    const caption = ctx.message.caption || '';
    
    await handleMediaMessage(
        ctx,
        audio.file_id,
        audio.file_name || `audio_${Date.now()}.mp3`,
        audio.mime_type || 'audio/mpeg',
        caption
    );
});

// 处理语音消息
// @ts-ignore - Telegraf types
bot.on('voice', async (ctx) => {
    const voice = ctx.message.voice;
    
    await handleMediaMessage(
        ctx,
        voice.file_id,
        `voice_${Date.now()}.ogg`,
        voice.mime_type || 'audio/ogg',
        ''
    );
});

// 处理视频笔记（圆形视频）
// @ts-ignore - Telegraf types
bot.on('video_note', async (ctx) => {
    const videoNote = ctx.message.video_note;
    
    await handleMediaMessage(
        ctx,
        videoNote.file_id,
        `video_note_${Date.now()}.mp4`,
        'video/mp4',
        ''
    );
});

// 处理贴纸消息
// @ts-ignore - Telegraf types
bot.on('sticker', async (ctx) => {
    const sticker = ctx.message.sticker;
    
    // 对于动画贴纸使用 webm，静态贴纸使用 webp
    const isAnimated = sticker.is_animated || sticker.is_video;
    const ext = isAnimated ? 'webm' : 'webp';
    const mimeType = isAnimated ? 'video/webm' : 'image/webp';
    
    await handleMediaMessage(
        ctx,
        sticker.file_id,
        `sticker_${Date.now()}.${ext}`,
        mimeType,
        sticker.emoji || ''
    );
});

// 处理动画/GIF消息
// @ts-ignore - Telegraf types
bot.on('animation', async (ctx) => {
    const animation = ctx.message.animation;
    const caption = ctx.message.caption || '';
    
    await handleMediaMessage(
        ctx,
        animation.file_id,
        animation.file_name || `animation_${Date.now()}.mp4`,
        animation.mime_type || 'video/mp4',
        caption
    );
});

// Launch logic will be in index.ts or separate init function

