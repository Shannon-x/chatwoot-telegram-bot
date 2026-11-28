import type { Context } from 'telegraf';
import type { CallbackQuery, Message } from 'telegraf/types';
import { config } from './config';
import { createLogger, extractAxiosError } from './logger';
import { bot } from './bot-instance';
import { getMapping, getTopic } from './database';
import {
    toggleConversationStatus,
    createMessage,
    UnknownChatwootSend,
    toggleTypingStatus,
    getCannedResponses,
    getContact,
    getConversation,
    getCustomAttributeDefinitions,
} from './chatwoot';
import { buildForumInlineKeyboard, reopenTopicForConversation } from './topics';
import { renderContactCard, renderContactDetailMessage, buildContactCardFromApi } from './formatters';

const log = createLogger('callback');

/**
 * Callback 路由：handler 按前缀精确匹配，没有前缀的（如 'resolve' / 'noop'）单独走完整匹配。
 */
type CallbackContext = Context & { callbackQuery: CallbackQuery.DataQuery };
type Handler = (ctx: CallbackContext, parts: string[]) => Promise<void>;

interface Route {
    prefix: string;
    exact?: boolean;
    handler: Handler;
}

const routes: Route[] = [];

function addRoute(prefix: string, handler: Handler, opts?: { exact?: boolean }) {
    routes.push({ prefix, handler, exact: opts?.exact });
}

export async function dispatchCallback(ctx: Context): Promise<void> {
    const cbQuery = ctx.callbackQuery as CallbackQuery.DataQuery | undefined;
    if (!cbQuery?.data) return;
    const data = cbQuery.data;

    for (const route of routes) {
        const matched = route.exact ? data === route.prefix : data.startsWith(route.prefix);
        if (!matched) continue;
        try {
            await route.handler(ctx as CallbackContext, data.split(':'));
        } catch (err) {
            log.error('Callback handler threw', { data, error: String(err) });
            try { await ctx.answerCbQuery('❌ 处理失败'); } catch { /* ignore */ }
        }
        return;
    }
    log.debug('Unhandled callback data', { data });
}

// ============ Routes ============

// Canned response: send selected response to conversation. format: "canned:<id>:<conversationId>"
addRoute('canned:', async (ctx, parts) => {
    const responseId = parseInt(parts[1], 10);
    const conversationId = parseInt(parts[2], 10);
    if (!responseId || !conversationId) {
        await ctx.answerCbQuery('参数错误');
        return;
    }
    try {
        const responses = await getCannedResponses();
        const selected = responses.find((r) => r.id === responseId);
        if (!selected) {
            await ctx.answerCbQuery('预设回复已不存在');
            return;
        }
        void toggleTypingStatus(conversationId, 'on');
        await createMessage(conversationId, selected.content, {chatId: String(ctx.chat?.id ?? 'callback'), eventId: `callback:${ctx.callbackQuery.id}`});
        await ctx.answerCbQuery(`✅ 已发送: ${selected.short_code}`);
        try {
            const truncated = selected.content.substring(0, 200) + (selected.content.length > 200 ? '...' : '');
            await ctx.editMessageText(`✅ 已发送预设回复 <b>${escapeHtml(selected.short_code)}</b>\n\n<blockquote>${escapeHtml(truncated)}</blockquote>`, {
                parse_mode: 'HTML',
            });
        } catch { /* may be too old */ }
    } catch (err) {
        log.error('Failed to send canned response', { responseId, conversationId, ...extractAxiosError(err) });
        await ctx.answerCbQuery(err instanceof UnknownChatwootSend ? '⚠️ 发送结果未知，请先检查对话' : '❌ 发送失败，请检查对话');
    }
});

// Canned pagination. format: "canned_page:<page>:<conversationId>"
addRoute('canned_page:', async (ctx, parts) => {
    const page = parseInt(parts[1], 10);
    const conversationId = parseInt(parts[2], 10);
    try {
        const responses = await getCannedResponses();
        const { buildCannedKeyboard } = await import('./canned');
        const keyboard = buildCannedKeyboard(responses, page, conversationId);
        const text = `📋 <b>预设回复</b>（共 ${responses.length} 条）\n选择要发送的回复：`;
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        await ctx.answerCbQuery();
    } catch (err) {
        log.error('Failed to paginate canned responses', extractAxiosError(err));
        await ctx.answerCbQuery('加载失败');
    }
});

// Close canned response menu
addRoute('canned_close', async (ctx) => {
    try { await ctx.deleteMessage(); }
    catch { try { await ctx.editMessageText('已关闭'); } catch { /* ignore */ } }
    await ctx.answerCbQuery();
}, { exact: true });

// Noop (page indicator button)
addRoute('noop', async (ctx) => {
    await ctx.answerCbQuery();
}, { exact: true });

// Forum mode: resolve conversation. format: "r:<conversationId>:<accountId>"
addRoute('r:', async (ctx, parts) => {
    await handleStatusToggle(ctx, parts, 'resolved');
});

// Forum mode: reopen conversation. format: "o:<conversationId>:<accountId>"
addRoute('o:', async (ctx, parts) => {
    await handleStatusToggle(ctx, parts, 'open');
});

