const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

test('upgrades existing v2 mappings and topics without enabling reconciliation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-upgrade-'));
  const dbPath = path.join(dir, 'state.db');
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at DATETIME);
    INSERT INTO schema_version VALUES (1,2,CURRENT_TIMESTAMP);
    CREATE TABLE messages (telegram_message_id INTEGER PRIMARY KEY, chatwoot_conversation_id INTEGER NOT NULL, chatwoot_account_id INTEGER, chatwoot_message_id INTEGER);
    INSERT INTO messages VALUES (5,7,1,10);
    CREATE TABLE topics (chatwoot_conversation_id INTEGER PRIMARY KEY, chatwoot_account_id INTEGER, telegram_topic_id INTEGER NOT NULL, topic_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO topics (chatwoot_conversation_id, chatwoot_account_id, telegram_topic_id) VALUES (7,1,42);`);
  raw.close();
  const dbModule = require.resolve('../dist/database.js');
  const original = Module._load;
  Module._load = function(request,parent) {
    if (parent?.filename?.replace(/\\/g,'/').endsWith('/dist/database.js')) {
      if (request==='./config') return {config:{dbPath}};
      if (request==='./logger') return {createLogger:()=>({debug(){},info(){},warn(){},error(){}})};
    }
    return original.apply(this,arguments);
  };
  let store;
  try {
    store=require(dbModule); store.initDb();
    assert.equal(store.getMapping(5).chatwoot_message_id, 10);
    assert.equal(store.getTopic(7).telegram_topic_id, 42);
    assert.equal(store.enqueueWebhook('message:1:10',7,'{}'), false);
    // A legacy deployment does not need to supply a reconciliation baseline.
    assert.equal(store.enqueueWebhook('message:1:11',7,'{}'), true);
  } finally {
    store?.closeDb(); Module._load=original; delete require.cache[dbModule];
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('rejects a newer database schema instead of silently using it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-future-'));
  const dbPath=path.join(dir,'state.db');
  const raw=new Database(dbPath);
  raw.exec('CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at DATETIME); INSERT INTO schema_version VALUES (1,999,CURRENT_TIMESTAMP)');
  raw.close();
  const dbModule=require.resolve('../dist/database.js'), original=Module._load;
  Module._load = function(request,parent) {
    if (parent?.filename?.replace(/\\/g,'/').endsWith('/dist/database.js')) {
      if (request==='./config') return {config:{dbPath}};
      if (request==='./logger') return {createLogger:()=>({debug(){},info(){},warn(){},error(){}})};
    }
    return original.apply(this,arguments);
  };
  let store;
  try { store=require(dbModule); assert.throws(()=>store.initDb(),/newer/); }
  finally { store?.closeDb(); Module._load=original; delete require.cache[dbModule]; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('v5 migration requires captured pre-upgrade boundary and keeps it across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-reconcile-'));
  const dbPath=path.join(dir,'state.db'); const dbModule=require.resolve('../dist/database.js');
  const original=Module._load; const oldValue=process.env.RECONCILIATION_BASELINE_UNIX;
  const logger={debug(){},info(){},warn(){},error(){}};
  Module._load = function(request,parent) {
    if (parent?.filename?.replace(/\\/g,'/').endsWith('/dist/database.js')) {
      if (request==='./config') return {config:{dbPath}};
      if (request==='./logger') return {createLogger:()=>logger};
    }
    return original.apply(this,arguments);
  };
  let store;
  try {
    store=require(dbModule); store.initDb();
    store.enqueueWebhook('message:1:10',7,'{"event":"message_created"}');
    store.closeDb(); store=null; delete require.cache[dbModule];
    const old=new Database(dbPath); old.exec('DROP TABLE reconciliation_state; DROP TABLE bridge_outgoing_sources; ALTER TABLE webhook_queue DROP COLUMN inflight; UPDATE schema_version SET version=5'); old.close();
    delete process.env.RECONCILIATION_BASELINE_UNIX;
    store=require(dbModule); store.initDb();
    assert.throws(()=>store.reconciliationState(2000, 1, 2),/required/);
    process.env.RECONCILIATION_BASELINE_UNIX='1890';
    assert.deepEqual(store.reconciliationState(2000, 1, 2),{baseline:1890,checkpoint:1890});
    assert.throws(()=>store.reconciliationState(2000, 1, 3),/does not match/);
    assert.throws(()=>store.reconciliationState(2000, 2, 2),/does not match/);
    const oldState=new Database(dbPath);
    oldState.prepare('UPDATE reconciliation_state SET account_id = NULL, inbox_id = NULL').run();
    assert.throws(()=>store.reconciliationState(2000, 1, 2),/does not match/);
    oldState.prepare('UPDATE reconciliation_state SET account_id = 1, inbox_id = 2').run(); oldState.close();
    assert.equal(store.enqueueWebhook('message:1:10',7,'duplicate'),false);
    store.advanceReconciliation(1950); store.closeDb(); store=null; delete require.cache[dbModule];
    delete process.env.RECONCILIATION_BASELINE_UNIX;
    store=require(dbModule); store.initDb();
    assert.deepEqual(store.reconciliationState(2001, 1, 2),{baseline:1890,checkpoint:1950});
    assert.throws(()=>store.reconciliationState(2001, 1, 3),/does not match/);
  } finally {
    store?.closeDb(); Module._load=original; delete require.cache[dbModule];
    if (oldValue===undefined) delete process.env.RECONCILIATION_BASELINE_UNIX; else process.env.RECONCILIATION_BASELINE_UNIX=oldValue;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
