#!/usr/bin/env node
// Run only with the bridge stopped. Never exposes a network control endpoint.
const Database = require('better-sqlite3');
const fs = require('node:fs');
const {acquireOwnership} = require('../dist/ownership-lock.js');
const [file, command, rawId, action, rawRemoteId] = process.argv.slice(2);
const positive = v => /^\d+$/.test(v || '') && Number.isSafeInteger(Number(v)) && Number(v) > 0;
if (!file || !fs.existsSync(file) || !['list','queue','outgoing'].includes(command)) throw Error('Usage: resolve-recovery <existing-db> list | queue <id> retry|delivered [telegram-id] | outgoing <id> delivered|not-delivered');
const releaseOwnership = acquireOwnership(file);
const db = new Database(file, {fileMustExist:true});
try {
  if (command === 'list') {
    const queue = db.prepare(`SELECT id, conversation_id, inflight FROM webhook_queue WHERE state='pending' AND inflight IS NOT NULL ORDER BY id`).all();
    const outgoing = db.prepare(`SELECT rowid AS id, account_id, conversation_id, telegram_chat_id, telegram_message_id FROM bridge_outgoing_sources WHERE status='pending' ORDER BY rowid`).all();
    console.log(JSON.stringify({queue, outgoing}));
  } else {
    if (!positive(rawId)) throw Error('Invalid record id');
    const id=Number(rawId);
    db.transaction(() => {
      if (command === 'outgoing') {
        if (!['delivered','not-delivered'].includes(action)) throw Error('Invalid action');
        const r=db.prepare(`UPDATE bridge_outgoing_sources SET status=? WHERE rowid=? AND status='pending'`).run(action==='delivered'?'confirmed':'rejected',id);
        if (r.changes!==1) throw Error('No pending outgoing item');
        return;
      }
      const item=db.prepare(`SELECT conversation_id,payload,inflight FROM webhook_queue WHERE id=? AND state='pending' AND inflight IS NOT NULL`).get(id);
      if (!item) throw Error('No ambiguous queue item');
      if (action==='retry') {
        db.prepare(`UPDATE webhook_queue SET inflight=NULL,next_attempt_at=0 WHERE id=?`).run(id);
        return;
      }
      if (action!=='delivered' || !positive(rawRemoteId)) throw Error('Delivered needs a verified Telegram message or topic ID');
      const remoteId=Number(rawRemoteId), event=JSON.parse(item.payload);
      const account=event?.account?.id, message=event?.id;
      if (!Number.isSafeInteger(account)||account<=0) throw Error('Invalid event account');
      if (item.inflight==='topic') {
        if (db.prepare('SELECT 1 FROM topics WHERE chatwoot_conversation_id=?').get(item.conversation_id)) throw Error('Topic mapping already exists');
        db.prepare('INSERT INTO topics(chatwoot_conversation_id,chatwoot_account_id,telegram_topic_id,topic_name) VALUES(?,?,?,?)')
          .run(item.conversation_id,account,remoteId,`#${item.conversation_id}`);
      } else {
        if (!Number.isSafeInteger(message)||message<=0) throw Error('Invalid event message');
        const match=/^(text|attachment):(\d+)$/.exec(item.inflight);
        if (!match || !Number.isSafeInteger(Number(match[2]))) throw Error('Invalid queued step');
        const column=match[1]==='text'?'text_chunk_index':'attachment_index';
        db.prepare('INSERT OR REPLACE INTO messages(telegram_message_id,chatwoot_conversation_id,chatwoot_account_id,chatwoot_message_id) VALUES(?,?,?,?)')
          .run(remoteId,item.conversation_id,account,message);
        db.prepare(`UPDATE webhook_queue SET ${column}=? WHERE id=?`).run(Number(match[2])+1,id);
      }
      db.prepare(`UPDATE webhook_queue SET inflight=NULL,next_attempt_at=0 WHERE id=?`).run(id);
    })();
    console.log('Resolution recorded');
  }
} finally { try { db.close(); } finally { releaseOwnership(); } }
