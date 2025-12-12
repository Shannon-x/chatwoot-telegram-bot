import { Telegraf } from 'telegraf';
import { config } from './config';
import { getMapping } from './database';
import { createMessage, toggleConversationStatus } from './chatwoot';

export const bot = new Telegraf(config.telegramToken);

bot.on('text', async (ctx) => {
    // We only care about messages from the admin
    if (ctx.from.id.toString() !== config.telegramAdminId) {
        return;
    }

    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) {
        await ctx.reply('Please reply to a customer message to send a response.');
        return;
    }

    const mapping = getMapping(replyTo.message_id);
    if (!mapping) {
        await ctx.reply('Could not find the conversation associated with this message. It might be too old or not from the bot.');
        return;
    }

    try {
        await createMessage(mapping.chatwoot_conversation_id, ctx.message.text);
        // Optionally confirm success, or stay silent to reduce noise
        // await ctx.reply('Sent!');
    } catch (error) {
        console.error('Failed to send message to Chatwoot:', error);
        await ctx.reply('Failed to send message to Chatwoot. Check logs.');
    }
});

bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data;
    // @ts-ignore
    const messageId = ctx.callbackQuery.message?.message_id;

    if (data === 'resolve' && messageId) {
        const mapping = getMapping(messageId);
        if (mapping) {
            try {
                await toggleConversationStatus(mapping.chatwoot_conversation_id, 'resolved');
                await ctx.answerCbQuery('Conversation resolved! ✅');
                // Optionally edit the message to show it's resolved
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); // Remove buttons
                await ctx.reply(`Conversation #${mapping.chatwoot_conversation_id} has been resolved.`);
            } catch (error) {
                console.error('Failed to resolve conversation:', error);
                await ctx.answerCbQuery('Failed to resolve.');
            }
        } else {
            await ctx.answerCbQuery('Expired or unknown message.');
        }
    }
});

// Launch logic will be in index.ts or separate init function
