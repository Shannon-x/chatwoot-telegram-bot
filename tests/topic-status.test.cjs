const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

test('topic status treats already applied as success, but network failure as retryable', async()=>{
  let mode='unchanged';
  const change=async()=>{if(mode==='unchanged') throw {response:{description:'Bad Request: TOPIC_NOT_MODIFIED'}}; if(mode==='failure') throw Error('network');};
  const logger={debug(){},info(){},warn(){},error(){}};
  const mocks={
    './config':{config:{telegramForumChatId:'-100'}},
    './bot-instance':{bot:{telegram:{closeForumTopic:change,reopenForumTopic:change}}},
    './database':{getTopic:()=>({telegram_topic_id:42})},
    './logger':{createLogger:()=>logger},
    './chatwoot':{}, './formatters':{},
  };
  const modulePath=require.resolve('../dist/topics.js'), original=Module._load;
  Module._load=function(request,parent){
    if(parent?.filename?.replace(/\\/g,'/').endsWith('/dist/topics.js') && Object.hasOwn(mocks,request)) return mocks[request];
    return original.apply(this,arguments);
  };
  delete require.cache[modulePath];
  try {
    const topics=require(modulePath);
    assert.equal(await topics.closeTopicForConversation(7),true);
    assert.equal(await topics.reopenTopicForConversation(7),true);
    mode='failure';
    assert.equal(await topics.closeTopicForConversation(7),false);
    assert.equal(await topics.reopenTopicForConversation(7),false);
    mode='ok';
    assert.equal(await topics.closeTopicForConversation(7),true);
  } finally {Module._load=original; delete require.cache[modulePath];}
});
