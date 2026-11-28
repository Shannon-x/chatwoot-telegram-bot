const { test } = require('node:test');
const assert = require('node:assert/strict');
const { downloadSafeChatwootAttachment } = require('../dist/safe-download.js');

const base = 'https://chat.example.test';
const token = 'test-token';
const valid = base + '/rails/active_storage/blobs/redirect/signed/file.pdf';

test('same-origin signed attachment and redirect receive authorization only on that origin', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.api_access_token, undefined);
    calls.push([String(url), options.headers.Authorization, options.redirect]);
    if (calls.length === 1) return new Response(null, {status: 302, headers: {location: '/rails/active_storage/disk/signed/file.pdf'}});
    return new Response('PDF', {status: 200, headers: {'content-type': 'application/pdf'}});
  };
  const result = await downloadSafeChatwootAttachment(valid, base, token, {fetchImpl});
  assert.equal(result.buffer.toString(), 'PDF');
  assert.equal(result.mimeType, 'application/pdf');
  assert.deepEqual(calls, [
    [valid, `Bearer ${token}`, 'manual'],
    [base + '/rails/active_storage/disk/signed/file.pdf', `Bearer ${token}`, 'manual'],
  ]);
});

test('rejects untrusted destinations before sending any request', async () => {
  for (const url of [
    'https://attacker.test/rails/active_storage/file',
    'http://chat.example.test/rails/active_storage/file',
    'https://chat.example.test.evil.test/rails/active_storage/file',
    'https://u:p@chat.example.test/rails/active_storage/file',
    base + '/admin',
    base + '/rails/active_storage/%2e%2e/admin',
    base + '/rails/active_storage/%2fadmin',
    'data:text/plain;base64,dGVzdA==',
  ]) {
    let calls = 0;
    await assert.rejects(downloadSafeChatwootAttachment(url, base, token, {fetchImpl: async () => { calls++; throw Error('unexpected'); }}));
    assert.equal(calls, 0, url);
  }
});

test('rejects a cross-origin redirect without issuing a second request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, {status: 302, headers: {location: 'https://attacker.test/rails/active_storage/steal'}});
  };
  await assert.rejects(downloadSafeChatwootAttachment(valid, base, token, {fetchImpl}), /Untrusted/);
  assert.equal(calls, 1);
});

test('limits redirects, declared size and actual streamed size', async () => {
  await assert.rejects(downloadSafeChatwootAttachment(valid, base, token, {
    maxRedirects: 1,
    fetchImpl: async () => new Response(null, {status: 302, headers: {location: valid}}),
  }), /redirect rejected/);
  await assert.rejects(downloadSafeChatwootAttachment(valid, base, token, {
    maxBytes: 2,
    fetchImpl: async () => new Response('PDF', {headers: {'content-length': '3'}}),
  }), /too large/);
  await assert.rejects(downloadSafeChatwootAttachment(valid, base, token, {
    maxBytes: 2,
    fetchImpl: async () => new Response('PDF'),
  }), /too large/);
});

test('allows an explicitly configured object-storage origin without the Chatwoot token', async () => {
  const calls=[];
  const result=await downloadSafeChatwootAttachment(valid,base,token,{
    allowedExternalOrigins:['https://storage.example.test'],
    fetchImpl:async (url,options)=>{
      calls.push([String(url),options.headers.Authorization]);
      if(calls.length===1)return new Response(null,{status:302,headers:{location:'https://storage.example.test/key?signature=test'}});
      return new Response('PDF');
    },
  });
  assert.equal(result.buffer.toString(),'PDF');
  assert.equal(calls[0][1],`Bearer ${token}`);
  assert.equal(calls[1][1],undefined);
});

test('direct allowed object storage has no token and an untrusted redirect is never fetched', async () => {
  const allowed='https://storage.example.test';let calls=0;
  await assert.rejects(downloadSafeChatwootAttachment(`${allowed}/signed?test=1`,base,token,{
    allowedExternalOrigins:[allowed],fetchImpl:async (_url, options)=>{
      calls++;assert.deepEqual(options.headers,{});
      return new Response(null,{status:302,headers:{location:'https://untrusted.example.test/next'}});
    },
  }),/Untrusted/);
  assert.equal(calls,1);
});

test('allows explicitly configured HTTP Chatwoot origin but never an HTTP object store', async () => {
  const own='http://chat.example.test';
  await downloadSafeChatwootAttachment(`${own}/rails/active_storage/file`,own,token,{fetchImpl:async (_url,o)=>{
    assert.equal(o.headers.Authorization,`Bearer ${token}`);return new Response('PDF');
  }});
  await assert.rejects(downloadSafeChatwootAttachment('http://storage.example.test/file',own,token,
    {allowedExternalOrigins:['http://storage.example.test'],fetchImpl:async()=>{throw Error('unexpected');}}),/Invalid object storage origin/);
});

test('rejects wildcard object-storage origin configuration before network access', async () => {
  await assert.rejects(downloadSafeChatwootAttachment(valid,base,token,{
    allowedExternalOrigins:['https://*.example.test'],fetchImpl:async()=>{throw Error('unexpected network');},
  }),/Invalid object storage origin/);
});
