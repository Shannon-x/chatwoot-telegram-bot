import express from 'express';
import { config } from './config';
import { bot } from './bot';
import { saveMapping } from './database';

export const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
    const event = req.body;

    // We check for message_created
    if (event.event === 'message_created') {
        const messageType = event.message_type;
        // Allow incoming (user) and outgoing (agent/bot)
        if (messageType !== 'incoming' && messageType !== 'outgoing') {
            res.sendStatus(200);
            return;
        }

        const conversationId = event.conversation.id;
        const accountId = event.account.id;
        const messageContent = event.content || '[Attachment/No Content]';
        const senderName = event.sender?.name || 'Unknown';
        const senderEmail = event.sender?.email || ''; // outgoing usually has no email or agent email

        // Distinct format for Incoming vs Outgoing
        let text = '';
        if (messageType === 'incoming') {
            text = `👤 **${senderName}** (${senderEmail})\n💬 ${messageContent}`;
        } else {
            text = `🤖 **${senderName}** (Agent/AI)\n📤 ${messageContent}`;
        }

        try {
            // Add Inline Keyboard to Resolve conversation
            const sentMessage = await bot.telegram.sendMessage(config.telegramAdminId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Resolve', callback_data: 'resolve' },
                            { text: 'View in Chatwoot', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` }
                        ]
                    ]
                }
            });

            // Save mapping so we can reply later
            saveMapping(sentMessage.message_id, conversationId, accountId, event.id);

        } catch (error) {
            console.error('Failed to send message to Telegram:', error);
        }
    }

    res.sendStatus(200);
});
