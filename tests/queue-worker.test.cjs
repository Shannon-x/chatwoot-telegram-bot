const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('legacy mode ignores stale topic mappings and continues to later messages', async () => {
  let statusCalls=0, sent=0;
  const items=[
    {id:1,conversation_id:7,attempts:0,payload:JSON.stringify({event:'conversation_status_changed',id:7,status:'resolved'})},
    {id:2,conversation_id:7,attempts:0,text_sent:0,text_chunk_index:0,attachment_index:0,
      payload:JSON.stringify({event:'message_created',id:10,account:{id:1},conversation:{id:7},message_type:'incoming'})},
  ];
  const logger={debug(){},info(){},warn(){},error(){}};
  const mocks={
    './config':{config:{telegramForumChatId:'',telegramAdminId:'99'}},
    './bot-instance':{bot:{telegram:{sendMessage:async()=>{sent++; return {message_id:20};}}}},
    './database':{getTopic:()=>({telegram_topic_id:42}),nextQueuedWebhook:()=>items[0],
      completeQueuedWebhook:()=>items.shift(),retryQueuedWebhook:()=>{throw Error('unexpected retry');},
      recordQueuedTextChunkSent(){},markQueuedTextSent(){},markQueuedAttachmentSent(){}},
    './chatwoot':{isSelfSentMessage:()=>false,conversationMutex:{runExclusive:(_k,f)=>f()}},
    './logger':{createLogger:()=>logger},
    './formatters':{renderForwardedMessage:()=>'text',extractContactCard:()=>({}),extractSenderName:()=>({name:'test'})},
    './attachments':{extractAttachments:()=>[]},
    './topics':{getOrCreateTopic:async()=>undefined,buildLegacyKeyboard:()=>({}),
      closeTopicForConversation:async()=>{statusCalls++; return false;}},
  };
  const modulePath=require.resolve('../dist/server.js'), original=Module._load;
  Module._load=function(request,parent){
    if(parent?.filename?.replace(/\\/g,'/').endsWith('dist/server.js') && Object.hasOwn(mocks,request)) return mocks[request];
    return original.apply(this,arguments);
  };
  delete require.cache[modulePath];
  try {
    const {drainWebhookQueue}=require(modulePath);
    await drainWebhookQueue();
    assert.equal(statusCalls,0); assert.equal(sent,1); assert.equal(items.length,0);
  } finally {Module._load=original; delete require.cache[modulePath];}
});

test('deleted topic after partial delivery remains queued for manual recovery', async () => {
  let dropped=0, retried=0, completed=false;
  const item={id:9, conversation_id:7, attempts:0, text_sent:1, text_chunk_index:1, attachment_index:0,
    payload:JSON.stringify({event:'message_created',id:10,account:{id:1},conversation:{id:7},message_type:'incoming'})};
  const logger={debug(){},info(){},warn(){},error(){}};
  const mocks={
    './config':{config:{telegramForumChatId:'-100'}}, './bot-instance':{bot:{telegram:{}}},
    './database':{nextQueuedWebhook:()=>retried ? undefined : item, retryQueuedWebhook:()=>{retried++;},
      completeQueuedWebhook:()=>{completed=true;}},
    './chatwoot':{isSelfSentMessage:()=>false,conversationMutex:{runExclusive:(_k,f)=>f()}},
    './logger':{createLogger:()=>logger},
    './formatters':{renderForwardedMessage:()=>'text',extractContactCard:()=>({}),extractSenderName:()=>({name:'test'})},
    './attachments':{extractAttachments:()=>[{id:1}],sendAttachmentToTelegram:async()=>{throw Error('TOPIC_DELETED');}},
    './topics':{getOrCreateTopic:async()=>42,buildForumInlineKeyboard:()=>({}),dropTopic:()=>{dropped++;}},
  };
  const modulePath=require.resolve('../dist/server.js'), original=Module._load;
  Module._load=function(request,parent){
    if(parent?.filename?.replace(/\\/g,'/').endsWith('dist/server.js') && Object.hasOwn(mocks,request)) return mocks[request];
    return original.apply(this,arguments);
  };
  delete require.cache[modulePath];
  try {
    const {drainWebhookQueue}=require(modulePath);
    await drainWebhookQueue();
    assert.equal(dropped,0); assert.equal(retried,1); assert.equal(completed,false);
  } finally {Module._load=original; delete require.cache[modulePath];}
});

