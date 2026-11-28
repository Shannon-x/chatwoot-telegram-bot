const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

test('committed queue survives restart, deduplicates and preserves each conversation order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatwoot-queue-'));
  const dbPath = path.join(dir, 'mappings.db');
  const dbModule = require.resolve('../dist/database.js');
  const orig = Module._load;
  const logger = {debug(){}, info(){}, warn(){}, error(){}};
  Module._load = function(request, parent) {
    if (parent?.filename?.replace(/\\/g, '/').endsWith('/dist/database.js')) {
      if (request === './config') return {config: {dbPath}};
      if (request === './logger') return {createLogger: () => logger};
    }
    return orig.apply(this, arguments);
  };
  let store;
  try {
    store = require(dbModule);
    store.initDb();
    const message = JSON.stringify({event:'message_created', content:'synthetic'});
    assert.equal(store.enqueueWebhook('message:1:10', 7, message), true);
    assert.equal(store.enqueueWebhook('message:1:10', 7, message), false);
    assert.equal(store.enqueueWebhook('delivery:status-1', 7, '{"status":"resolved"}'), true);
    assert.equal(store.enqueueWebhook('message:1:11', 8, message), true);
    const first = store.nextQueuedWebhook();
    assert.equal(first.conversation_id, 7);
    const inspect = new Database(dbPath);
    inspect.exec(`CREATE TRIGGER fail_progress BEFORE UPDATE OF text_chunk_index ON webhook_queue BEGIN SELECT RAISE(ABORT, 'test'); END`);
    assert.throws(() => store.recordQueuedTextChunkSent(first.id, 1, 99, 7, 1, 10));
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM messages WHERE telegram_message_id = 99').get().count, 0);
    inspect.exec('DROP TRIGGER fail_progress');
    store.recordQueuedTextChunkSent(first.id, 1, 99, 7, 1, 10);
    assert.equal(inspect.prepare('SELECT chatwoot_message_id FROM messages WHERE telegram_message_id = 99').get().chatwoot_message_id, 10);
    inspect.close();
    store.markQueuedTextSent(first.id);
    store.markQueuedTextChunkSent(first.id, 3);
    store.markQueuedAttachmentSent(first.id, 2);
    store.retryQueuedWebhook(first.id, first.attempts);
    assert.deepEqual(store.webhookQueueHealth(), {pending:3, failed:1});
    // A failed conversation cannot block unrelated conversations or be overtaken by its own later status.
    const unrelated = store.nextQueuedWebhook();
    assert.equal(unrelated.conversation_id, 8);
    store.completeQueuedWebhook(unrelated.id);
    store.closeDb();
    delete require.cache[dbModule];
    store = require(dbModule);
    store.initDb();
    const recovered = store.nextQueuedWebhook(Date.now() + 60_000);
    assert.equal(recovered.id, first.id);
    assert.equal(recovered.payload, message);
    assert.equal(recovered.text_sent, 1);
    assert.equal(recovered.text_chunk_index, 3);
    assert.equal(recovered.attachment_index, 2);
    store.completeQueuedWebhook(recovered.id);
    assert.deepEqual(store.webhookQueueHealth(), {pending:1, failed:0});
    assert.equal(store.nextQueuedWebhook(Date.now() + 60_000).conversation_id, 7);
    assert.equal(store.enqueueWebhook('message:1:10', 7, message), false);
    store.closeDb();
    store = null;
    const readOnly = new Database(dbPath, {readonly: true});
    assert.equal(readOnly.prepare('SELECT payload FROM webhook_queue WHERE event_key = ?').get('message:1:10').payload, null);
    readOnly.close();
  } finally {
    try { store?.closeDb(); } finally {
      Module._load = orig;
      delete require.cache[dbModule];
      fs.rmSync(dir, {recursive:true, force:true});
    }
  }
});