// Contact detail: fetch contact (+ conversation) + custom attribute definitions, post a detail message.
// format: "c:<contactId>:<accountId>:<conversationId?>"
//   带 conversationId 时同时拉会话，补齐 source_id / 渠道 / 浏览器 / IP / 发起时间等会话维度字段；
//   不带（旧按钮）时降级为仅联系人维度的详情视图。
addRoute('c:', async (ctx, parts) => {
    const contactId = parseInt(parts[1], 10);
    const conversationId = parts[3] ? parseInt(parts[3], 10) : undefined;
    if (!contactId) {
        await ctx.answerCbQuery('参数错误');
        return;
    }

    try {
        await ctx.answerCbQuery('正在获取联系人详细资料...');
        // 并发拉取联系人 + 自定义属性定义 +（若按钮带了 conversationId）当前会话
        const [contact, definitions, conversation] = await Promise.all([
            getContact(contactId),
            getCustomAttributeDefinitions('contact_attribute'),
            conversationId
                ? getConversation(conversationId).catch((err) => {
                      log.warn('Failed to fetch conversation for refresh, falling back to contact-only view', {
                          conversationId,
                          ...extractAxiosError(err),
                      });
                      return undefined;
                  })
                : Promise.resolve(undefined),
        ]);

        // 有会话信息 → 渲染与初始卡片字段一致的完整视图（去掉「点击下方按钮」footer，刷新回复本身没有按钮）。
        // 否则降级为仅联系人维度的详情视图。
        const text =
            conversation && conversationId
                ? renderContactCard(buildContactCardFromApi(conversation, contact), conversationId, definitions, { footer: false })
                : renderContactDetailMessage(contact, definitions);

        const messageThreadId = (ctx.callbackQuery.message as Message & { message_thread_id?: number })?.message_thread_id;
        await ctx.reply(text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
    } catch (err) {
        log.error('Failed to fetch contact detail', { contactId, conversationId, ...extractAxiosError(err) });
        try { await ctx.answerCbQuery('❌ 获取联系人详细资料失败'); } catch { /* already answered */ }
    }
});

// Forum mode: close topic. format: "close_topic:<conversationId>"
addRoute('close_topic:', async (ctx, parts) => {
    const conversationId = parseInt(parts[1], 10);
    const topic = getTopic(conversationId);
    if (topic && config.telegramForumChatId) {
        try {
            await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
            await ctx.answerCbQuery('话题已关闭！🔒');
            log.info('Manually closed topic', { conversationId, topicName: topic.topic_name });
        } catch (err) {
            log.error('Failed to close topic', { conversationId, error: String(err) });
            await ctx.answerCbQuery('关闭话题失败。');
        }
    } else {
        await ctx.answerCbQuery('找不到对应的话题。');
    }
});

// Legacy single-chat: resolve (no params). Uses message_id to find the mapping.
addRoute('resolve', async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    const mapping = getMapping(messageId);
    if (!mapping) {
        await ctx.answerCbQuery('消息已过期或未知。');
        return;
    }
    try {
        await toggleConversationStatus(mapping.chatwoot_conversation_id, 'resolved');
        await ctx.answerCbQuery('会话已解决！✅');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply(`会话 #${mapping.chatwoot_conversation_id} 已标记为已解决。`);
    } catch (err) {
        log.error('Failed to resolve conversation', extractAxiosError(err));
        await ctx.answerCbQuery('解决失败。');
    }
}, { exact: true });

// ============ Shared logic ============

async function handleStatusToggle(ctx: CallbackContext, parts: string[], target: 'resolved' | 'open') {
    const conversationId = parseInt(parts[1], 10);
    const accountId = parseInt(parts[2], 10);
    // 兼容旧 callback_data（只有 3 段）：parts[3] 不存在时 contactId 为 undefined
    const contactId = parts[3] ? parseInt(parts[3], 10) : undefined;
    if (!conversationId) return;

    try {
        await toggleConversationStatus(conversationId, target);
        await ctx.answerCbQuery(target === 'resolved' ? '✅ 会话已标记为已解决，话题将自动关闭！' : '🔓 对话已重新打开！');

        if (target === 'open') {
            await reopenTopicForConversation(conversationId);
        }

        const messageText = (ctx.callbackQuery.message as Message.TextMessage | undefined)?.text || '';
        // 去掉历史 status 注脚再拼上新状态。卡片用 HTML 时此处也通用（仅替换文本，不破坏标签）。
        const cleanText = messageText.replace(/\n\n[✅🔓] 状态：(已解决|进行中)$/u, '');
        const statusLine = target === 'resolved' ? '✅ 状态：已解决' : '🔓 状态：进行中';
        const updatedText = `${cleanText}\n\n${statusLine}`;

        try {
            await ctx.editMessageText(updatedText, {
                parse_mode: 'HTML',
                reply_markup: buildForumInlineKeyboard(conversationId, accountId, contactId),
                link_preview_options: { is_disabled: true },
            });
        } catch {
            log.debug('Failed to update control panel (content may be identical)');
        }
    } catch (err) {
        log.error(`Failed to ${target === 'resolved' ? 'resolve' : 'reopen'} conversation`, { conversationId, ...extractAxiosError(err) });
        await ctx.answerCbQuery('❌ 操作失败，请重试');
    }
}

// HTML escape — kept local to avoid importing formatters for the test boundary.
function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