test('status network failure remains queued and retries', async () => {
  let fail = true, waiting = false, completed = false;
  const item = {id: 8, conversation_id: 7, attempts: 0, payload: JSON.stringify({event:'conversation_status_changed', id:7, status:'resolved'})};
  const logger = {debug(){}, info(){}, warn(){}, error(){}};
  const mocks = {
    './config': {config: {telegramForumChatId:'-100'}},
    './bot-instance': {bot:{telegram:{}}},
    './database': {getTopic:()=>({telegram_topic_id:42}), nextQueuedWebhook:()=>!waiting && !completed ? item : undefined,
      retryQueuedWebhook:()=>{waiting=true;}, completeQueuedWebhook:()=>{completed=true;}},
    './chatwoot': {isSelfSentMessage:()=>false, conversationMutex:{runExclusive:(_key, fn)=>fn()}},
    './logger': {createLogger:()=>logger},
    './formatters': {}, './attachments': {},
    './topics': {closeTopicForConversation:async()=>!fail},
  };
  const original=Module._load, modulePath=require.resolve('../dist/server.js');
  Module._load=function(request,parent) {
    if (parent?.filename?.replace(/\\/g,'/').endsWith('dist/server.js') && Object.hasOwn(mocks,request)) return mocks[request];
    return original.apply(this,arguments);
  };
  delete require.cache[modulePath];
  try {
    const {drainWebhookQueue, QueueWorkerHealth}=require(modulePath);
    let clock=0; const health=new QueueWorkerHealth(()=>clock);
    assert.equal(health.isStalled(),false); health.start(); clock=300000;
    assert.equal(health.isStalled(),true); health.finish(); assert.equal(health.isStalled(),false);
    await drainWebhookQueue(); assert.equal(waiting,true); assert.equal(completed,false);
    fail=false; waiting=false; await drainWebhookQueue(); assert.equal(completed,true);
  } finally { Module._load=original; delete require.cache[modulePath]; }
});

test('delivery failure retains progress and never resends confirmed steps', async () => {
  let fail = true, failAttachment = true, waiting = false, completed = false, retries = 0;
  let textSends = 0;
  const fileSends = [];
  const item = {id: 1, conversation_id: 7, attempts: 0, text_sent: 0, attachment_index: 0, payload: JSON.stringify({
    event:'message_created', id:10, account:{id:1}, inbox:{id:2},
    conversation:{id:7}, message_type:'incoming', content:'synthetic'
  })};
  const logger = {debug(){}, info(){}, warn(){}, error(){}};
  const mocks = {
    './config': {config: {chatwootWebhookSecret:'test', chatwootAccountId:'1', chatwootInboxId:'2', telegramForumChatId:'-100', telegramAdminId:'99'}},
    './bot-instance': {bot:{telegram:{sendMessage:async () => {if (fail) throw new Error('simulated'); textSends++; return {message_id:11};}}}},
    './database': {
      saveMapping(){}, getTopic: () => ({telegram_topic_id: 42}), enqueueWebhook(){},
      nextQueuedWebhook: () => (!waiting && !completed ? item : undefined),
      completeQueuedWebhook: id => {assert.equal(id, 1); completed = true;},
      markQueuedTextSent: () => { item.text_sent = 1; },
      recordQueuedTextChunkSent: (_id, next) => { item.text_chunk_index = next; },
      markQueuedAttachmentSent: (_id, next) => { item.attachment_index = next; },
      retryQueuedWebhook: id => {assert.equal(id, 1); retries++; waiting = true;}
    },
    './chatwoot': {isSelfSentMessage:() => false, conversationMutex:{runExclusive:(_key, fn) => fn()}},
    './logger': {createLogger:() => logger},
    './formatters': {renderForwardedMessage:() => 'text', extractContactCard:() => ({name:'test'}), extractSenderName:() => ({name:'test'})},
    './attachments': {extractAttachments:() => [{id:1}, {id:2}], sendAttachmentToTelegram:async ({att}) => { fileSends.push(att.id); if (failAttachment && att.id === 2) throw new Error('simulated attachment error'); }},
    './topics': {getOrCreateTopic:async () => 42, closeTopicForConversation:async () => true, reopenTopicForConversation:async () => true,
      dropTopic(){}, buildForumInlineKeyboard:() => ({}), buildLegacyKeyboard:() => ({})},
  };
  const original = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename?.replace(/\\/g, '/').endsWith('dist/server.js') && Object.hasOwn(mocks, request)) return mocks[request];
    return original.apply(this, arguments);
  };
  try {
    const {drainWebhookQueue} = require('../dist/server.js');
    await drainWebhookQueue();
    assert.equal(completed, false);
    assert.equal(retries, 1);
    fail = false;
    waiting = false;
    await drainWebhookQueue();
    assert.equal(completed, false);
    assert.equal(retries, 2);
    failAttachment = false;
    waiting = false;
    await drainWebhookQueue();
    assert.equal(completed, true);
    assert.equal(retries, 2);
    assert.equal(textSends, 1);
    assert.deepEqual(fileSends, [1, 2, 2]);
  } finally {
    Module._load = original;
  }
});

