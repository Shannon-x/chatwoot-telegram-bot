import http from 'http';
import { app, stopWebhookQueue } from './server';
import { bot } from './bot';
import './bot'; // 确保 bot handlers 注册（callback router 在 import 时挂载）
import { config } from './config';
import { initDb as initDatabase, closeDb, reconciliationState, advanceReconciliation, enqueueWebhook } from './database';
import { verifyReconciliationInbox, listChangedConversations, listConversationMessages } from './chatwoot';
import { reconcileOnce, startReconciliationPass, finishReconciliationPass } from './reconciliation';
import { createLogger, closeLogger } from './logger';

const log = createLogger('main');
const PORT = config.port;

async function start() {
    initDatabase();
    log.info('Database initialized');

    // Recovery is opt-in and requires an explicit first activation boundary.
    let reconciling = false;
    let stoppingReconciliation = false;
    let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
    if (config.reconciliationInboxId) {
        if (!/^[1-9]\d*$/.test(config.reconciliationInboxId)) throw new Error('Invalid reconciliation inbox');
        const accountId = Number(config.chatwootAccountId);
        const inboxId = Number(config.reconciliationInboxId);
        const state = (now: number) => reconciliationState(now, accountId, inboxId);
        state(Math.floor(Date.now() / 1000));
        const reconcile = async () => {
            if (reconciling || stoppingReconciliation) return;
            reconciling = true;
            startReconciliationPass();
            try {
                await reconcileOnce({
                    accountId, inboxId,
                    state, advance: advanceReconciliation, enqueue: enqueueWebhook,
                    verifyInbox: verifyReconciliationInbox, conversations: listChangedConversations,
                    messages: listConversationMessages, now: Date.now,
                });
                finishReconciliationPass(true);
            } catch {
                finishReconciliationPass(false);
                log.error('Chatwoot reconciliation failed; checkpoint preserved');
            } finally { reconciling = false; }
        };
        void reconcile();
        reconciliationTimer = setInterval(() => { void reconcile(); }, 30_000);
        reconciliationTimer.unref();
    }

    // 在 launch 之前先验证 token：bot.launch() 在 polling 模式下永远不 resolve，
    // 错误只会通过抛出方式向上传播（不会触发 .catch 链）。
    let botInfo: { username: string; id: number };
    try {
        const me = await bot.telegram.getMe();
        botInfo = { username: me.username, id: me.id };
        log.info('Telegram bot identified', botInfo);
    } catch (err) {
        log.error('Failed to identify Telegram bot (token invalid?)', { error: String(err) });
        process.exit(1);
    }

    log.info('Starting Telegram bot...', {
        dropPendingUpdates: config.telegramDropPendingUpdates,
    });
    // launch() 在 polling 模式下持续运行，不应 await
    bot.launch({ dropPendingUpdates: config.telegramDropPendingUpdates }).catch((err) => {
        log.error('Bot polling crashed', { error: String(err) });
        process.exit(1);
    });

    const server = http.createServer(app);
    server.listen(PORT, () => {
        log.info(`Webhook server running on port ${PORT}`);
    });

    const SHUTDOWN_TIMEOUT_MS = 10_000;
    let shuttingDown = false;

    async function gracefulShutdown(signal: string) {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`Received ${signal}, shutting down gracefully...`);

        const forceExit = setTimeout(() => {
            log.warn('Graceful shutdown timed out, forcing exit');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        forceExit.unref();

        stoppingReconciliation = true;
        if (reconciliationTimer) clearInterval(reconciliationTimer);

        bot.stop(signal);

        await new Promise<void>((resolve) => {
            server.close(() => {
                log.info('HTTP server closed');
                resolve();
            });
        });

        while (reconciling) await new Promise(resolve => setTimeout(resolve, 50));
        await stopWebhookQueue();
        closeDb();
        await closeLogger();
        process.exit(0);
    }

    process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
    process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
}

start().catch((err) => {
    log.error('Fatal error during startup', { error: String(err) });
    process.exit(1);
});
