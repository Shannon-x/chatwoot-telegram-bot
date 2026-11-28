import type { InlineKeyboardButton } from 'telegraf/types';
import { bot } from './bot-instance';
import { config } from './config';
import { saveTopic, getTopic, deleteTopic } from './database';
import { createLogger } from './logger';
import { renderContactCard } from './formatters';
import { getCustomAttributeDefinitions } from './chatwoot';
import type { ContactCardInfo, CustomAttributeDefinition } from './types';

const log = createLogger('topics');

export function buildForumInlineKeyboard(conversationId: number, accountId: number, contactId?: number) {
    // r:/o: callback_data 末尾也带 contactId（可选第 4 段），
    // 这样点击「标记已解决」/「重新打开」后重建按钮时不丢失「刷新最新资料」按钮。
    const contactSuffix = contactId ? `:${contactId}` : '';
    const rows: InlineKeyboardButton[][] = [
        [
            { text: '✅ 标记已解决', callback_data: `r:${conversationId}:${accountId}${contactSuffix}` },
            { text: '🔓 重新打开', callback_data: `o:${conversationId}:${accountId}${contactSuffix}` },
        ],
        [
            { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
        ],
    ];
    if (contactId) {
        // 末尾带 conversationId（第 4 段），刷新时才能补拉会话维度字段
        //（source_id / 渠道 / 浏览器 / IP / 发起时间…），与初始卡片对齐。
        rows.push([{ text: '🔄 刷新客户最新资料', callback_data: `c:${contactId}:${accountId}:${conversationId}` }]);
    }
    return { inline_keyboard: rows };
}

export function buildLegacyKeyboard(conversationId: number, accountId: number) {
    return {
        inline_keyboard: [
            [{ text: '✅ 标记已解决', callback_data: 'resolve' }],
            [{ text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` }],
        ],
    };
}

/**
 * 获取或新建 forum topic。
 * 新建后立即推送联系人完整卡片（如果提供了 contactInfo）。
 */
export async function getOrCreateTopic(
    conversationId: number,
    accountId: number,
    contactInfo: ContactCardInfo,
): Promise<number | undefined> {
    if (!config.telegramForumChatId) return undefined;

    const existing = getTopic(conversationId);
    if (existing) {
        log.debug('Using existing forum topic', { conversationId, topicId: existing.telegram_topic_id });
        return existing.telegram_topic_id;
    }

    try {
        const topicName = `🗨️ ${contactInfo.name} #${conversationId}`;
        const result = await bot.telegram.createForumTopic(config.telegramForumChatId, topicName);
        const topicId = result.message_thread_id;
        saveTopic(conversationId, accountId, topicId, topicName);
        log.info('Created forum topic', { topicName, topicId, conversationId });
        await sendContactCard(conversationId, accountId, topicId, contactInfo);
        return topicId;
    } catch (err) {
        log.error('Failed to create forum topic', { conversationId, error: String(err) });
        return undefined;
    }
}

/** 话题创建后发送联系人完整卡片（HTML），含中文化的自定义属性 */
async function sendContactCard(
    conversationId: number,
    accountId: number,
    topicId: number,
    contactInfo: ContactCardInfo,
) {
    if (!config.telegramForumChatId) return;
    try {
        // 如果联系人有自定义属性，预先拉取 definitions 把英文键名翻译成中文。
        // 缓存命中时几乎零耗时；缓存未命中且 API 失败时降级为键名渲染。
        let definitions: CustomAttributeDefinition[] = [];
        const hasCustomAttrs = contactInfo.customAttributes && Object.keys(contactInfo.customAttributes).length > 0;
        if (hasCustomAttrs) {
            definitions = await getCustomAttributeDefinitions('contact_attribute');
        }

        const text = renderContactCard(contactInfo, conversationId, definitions);
        await bot.telegram.sendMessage(config.telegramForumChatId, text, {
            message_thread_id: topicId,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: buildForumInlineKeyboard(conversationId, accountId, contactInfo.contactId),
        });
    } catch (err) {
        log.error('Failed to send contact card', { topicId, error: String(err) });
    }
}

export async function closeTopicForConversation(conversationId: number): Promise<boolean> {
    if (!config.telegramForumChatId) return false;
    const topic = getTopic(conversationId);
    if (!topic) return false;
    try {
        await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
        log.info('Closed forum topic', { conversationId, topicId: topic.telegram_topic_id });
        return true;
    } catch (err) {
        const error = err as { response?: { description?: string }; message?: string };
        if (error.response?.description?.includes('TOPIC_NOT_MODIFIED') || error.message?.includes('TOPIC_NOT_MODIFIED')) return true;
        log.error('Failed to close forum topic', { conversationId });
        return false;
    }
}

export async function reopenTopicForConversation(conversationId: number): Promise<boolean> {
    if (!config.telegramForumChatId) return false;
    const topic = getTopic(conversationId);
    if (!topic) return false;
    try {
        await bot.telegram.reopenForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
        log.info('Reopened forum topic', { conversationId, topicId: topic.telegram_topic_id });
        return true;
    } catch (err) {
        const error = err as { response?: { description?: string }; message?: string };
        if (error.response?.description?.includes('TOPIC_NOT_MODIFIED') || error.message?.includes('TOPIC_NOT_MODIFIED')) return true;
        log.error('Failed to reopen forum topic', { conversationId });
        return false;
    }
}

export function dropTopic(conversationId: number) {
    deleteTopic(conversationId);
}