test('closed topic is reopened before retry so its later open status is not blocked', async () => {
  let closed = true, reopened = 0, sent = 0;
  const items = [
    {id:1, conversation_id:7, attempts:0, text_sent:0, attachment_index:0, payload:JSON.stringify({event:'message_created', id:10, account:{id:1}, conversation:{id:7}, message_type:'incoming'})},
    {id:2, conversation_id:7, attempts:0, text_sent:0, attachment_index:0, payload:JSON.stringify({event:'conversation_status_changed', id:7, status:'open'})},
  ];
  const logger = {debug(){}, info(){}, warn(){}, error(){}};
  const mocks = {
    './config': {config:{telegramForumChatId:'-100', telegramAdminId:'99'}},
    './bot-instance': {bot:{telegram:{sendMessage:async (_chat, _text, options) => {assert.equal(options.message_thread_id,42); if (closed) throw new Error('Bad Request: TOPIC_CLOSED'); sent++; return {message_id:11};}}}},
    './database': {saveMapping(){}, getTopic:() => ({telegram_topic_id:42}), nextQueuedWebhook:() => items[0],
      completeQueuedWebhook:id => {assert.equal(items[0].id,id); items.shift();},
      markQueuedTextSent:() => {}, recordQueuedTextChunkSent:() => {}, markQueuedAttachmentSent:() => {}, retryQueuedWebhook:() => {throw new Error('unexpected retry');}},
    './chatwoot': {isSelfSentMessage:() => false, conversationMutex:{runExclusive:(_key, fn) => fn()}},
    './logger': {createLogger:() => logger},
    './formatters': {renderForwardedMessage:() => 'text', extractContactCard:() => ({name:'test'}), extractSenderName:() => ({name:'test'})},
    './attachments': {extractAttachments:() => []},
    './topics': {getOrCreateTopic:async () => 42, reopenTopicForConversation:async id => {assert.equal(id,7); reopened++; closed=false; return true;},
      buildForumInlineKeyboard:() => ({}), buildLegacyKeyboard:() => ({})},
  };
  const original = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename?.replace(/\\/g, '/').endsWith('dist/server.js') && Object.hasOwn(mocks, request)) return mocks[request];
    return original.apply(this, arguments);
  };
  const modulePath = require.resolve('../dist/server.js');
  delete require.cache[modulePath];
  try {
    const {drainWebhookQueue} = require(modulePath);
    await drainWebhookQueue();
    assert.equal(sent,1);
    assert.equal(reopened,2);
    assert.equal(items.length,0);
  } finally {
    Module._load = original;
    delete require.cache[modulePath];
  }
});

test('long Unicode text is split without HTML and resumes after the last confirmed part', async () => {
  let waiting = false, completed = false, attempts = 0, failSecond = true;
  const successes = [];
  const body = ('A🐱'.repeat(3000)) + ' <script>&';
  const item = {id:3, conversation_id:7, attempts:0, text_sent:0, text_chunk_index:0, attachment_index:0,
    payload:JSON.stringify({event:'message_created', id:33, account:{id:1}, conversation:{id:7}, message_type:'incoming', content:body})};
  const logger = {debug(){}, info(){}, warn(){}, error(){}};
  const mocks = {
    './config': {config:{telegramForumChatId:'-100', telegramAdminId:'99'}},
    './bot-instance': {bot:{telegram:{sendMessage:async (_chat, text, options) => {
      attempts++;
      assert.equal(options.parse_mode,undefined);
      assert.ok(text.length <= 3000);
      assert.equal(/[\uD800-\uDBFF]$/.test(text),false);
      assert.equal(/^[\uDC00-\uDFFF]/.test(text),false);
      if (attempts === 2 && failSecond) {failSecond=false; throw new Error('simulated timeout');}
      successes.push(text);
      return {message_id:attempts};
    }}}},
    './database': {saveMapping(){}, getTopic:() => ({telegram_topic_id:42}), nextQueuedWebhook:() => !waiting && !completed ? item : undefined,
      completeQueuedWebhook:() => {completed=true;}, markQueuedTextSent:() => {item.text_sent=1;},
      recordQueuedTextChunkSent:(_id,next) => {item.text_chunk_index=next;}, markQueuedAttachmentSent(){},
      retryQueuedWebhook:() => {waiting=true;}},
    './chatwoot': {isSelfSentMessage:() => false, conversationMutex:{runExclusive:(_key, fn) => fn()}},
    './logger': {createLogger:() => logger},
    './formatters': {renderForwardedMessage:() => '<b>' + 'x'.repeat(5000) + '</b>', extractContactCard:() => ({name:'test'}), extractSenderName:() => ({name:'test'})},
    './attachments': {extractAttachments:() => []},
    './topics': {getOrCreateTopic:async () => 42, buildForumInlineKeyboard:() => ({}), buildLegacyKeyboard:() => ({})},
  };
  const original=Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename?.replace(/\\/g, '/').endsWith('dist/server.js') && Object.hasOwn(mocks,request)) return mocks[request];
    return original.apply(this,arguments);
  };
  const modulePath=require.resolve('../dist/server.js');
  delete require.cache[modulePath];
  try {
    const {drainWebhookQueue}=require(modulePath);
    await drainWebhookQueue();
    assert.equal(completed,false);
    assert.equal(item.text_chunk_index,1);
    waiting=false;
    await drainWebhookQueue();
    assert.equal(completed,true);
    assert.equal(attempts,successes.length+1);
    assert.equal(successes.join(''), '👤 test\n💬 ' + body);
  } finally { Module._load=original; delete require.cache[modulePath]; }
});
