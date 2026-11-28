'use strict';
// Real bridge process + real SQLite + local HTTP simulators. No real services.
const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const childFile = path.join(__dirname, 'bridge-child.cjs');
const candidate = process.argv[3] ? path.resolve(process.argv[3]) : process.env.LAB_BRIDGE_DIR ? path.resolve(process.env.LAB_BRIDGE_DIR) : path.resolve(__dirname, '../..');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-bridge-'));
const dbPath = path.join(runDir, 'synthetic.sqlite');
const secret = 'synthetic-local-signing-key';
const events = [], sent = [], apiCalls = [];
let bridgePort, nextMessageId = 200, nextTelegramId = 500, topicId = 0;
let raceWebhook = true, bridge, heldReply = false;
const scenario = process.argv[2] || 'basic';
const now = () => Math.floor(Date.now() / 1000);
const conv = id => ({ id, account_id: 1, inbox_id: 2, additional_attributes: {}, custom_attributes: {}, labels: [],
  meta: {sender: { id: 42, name: 'Synthetic Visitor' }, channel: 'Channel::WebWidget'},
  messages: [{conversation: {contact_inbox: {source_id: `source-${id}`}}}] });
function incoming(id, conversationId, text, extra = {}) {
  return {id, conversation_id: conversationId, inbox_id: 2, message_type: 0, private: false,
    content: text, created_at: now(), sender: {id: 42, name:'Synthetic Visitor'}, ...extra};
}
function signedWebhook(message) {
  const body = JSON.stringify(message);
  const timestamp = String(now());
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return fetch(`http://127.0.0.1:${bridgePort}/webhook`, { method:'POST',
    headers:{'content-type':'application/json','x-chatwoot-timestamp':timestamp,'x-chatwoot-signature':'sha256='+sig}, body });
}
function asEvent(m) {
  return {event:'message_created',id:m.id,account:{id:1},inbox:{id:2,name:'Synthetic'},
    conversation:conv(m.conversation_id),message_type:m.message_type === 0 ? 'incoming' : 'outgoing',
    private:m.private,content:m.content,created_at:m.created_at,sender:m.sender,content_attributes:m.content_attributes,
    source_id:m.source_id};
}
function parseBody(req,data) {
  const type=req.headers['content-type'] || '';
  if (!data) return {};
  if (type.includes('application/json')) return JSON.parse(data);
  if (!type.startsWith('multipart/form-data')) throw Error('Unexpected synthetic content type');
  const match=/boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (!match) throw Error('Missing synthetic multipart boundary');
  const result={};
  for(const part of data.split('--'+(match[1]||match[2]))) {
    const sep=part.indexOf('\r\n\r\n');
    if(sep<0) continue;
    const header=part.slice(0,sep), name=/\bname="([^"]+)"/.exec(header)?.[1];
    if(!name || /\bfilename=/.test(header)) continue;
    result[name]=part.slice(sep+4).replace(/\r\n$/,'');
  }
  if(result.content_attributes) result.content_attributes=JSON.parse(result.content_attributes);
  return result;
}
const fakeApi = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://127.0.0.1');
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = parseBody(req,data);
    apiCalls.push(`${req.method} ${url.pathname}`);
    let result;
    if (url.pathname === '/api/v1/profile') result = {id:900};
    else if (url.pathname === '/api/v1/accounts/1/inboxes/2') result = {id:2,name:'Synthetic',channel_type:'Channel::WebWidget'};
    else if (url.pathname === '/api/v1/accounts/1/conversations' && req.method === 'GET') {
      assert.equal(url.searchParams.get('status'),'all');
      result = {data:{payload:[conv(7),conv(8)]}};
    } else if (/^\/api\/v1\/accounts\/1\/conversations\/\d+\/messages$/.test(url.pathname) && req.method === 'GET') {
      const id = Number(url.pathname.split('/')[6]);
      const after=Number(url.searchParams.get('after')), before=Number(url.searchParams.get('before'));
      result={payload:events.filter(e=>e.conversation_id===id && e.id>=after && e.id<before).slice(0,1000)};
    } else if (/^\/api\/v1\/accounts\/1\/conversations\/\d+\/messages$/.test(url.pathname) && req.method === 'POST') {
      const id=Number(url.pathname.split('/')[6]);
      assert.equal(body.source_id,undefined,'bridge must not set Chatwoot source_id for outgoing messages');
      const msg={id:nextMessageId++,conversation_id:id,inbox_id:2,message_type:1,private:false,content:body.content,
        created_at:now(),source_id:body.source_id,sender:{id:900,name:'Synthetic Operator'},content_attributes:body.content_attributes};
      events.push(msg);
      if (raceWebhook) { const wh=await signedWebhook(asEvent(msg)); assert.equal(wh.status,200); }
      if (body.content === 'SYNTHETIC-CRASH-REPLY') {heldReply=true; return;}
      result=msg;
    } else if (url.pathname.endsWith('/toggle_typing_status')) result={};
    else if (url.pathname.startsWith('/bot111111:synthetic-token/')) {
      const method=url.pathname.split('/').pop();
      if(method==='createForumTopic') result={message_thread_id:++topicId};
      else if(method==='sendMessage') {
        const messageId=nextTelegramId++;
        sent.push({...body,synthetic_remote_id:messageId});
        if (body.text?.includes('SYNTHETIC-TG-UNKNOWN')) {req.socket.destroy(); return;}
        result={message_id:messageId, date:now(), chat:{id:body.chat_id,type:'supergroup'},text:body.text};
      }
      else throw Error(`Unexpected Telegram method ${method}`);
      result={ok:true,result};
    } else throw Error(`Unexpected API call ${req.method} ${url.pathname}`);
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(result));
  } catch (e) { res.writeHead(500,{'content-type':'application/json'}); res.end(JSON.stringify({error:String(e)})); }
});
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function withDeadline(promise,ms,onTimeout) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout?.(); reject(Error('Process deadline exceeded'));},ms);})]); }
  finally { clearTimeout(timer); }
}
async function waitFor(fn,label,timeout=9000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {if(fn()) return; await delay(40);}
  throw Error(`Timed out waiting for ${label}`);
}
async function start(port,baseline) {
  const env={PATH:process.env.PATH,Path:process.env.Path,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,
    TEMP:process.env.TEMP,TMP:process.env.TMP,LAB_BRIDGE_DIR:candidate,LOG_TO_FILE:'false',
    LAB_API_ROOT:`http://127.0.0.1:${port}`, CHATWOOT_BASE_URL:`http://127.0.0.1:${port}`,
    CHATWOOT_ACCESS_TOKEN:'synthetic-token',CHATWOOT_ACCOUNT_ID:'1',CHATWOOT_BRIDGE_USER_ID:'900',RECONCILIATION_INBOX_ID:'2',
    RECONCILIATION_BASELINE_UNIX:String(baseline),TELEGRAM_TOKEN:'111111:synthetic-token',
    TELEGRAM_ADMIN_ID:'999',TELEGRAM_FORUM_CHAT_ID:'-100999',CHATWOOT_WEBHOOK_SECRET:secret,DB_PATH:dbPath};
  const p=fork(childFile,[],{cwd:__dirname,env,stdio:['ignore','pipe','pipe','ipc']});
  let stderr=''; p.stderr.on('data',d=>stderr+=d); p.stdout.on('data',()=>{});
  const [message]=await withDeadline(Promise.race([once(p,'message'), once(p,'exit').then(([code])=>{throw Error(`Child exited ${code}: ${stderr}`);})]),15000,()=>p.kill('SIGKILL'));
  assert.equal(message.type,'ready'); bridgePort=message.port; return p;
}
async function stop(p) {
  const done=once(p,'exit'); p.send('stop');
  await withDeadline(done,10000,()=>p.kill('SIGKILL'));
}
function resolveRecovery(...args) {
  const cli=path.join(candidate,'scripts','resolve-recovery.cjs');
  const result=spawnSync(process.execPath,[cli,dbPath,...args],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout;
}
function resolveMustFail(...args) {
  const cli=path.join(candidate,'scripts','resolve-recovery.cjs');
  const result=spawnSync(process.execPath,[cli,dbPath,...args],{encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0,'CLI must refuse access while bridge is running');
}
function readQueueSnapshot() {
  const localRequire=createRequire(path.join(candidate,'package.json'));
  const Database=localRequire('better-sqlite3');
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try {return db.prepare("SELECT id,conversation_id,inflight,text_chunk_index,attachment_index,state FROM webhook_queue ORDER BY id").all();}
  finally {db.close();}
}
async function control(name,body={}) {
  const res=await fetch(`http://127.0.0.1:${bridgePort}/_synthetic/${name}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await res.json(); assert.equal(res.status,200,JSON.stringify(result)); return result;
}
function countText(text) {return sent.filter(x=>typeof x.text==='string' && x.text.includes(text)).length;}

(async()=>{
  await new Promise((resolve,reject)=>fakeApi.listen(0,'127.0.0.1',resolve).once('error',reject));
  const apiPort=fakeApi.address().port, baseline=now()-60;
  try {
    events.push(incoming(1,7,'SYNTHETIC-OFFLINE-A'),incoming(2,8,'SYNTHETIC-OFFLINE-B'),incoming(3,7,'SYNTHETIC-PRIVATE',{private:true}));
    bridge=await start(apiPort,baseline);
    resolveMustFail('list');
    await assert.rejects(start(apiPort,baseline),'a second bridge must not own the same DB');
    await control('reconcile');
    await waitFor(()=>countText('SYNTHETIC-OFFLINE-A')===1 && countText('SYNTHETIC-OFFLINE-B')===1,'offline recovery');
    assert.equal(countText('SYNTHETIC-PRIVATE'),0);
    const topics = sent.filter(x=>x.text?.includes('SYNTHETIC-OFFLINE-')).map(x=>x.message_thread_id);
    assert.equal(new Set(topics).size,2,'different conversations need different topics');
    await control('reconcile');
    assert.equal((await signedWebhook(asEvent(events[0]))).status,200);
    await delay(250);
    assert.equal(countText('SYNTHETIC-OFFLINE-A'),1,'scan + webhook duplicate');
    await stop(bridge); bridge=undefined;
    events.push(incoming(4,7,'SYNTHETIC-DURING-RESTART'));
    bridge=await start(apiPort,baseline);
    await control('reconcile');
    await waitFor(()=>countText('SYNTHETIC-DURING-RESTART')===1,'restart recovery');
    assert.equal(countText('SYNTHETIC-OFFLINE-A'),1,'persisted dedup after restart');
    await control('reply',{content:'SYNTHETIC-OPERATOR-REPLY'});
    await delay(500);
    assert.equal(countText('SYNTHETIC-OPERATOR-REPLY'),0,'outgoing webhook raced before POST response');
    await control('reply-media',{content:'SYNTHETIC-MULTIPART-REPLY'});
    await delay(500);
    assert.equal(countText('SYNTHETIC-MULTIPART-REPLY'),0,'outgoing multipart webhook raced before POST response');
    let id=701;
    for(const [label,content] of [['TEXT','SYNTHETIC-OPERATOR-REPLY'],['MULTIPART','SYNTHETIC-MULTIPART-REPLY']]) {
      const ownReply=events.find(m=>m.content===content);
      assert.ok(typeof ownReply?.content_attributes?.telegram_bridge_origin_token==='string','outgoing reply must have a persisted synthetic marker');
      const marker=ownReply.content_attributes.telegram_bridge_origin_token;
      assert.ok(marker.length>0);
      const foreignSender=asEvent({...ownReply,id:id++,content:`SYNTHETIC-${label}-FOREIGN-SENDER`,sender:{id:901,name:'Other synthetic operator'}});
      const foreignConversation=asEvent({...ownReply,id:id++,conversation_id:8,content:`SYNTHETIC-${label}-FOREIGN-CONVERSATION`});
      const foreignAccount={...asEvent({...ownReply,id:id++,content:`SYNTHETIC-${label}-FOREIGN-ACCOUNT`}),account:{id:3}};
      for(const event of [foreignSender,foreignConversation,foreignAccount]) assert.equal((await signedWebhook(event)).status,200);
      await waitFor(()=>['SENDER','CONVERSATION','ACCOUNT'].every(scope=>countText(`SYNTHETIC-${label}-FOREIGN-${scope}`)===1),'unmatched marker scope must not suppress messages');
    }
    if (scenario === 'crash') {
      const pending=control('reply',{content:'SYNTHETIC-CRASH-REPLY'}).catch(()=>null);
      await waitFor(()=>heldReply,'webhook enqueued before POST response');
      bridge.kill('SIGKILL'); await once(bridge,'exit'); bridge=undefined; await pending;
      assert.equal(JSON.parse(resolveRecovery('list')).outgoing.length,1,'OS must release lock after process death');
      bridge=await start(apiPort,baseline);
      await delay(2200);
      assert.equal(countText('SYNTHETIC-CRASH-REPLY'),0,'self-sent echo after restart during POST');
      assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/health`)).status,503,'interrupted outgoing POST needs operator attention');
      const another=incoming(10,8,'SYNTHETIC-OTHER-AFTER-CRASH'); events.push(another);
      assert.equal((await signedWebhook(asEvent(another))).status,200);
      await waitFor(()=>countText('SYNTHETIC-OTHER-AFTER-CRASH')===1,'independent conversation after interrupted POST');
      await stop(bridge); bridge=undefined;
      const pendingRows=JSON.parse(resolveRecovery('list')).outgoing;
      assert.equal(pendingRows.length,1);
      resolveRecovery('outgoing',String(pendingRows[0].id),'delivered');
      bridge=await start(apiPort,baseline);
      await delay(200);
      assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/health`)).status,200,'operator resolved delivered Chatwoot reply');
      assert.equal(countText('SYNTHETIC-CRASH-REPLY'),0);
    }
    if (scenario === 'unknown') {
      const event=incoming(8,7,'SYNTHETIC-TG-UNKNOWN'); events.push(event);
      assert.equal((await signedWebhook(asEvent(event))).status,200);
      await waitFor(()=>countText('SYNTHETIC-TG-UNKNOWN')>0,'Telegram accepted message but response was lost');
      await delay(3500);
      assert.equal(countText('SYNTHETIC-TG-UNKNOWN'),1,'must not automatically retry uncertain Telegram operation');
      const status=await fetch(`http://127.0.0.1:${bridgePort}/health`);
      assert.equal(status.status,503,'uncertain Telegram operation should degrade health');
      const beforeCli=readQueueSnapshot();
      const uncertainRow=beforeCli.find(row=>row.conversation_id===7 && row.inflight);
      assert.ok(uncertainRow,'uncertain send must remain persisted');
      resolveMustFail('queue',String(uncertainRow.id),'retry');
      assert.deepEqual(readQueueSnapshot(),beforeCli,'refused CLI must not alter queue');
      await stop(bridge); bridge=undefined;
      bridge=await start(apiPort,baseline);
      await delay(1800);
      assert.equal(countText('SYNTHETIC-TG-UNKNOWN'),1,'ambiguous operation must remain parked after restart');
      const another=incoming(9,8,'SYNTHETIC-ANOTHER-TOPIC'); events.push(another);
      assert.equal((await signedWebhook(asEvent(another))).status,200);
      await waitFor(()=>countText('SYNTHETIC-ANOTHER-TOPIC')===1,'independent conversation after ambiguous operation');
      assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/health`)).status,503,'ambiguous outcome must remain visible in health');
      await stop(bridge); bridge=undefined;
      const pendingRows=JSON.parse(resolveRecovery('list')).queue;
      assert.equal(pendingRows.length,1);
      const delivered=sent.find(x=>x.text?.includes('SYNTHETIC-TG-UNKNOWN'));
      resolveRecovery('queue',String(pendingRows[0].id),'delivered',String(delivered.synthetic_remote_id));
      bridge=await start(apiPort,baseline);
      await delay(1200);
      assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/health`)).status,200,'operator resolved delivered Telegram message');
      assert.equal(countText('SYNTHETIC-TG-UNKNOWN'),1,'manual delivered resolution must not resend');
    }
    const checked=['offline messages','private exclusion','separate topics','scan/webhook duplicate','restart and persistent dedup','text and multipart webhook-before-POST race','marker scope','exclusive DB ownership'];
    if(scenario==='crash') checked.push('SIGKILL during Chatwoot POST','manual outgoing resolution');
    if(scenario==='unknown') checked.push('Telegram accepted then connection reset','ambiguous state persists across restart','manual Telegram resolution');
    console.log(JSON.stringify({ok:true,scenario,scenarios:checked,httpCalls:apiCalls.length}));
  } finally {
    if(bridge) await stop(bridge);
    fakeApi.closeAllConnections();
    await new Promise(resolve=>fakeApi.close(resolve));
    const parent=path.resolve(os.tmpdir()), actual=path.resolve(runDir);
    if (path.dirname(actual) !== parent || !path.basename(actual).startsWith('synthetic-bridge-')) throw Error('Unsafe temporary path');
    for (const suffix of ['', '-wal', '-shm', '.bridge-lock', '.bridge-lock-wal', '.bridge-lock-shm']) {const file=dbPath+suffix; if(fs.existsSync(file)) fs.unlinkSync(file);}
    fs.rmdirSync(actual);
  }
})().catch(e=>{console.error(e.stack||String(e));process.exitCode=1;});
