'use strict';
// Synthetic local test only: never use with real tokens or production databases.
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = process.env.LAB_BRIDGE_DIR ? path.resolve(process.env.LAB_BRIDGE_DIR) : path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(root, 'package.json'));
const { Telegraf } = localRequire('telegraf');
const telegram = new Telegraf('111111:synthetic-token', {
  telegram: { apiRoot: process.env.LAB_API_ROOT },
});
const instancePath = localRequire.resolve('./dist/bot-instance.js');
require.cache[instancePath] = { id: instancePath, filename: instancePath, loaded: true, exports: { bot: telegram } };
const db = localRequire('./dist/database.js');
db.initDb();
const chatwoot = localRequire('./dist/chatwoot.js');
const recon = localRequire('./dist/reconciliation.js');
const bridge = localRequire('./dist/server.js');
const accountId = 1, inboxId = 2;
const state = now => db.reconciliationState(now, accountId, inboxId);
state(Math.floor(Date.now() / 1000));
bridge.app.post('/_synthetic/reconcile', async (_req, res) => {
  try {
    await recon.reconcileOnce({ accountId, inboxId, state, advance: db.advanceReconciliation,
      enqueue: db.enqueueWebhook, verifyInbox: chatwoot.verifyReconciliationInbox,
      conversations: chatwoot.listChangedConversations, messages: chatwoot.listConversationMessages,
      now: Date.now });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});
bridge.app.post('/_synthetic/reply', async (req, res) => {
  try { const result = await chatwoot.createMessage(7, req.body.content); res.json({ ok: true, id: result.id }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});
bridge.app.post('/_synthetic/reply-media', async (req, res) => {
  try {
    const result = await chatwoot.createMessageWithAttachment(7, req.body.content,
      {buffer:Buffer.from('Synthetic attachment content'),filename:'synthetic.txt',mimeType:'text/plain'});
    res.json({ok:true,id:result.id});
  } catch (err) { res.status(500).json({ok:false,error:String(err)}); }
});
const server = http.createServer(bridge.app);
Promise.resolve(chatwoot.verifyBridgeUser()).then(() => {
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
}).catch(err => { console.error(String(err)); process.exit(1); });
process.on('message', async msg => {
  if (msg !== 'stop') return;
  await new Promise(resolve => server.close(resolve));
  await bridge.stopWebhookQueue();
  db.closeDb();
  process.exit(0);
});
