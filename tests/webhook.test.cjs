const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');

test('webhooks acknowledge only persisted events and suppress duplicate message IDs', async () => {
  const sent = [];
  const topicEvents = [];
  const queue = [];
  const seen = new Set();
  let nextId = 1;
  let failInsert = false;
  const logger = {debug(){}, info(){}, warn(){}, error(){}};
  const mocks = {
    './config': {config: {chatwootWebhookSecret: 'test-secret', chatwootAccountId: '1', chatwootInboxId: '2', telegramForumChatId: '-100', telegramAdminId: '99'}},
    './bot-instance': {bot: {telegram: {sendMessage: async () => { sent.push('message'); return {message_id: 1}; }}}},
    './database': {
      saveMapping(){}, getTopic: () => ({telegram_topic_id: 42}),
      enqueueWebhook(key, conversation, payload) {
        if (failInsert) throw new Error('simulated database error');
        if (seen.has(key)) return false;
        seen.add(key);
        queue.push({id: nextId++, conversation_id: conversation, payload, attempts: 0, text_sent: 0, attachment_index: 0});
        return true;
      },
      nextQueuedWebhook: () => queue[0],
      completeQueuedWebhook: id => { assert.equal(queue[0].id, id); queue.shift(); },
      markQueuedTextSent: () => {}, recordQueuedTextChunkSent: () => {}, markQueuedAttachmentSent: () => {},
      retryQueuedWebhook: () => { throw new Error('unexpected retry'); },
    },
    './chatwoot': {isSelfSentMessage: () => false, conversationMutex: {runExclusive: (_key, run) => run()}},
    './logger': {createLogger: () => logger},
    './formatters': {renderForwardedMessage: () => 'text', extractContactCard: () => ({name: 'test'}), extractSenderName: () => ({name: 'test'})},
    './attachments': {extractAttachments: event => event.attachments ?? [], sendAttachmentToTelegram: async (params) => { sent.push(params); }},
    './topics': {
      getOrCreateTopic: async () => 42, closeTopicForConversation: async () => { topicEvents.push('close'); return true; },
      reopenTopicForConversation: async () => true, dropTopic(){}, buildForumInlineKeyboard: () => ({}), buildLegacyKeyboard: () => ({}),
    },
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename?.replace(/\\/g, '/').endsWith('dist/server.js') && Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.apply(this, arguments);
  };
  let server;
  try {
    const { app } = require('../dist/server.js');
    server = http.createServer(app);
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}/webhook`;
    async function send(event, mode = 'valid') {
      const body = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signed = mode === 'invalid' ? '0'.repeat(64) : crypto.createHmac('sha256', 'test-secret').update(`${timestamp}.${body}`).digest('hex');
      const headers = {'content-type': 'application/json'};
      if (mode !== 'missing') { headers['x-chatwoot-signature'] = 'sha256=' + signed; headers['x-chatwoot-timestamp'] = timestamp; }
      const response = await fetch(endpoint, {method: 'POST', headers, body});
      await new Promise(resolve => setImmediate(resolve));
      return response.status;
    }
    const message = {event: 'message_created', id: 10, account: {id: 1}, inbox: {id: 2}, conversation: {id: 7}, message_type: 'incoming', content: 'synthetic'};
    assert.equal(await send(message, 'missing'), 401);
    assert.equal(await send(message, 'invalid'), 401);
    assert.equal(await send({...message, account: undefined}), 400);
    assert.equal(await send({...message, id: 13, private: true}), 200);
    assert.equal(sent.length, 0);
    failInsert = true;
    assert.equal(await send({...message, id: 15}), 503);
    assert.equal(sent.length, 0);
    failInsert = false;
    assert.equal(await send(message), 200);
    assert.equal(sent.length, 1);
    assert.equal(await send(message), 200);
    assert.equal(sent.length, 1);
    const file = {file_type:'file', data_url:'https://chat.example.test/rails/active_storage/blobs/signed/file.pdf'};
    assert.equal(await send({...message, id:14, attachments:[file]}), 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[2].att, file);
    assert.equal(sent[2].messageThreadId, 42);
    const status = {event: 'conversation_status_changed', id: 7, account: {id: 1}, inbox_id: 2, status: 'resolved'};
    assert.equal(await send(status), 200);
    assert.deepEqual(topicEvents, ['close']);
  } finally {
    Module._load = originalLoad;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  }
});
