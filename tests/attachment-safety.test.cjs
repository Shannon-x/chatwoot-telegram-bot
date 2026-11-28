const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const {TelegramError}=require('telegraf');

const reject=(description,code=400)=>new TelegramError({ok:false,error_code:code,description});

async function run(directError, options={}) {
  const attempts=[]; let inflight=false, mappings=0, downloads=0;
  const bot={telegram:{sendDocument:async (_chat, payload)=>{
    attempts.push(payload);
    if (attempts.length===1 && directError) throw directError;
    return {message_id:91};
  }}};
  const mocks={
    './config':{config:{chatwootBaseUrl:'https://chat.example.test',chatwootAccessToken:'test-token'}},
    './bot-instance':{bot}, './database':{saveMapping(){throw Error('unexpected');}},
    './logger':{createLogger:()=>({debug(){},info(){},warn(){},error(){}})},
    './safe-download':{downloadSafeChatwootAttachment:async()=>{downloads++;return {buffer:Buffer.from('synthetic'),mimeType:'application/pdf'};}},
  };
  const original=Module._load, file=require.resolve('../dist/attachments.js');
  Module._load=function(request,parent){if(parent?.filename?.replace(/\\/g,'/').endsWith('/dist/attachments.js') && Object.hasOwn(mocks,request)) return mocks[request]; return original.apply(this,arguments);};
  delete require.cache[file];
  try {
    const {sendAttachmentToTelegram}=require(file);
    let error;
    try { await sendAttachmentToTelegram({chatId:'1',accountId:1,conversationId:2,att:{id:3,file_type:'file',data_url:'https://chat.example.test/rails/active_storage/blobs/x.pdf'},
      beginSend:()=>{assert.equal(inflight,false); inflight=true;},
      clearSend:()=>{assert.equal(inflight,true); inflight=false;},
      recordSent:()=>{if(options.failCommit)throw Error('simulated database failure');mappings++;inflight=false;}}); }
    catch (e) {error=e;}
    return {attempts, inflight, mappings, downloads, error};
  } finally {Module._load=original;delete require.cache[file];}
}

test('confirmed URL rejection performs exactly one download and upload',async()=>{
  const r=await run(reject('Bad Request: failed to get HTTP URL content'));
  assert.equal(r.error,undefined);assert.equal(r.attempts.length,2);assert.equal(r.downloads,1);assert.equal(r.mappings,1);assert.equal(r.inflight,false);
});
for (const [label,error] of [
  ['synthetic Telegram 500',new TelegramError({error_code:500,description:'Internal Server Error'})],
  ['timeout',Error('timeout')],['invalid response',new SyntaxError('bad JSON')],
  ['unrecognised 400',reject('Bad Request: something else')],
]) test(`${label} never triggers a second upload`,async()=>{
  const r=await run(error);assert.ok(r.error);assert.equal(r.attempts.length,1);assert.equal(r.downloads,0);
  if(label!=='unrecognised 400')assert.equal(r.inflight,true);
});
test('local commit failure is not mistaken for an API rejection',async()=>{
  const r=await run(null,{failCommit:true});assert.ok(r.error);assert.equal(r.attempts.length,1);assert.equal(r.inflight,true);
});
