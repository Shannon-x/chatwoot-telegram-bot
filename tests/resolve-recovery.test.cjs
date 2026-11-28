const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const Database=require('better-sqlite3');

test('production image includes the offline recovery command',()=>{
  const dockerfile=fs.readFileSync(path.join(__dirname,'../Dockerfile'),'utf8');
  assert.match(dockerfile,/COPY\s+scripts\/resolve-recovery\.cjs\s+\.\/scripts\/resolve-recovery\.cjs/);
  assert.match(dockerfile,/COPY\s+--from=builder\s+\/app\/dist\s+\.\/dist/);
});

test('operator resolves ambiguous delivery atomically without printing payload',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-resolve-'));
  const file=path.join(dir,'test.db');
  const db=new Database(file);
  db.exec(`CREATE TABLE webhook_queue(id INTEGER PRIMARY KEY,conversation_id INTEGER,payload TEXT,inflight TEXT,state TEXT,next_attempt_at INTEGER,text_chunk_index INTEGER,attachment_index INTEGER);
    CREATE TABLE messages(telegram_message_id INTEGER PRIMARY KEY,chatwoot_conversation_id INTEGER,chatwoot_account_id INTEGER,chatwoot_message_id INTEGER);
    CREATE TABLE topics(chatwoot_conversation_id INTEGER PRIMARY KEY,chatwoot_account_id INTEGER,telegram_topic_id INTEGER,topic_name TEXT);
    CREATE TABLE bridge_outgoing_sources(account_id INTEGER,conversation_id INTEGER,telegram_chat_id TEXT,telegram_message_id TEXT,status TEXT);`);
  db.prepare(`INSERT INTO webhook_queue VALUES(1,7,?,'attachment:0','pending',100,1,0)`).run(JSON.stringify({account:{id:1},id:10,content:'DO-NOT-PRINT'}));
  db.prepare(`INSERT INTO bridge_outgoing_sources VALUES(1,7,'99','message:1','pending')`).run();
  const cli=path.join(__dirname,'../scripts/resolve-recovery.cjs');
  const run=(...args)=>spawnSync(process.execPath,[cli,file,...args],{encoding:'utf8'});
  try {
    const {acquireOwnership}=require('../dist/ownership-lock.js');
    const release=acquireOwnership(file);
    assert.notEqual(run('list').status,0);
    assert.notEqual(run('queue','1','retry').status,0);
    const second=spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.join(__dirname,'../dist/ownership-lock.js'))}).acquireOwnership(process.argv[1])`,file],{encoding:'utf8'});
    assert.notEqual(second.status,0);
    assert.equal(db.prepare('SELECT inflight FROM webhook_queue WHERE id=1').get().inflight,'attachment:0');
    release();
    const list=run('list'); assert.equal(list.status,0); assert.doesNotMatch(list.stdout,/DO-NOT-PRINT/);
    assert.notEqual(run('queue','1','delivered').status,0);
    assert.equal(run('queue','1','delivered','45').status,0);
    assert.deepEqual(db.prepare('SELECT inflight,attachment_index FROM webhook_queue WHERE id=1').get(),{inflight:null,attachment_index:1});
    assert.equal(db.prepare('SELECT chatwoot_message_id FROM messages WHERE telegram_message_id=45').get().chatwoot_message_id,10);
    assert.equal(run('outgoing','1','not-delivered').status,0);
    assert.equal(db.prepare('SELECT status FROM bridge_outgoing_sources').get().status,'rejected');
    assert.notEqual(run('outgoing','1','delivered').status,0);
  } finally {db.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
