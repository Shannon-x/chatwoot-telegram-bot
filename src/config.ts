import dotenv from 'dotenv';
import { createLogger } from './logger';

dotenv.config();

const log = createLogger('config');

/** 解析布尔型环境变量，未设置或非真值返回 false */
function envBool(name: string, defaultValue = false): boolean {
    const v = process.env[name];
    if (v == null) return defaultValue;
    return /^(1|true|yes|on)$/i.test(v.trim());
}

export const config = {
    port: process.env.PORT || 3000,
    telegramToken: process.env.TELEGRAM_TOKEN || '',
    telegramAdminId: process.env.TELEGRAM_ADMIN_ID || '',
    telegramForumChatId: process.env.TELEGRAM_FORUM_CHAT_ID || '',
    /** 启动时是否丢弃堆积的 Telegram 更新。默认 false，避免重启窗口期回复丢失。 */
    telegramDropPendingUpdates: envBool('TELEGRAM_DROP_PENDING_UPDATES', false),
    chatwootAccessToken: process.env.CHATWOOT_ACCESS_TOKEN || '',
    chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com').replace(/\/+$/, ''),
    chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '',
    chatwootBridgeUserId: process.env.CHATWOOT_BRIDGE_USER_ID || '',
    // Optional; when configured, reconcile incoming messages from this inbox.
    reconciliationInboxId: process.env.RECONCILIATION_INBOX_ID || '',
    chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET || '',
    attachmentDownloadOrigins: (process.env.ATTACHMENT_DOWNLOAD_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    dbPath: process.env.DB_PATH || 'mappings.db',
};

const required: Array<[string, string]> = [
    ['TELEGRAM_TOKEN', config.telegramToken],
    ['TELEGRAM_ADMIN_ID', config.telegramAdminId],
    ['CHATWOOT_ACCESS_TOKEN', config.chatwootAccessToken],
    ['CHATWOOT_ACCOUNT_ID', config.chatwootAccountId],
];

const missing = required.filter(([, v]) => !v).map(([k]) => k);
if (config.chatwootBridgeUserId && (!/^[1-9]\d*$/.test(config.chatwootBridgeUserId) || !config.chatwootWebhookSecret)) {
    throw new Error('CHATWOOT_BRIDGE_USER_ID requires a positive ID and CHATWOOT_WEBHOOK_SECRET');
}
if (config.reconciliationInboxId && !config.chatwootBridgeUserId) {
    throw new Error('Recovery requires CHATWOOT_BRIDGE_USER_ID for the dedicated bridge user');
}
if (missing.length > 0) {
    log.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

if (!config.chatwootWebhookSecret) {
    log.warn('CHATWOOT_WEBHOOK_SECRET is not set — webhook signature verification is disabled');
}
