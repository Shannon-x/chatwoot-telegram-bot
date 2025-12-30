import { app } from './server';
import { bot } from './bot';
import { config } from './config';
import { initDb as initDatabase } from './database';

const PORT = config.port;

async function start() {
    // Initialize Database
    initDatabase();
    console.log('Database initialized.');

    // Start Telegram Bot
    console.log('Starting Telegram bot...');
    bot.launch({
        dropPendingUpdates: true,  // 忽略启动前的旧消息
    }).then(() => {
        console.log('✅ Telegram bot started successfully (polling mode).');
    }).catch((err) => {
        console.error('❌ Failed to start Telegram bot:', err);
    });

    // Start Express Server
    app.listen(PORT, () => {
        console.log(`Webhook server running on port ${PORT}`);
    });

    // Graceful stop
    process.once('SIGINT', () => {
        bot.stop('SIGINT');
        process.exit(0);
    });
    process.once('SIGTERM', () => {
        bot.stop('SIGTERM');
        process.exit(0);
    });
}

start();
