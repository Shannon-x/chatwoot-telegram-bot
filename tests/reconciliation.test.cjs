const {test} = require('node:test');
const assert = require('node:assert/strict');
const {reconcileOnce, MessageRangeTooLarge, ReconciliationHealth} = require('../dist/reconciliation.js');

test('health degrades after failed or stalled scans using monotonic elapsed time', () => {
  let now = 0; const health = new ReconciliationHealth(() => now);
  assert.equal(health.isFailed(), true);
  health.start(); now = 100; health.finish(true);
  assert.equal(health.isFailed(), false);
  now = 1000; health.start(); now = 300000;
  assert.equal(health.isFailed(), true);
  health.finish(false); assert.equal(health.isFailed(), true);
  health.start(); health.finish(true); assert.equal(health.isFailed(), false);
});
const conv = id => ({id, account_id: 1, inbox_id: 2, meta: {sender: {name: 'test'}, channel:'Channel::WebWidget'},
  messages:[{content:'PRIVATE_NOTE',conversation:{contact_inbox:{source_id:'source-7'}}}],
  last_non_activity_message:{content:'OTHER_PRIVATE_NOTE'}});
const msg = (id, fields = {}) => ({id, created_at: 1000 + id, conversation_id: 7, inbox_id: 2, message_type: 0, private: false, content: `message ${id}`, ...fields});
function fixture(overrides = {}) {
  const seen = new Map(), advanced = [], calls = [];
  const dep = {
    accountId: 1, inboxId: 2, now: () => 2_000_000,
    state: () => ({baseline: 1000, checkpoint: 1000}),
    advance: n => advanced.push(n), enqueue: (key, id, payload) => { if (seen.has(key)) return false; seen.set(key, {id, payload:JSON.parse(payload)}); return true; },
    verifyInbox:async()=>({id:2,name:'Web chat',channel_type:'Channel::WebWidget',secret:'DO_NOT_STORE'}),
    conversations: async within => {calls.push(['conversations', within]); return {data:{payload:[conv(7)]}};},
    messages: async (id, after, before) => {calls.push(['messages', id, after, before]); return {payload:[]};}, ...overrides,
  };
  return {dep,seen,advanced,calls};
}

test('range splitting recovers >1000 with inverted timestamps and deduplicates allowed events', async () => {
  const items = Array.from({length: 1200}, (_,i) => msg(i + 1));
  // Chronological and id order are deliberately opposite; cursor pagination would skip rows.
  items.forEach((item,i) => {item.created_at = 2200-i;});
  items[2].private = true; items[3].message_type = 1; items[4].content_attributes = {deleted:true};
  const intervals=[];
  const f = fixture({messages: async (id,after,before) => {
    intervals.push([after,before]);
    return {payload:items.filter(m=>m.id>=after&&m.id<before).sort((a,b)=>a.created_at-b.created_at).slice(0,1000)};
  }});
  await reconcileOnce(f.dep);
  assert.ok(intervals.length > 1); assert.equal(f.seen.size,1197);
  assert.equal(f.seen.has('message:1:3'),false); assert.equal(f.seen.has('message:1:4'),false);
  const event=f.seen.get('message:1:6').payload;
  assert.equal(event.message_type,'incoming'); assert.equal(event.conversation.id,7);
  assert.equal(event.inbox.name,'Web chat'); assert.equal(event.conversation.channel,'Channel::WebWidget');
  assert.equal(event.conversation.contact_inbox.source_id,'source-7');
  assert.doesNotMatch(JSON.stringify(event),/PRIVATE_NOTE|DO_NOT_STORE/);
  assert.deepEqual(f.advanced,[2000]); await reconcileOnce(f.dep); assert.equal(f.seen.size,1197);
});

test('no checkpoint on network errors, wrong scope, missing privacy, duplicates or out of range ids', async () => {
  const cases = [
    {conversations: async () => {throw Error('network');}},
    {conversations: async () => ({data:{payload:[{...conv(7),inbox_id:99}]}})},
    {messages: async () => ({payload:[msg(1),msg(1)]})},
    {messages: async () => ({payload:[msg(2147483648)]})},
    {messages: async () => ({payload:[msg(1,{private:undefined})]})},
  ];
  for (const overrides of cases) { const f=fixture(overrides); await assert.rejects(reconcileOnce(f.dep)); assert.deepEqual(f.advanced,[]); }
});

test('baseline and checkpoint overlap skip older history', async () => {
  const f=fixture({state:()=>({baseline:1010,checkpoint:1130}), messages:async()=>({payload:[msg(9),msg(10),msg(11)]})});
  await reconcileOnce(f.dep); assert.deepEqual([...f.seen.keys()],['message:1:10','message:1:11']);
  assert.deepEqual(f.calls[0],['conversations',990]);
});

test('partial scan retries without duplicates and preserves checkpoint', async () => {
  let fail=true;
  const f=fixture({conversations:async()=>({data:{payload:[conv(7),conv(8)]}}),messages:async id=>{
    if (id===8 && fail) throw Error('temporarily unavailable');
    return {payload:id===7 ? [msg(1)] : [msg(2,{conversation_id:8})]};
  }});
  await assert.rejects(reconcileOnce(f.dep)); assert.deepEqual(f.advanced,[]); assert.equal(f.seen.size,1);
  fail=false; await reconcileOnce(f.dep); assert.equal(f.seen.size,2); assert.deepEqual(f.advanced,[2000]);
});

test('new insert appearing after its interval was scanned is picked up next sweep', async () => {
  const items=Array.from({length:1000},(_,i)=>msg(i+1)); let calls=0;
  const f=fixture({messages:async (_id,after,before)=>{
    calls++;
    const result=items.filter(m=>m.id>=after&&m.id<before).slice(0,1000);
    // Simulate an insert into an interval already returned; next scan sees it.
    if (calls===1) items.push(msg(1001));
    return {payload:result};
  }});
  await reconcileOnce(f.dep); await reconcileOnce(f.dep);
  assert.equal(f.seen.size,1001);
});

test('backwards clock leaves watermark unchanged', async () => {
  const f=fixture({state:()=>({baseline:1000,checkpoint:2100})});
  await assert.rejects(reconcileOnce(f.dep)); assert.deepEqual(f.advanced,[]);
});


test('oversize interval is split, and oversize indivisible row does not advance checkpoint', async () => {
  const calls=[];
  const f=fixture({messages:async (_id,after,before)=>{
    calls.push([after,before]);
    if (before-after > 1073741824) throw new MessageRangeTooLarge();
    return {payload: after===0 ? [msg(1)] : []};
  }});
  await reconcileOnce(f.dep); assert.equal(f.seen.size,1); assert.ok(calls.length>=3);
  const bad=fixture({messages:async()=>{throw new MessageRangeTooLarge();}});
  await assert.rejects(reconcileOnce(bad.dep)); assert.deepEqual(bad.advanced,[]);
});

test('loss of inbox access before or during sweep prevents checkpoint advance', async () => {
  let count=0;
  const f=fixture({verifyInbox:async()=>{count++; return {id:count===1?2:999};}});
  await assert.rejects(reconcileOnce(f.dep)); assert.deepEqual(f.advanced,[]);
  const g=fixture({verifyInbox:async()=>{throw Error('forbidden');}});
  await assert.rejects(reconcileOnce(g.dep)); assert.deepEqual(g.advanced,[]);
});
