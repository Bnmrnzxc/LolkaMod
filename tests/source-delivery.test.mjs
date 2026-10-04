import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ENTRY_HASH, enableSourceAdapter, transformEntry } from '../dist/source-adapter.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(workspace, 'research', 'public-frontend', 'pinned-entry.js');

class FakeDebugger extends EventEmitter {
  commands = [];
  failAttach = false;
  responses = new Map();

  attach(protocol) {
    if (this.failAttach) throw new Error('debugger attach denied');
    this.protocol = protocol;
  }

  async sendCommand(method, params) {
    this.commands.push({ method, params });
    const response = this.responses.get(method);
    if (response) return response(params);
    return {};
  }

  async emitPaused(params) {
    const listeners = this.listeners('message');
    await Promise.all(listeners.map(listener => listener({}, 'Fetch.requestPaused', params)));
  }
}

async function setup({ failAttach = false, responses = new Map() } = {}) {
  const debuggerApi = new FakeDebugger();
  debuggerApi.failAttach = failAttach;
  debuggerApi.responses = responses;
  const reports = [];
  await enableSourceAdapter({ debugger: debuggerApi }, result => reports.push(result));
  return { debuggerApi, reports };
}

function request(requestId, url = 'https://lolka.app/assets/index-test123.js', responseStatusCode = 200, responseHeaders = []) {
  return { requestId, request: { url }, responseStatusCode, responseHeaders };
}

function commandCalls(debuggerApi, method) {
  return debuggerApi.commands.filter(command => command.method === method);
}

test('supported response is transformed once and retains safe headers', { skip: !existsSync(fixturePath) }, async () => {
  const originalBody = await fs.readFile(fixturePath, 'utf8');
  const headers = [
    { name: 'Content-Type', value: 'application/javascript' },
    { name: 'Content-Security-Policy', value: "default-src 'self'" },
    { name: 'Content-Encoding', value: 'gzip' },
    { name: 'Content-Length', value: '12345' },
    { name: 'ETag', value: '"old-tag"' },
    { name: 'Content-MD5', value: 'checksum' },
    { name: 'Transfer-Encoding', value: 'chunked' },
  ];
  const { debuggerApi, reports } = await setup({
    responses: new Map([['Fetch.getResponseBody', async () => ({ body: originalBody, base64Encoded: false })]]),
  });
  await debuggerApi.emitPaused(request('supported-1', undefined, undefined, headers));

  const fulfill = commandCalls(debuggerApi, 'Fetch.fulfillRequest');
  assert.equal(fulfill.length, 1);
  assert.equal(commandCalls(debuggerApi, 'Fetch.getResponseBody').length, 1);
  assert.equal(commandCalls(debuggerApi, 'Fetch.continueRequest').length, 0);
  assert.equal(fulfill[0].params.requestId, 'supported-1');
  assert.equal(fulfill[0].params.responseCode, 200);
  const deliveredBody = Buffer.from(fulfill[0].params.body, 'base64').toString('utf8');
  assert.equal(deliveredBody, transformEntry(originalBody).body);
  assert.deepEqual(fulfill[0].params.responseHeaders, headers.slice(0, 2));
  assert.ok(reports.some(result => result.status === 'transformed' && result.hash === ENTRY_HASH));
});

test('unsupported entry continues the original response exactly once', async () => {
  const unknownBody = 'const unrelatedBundle = true;';
  const { debuggerApi, reports } = await setup({
    responses: new Map([['Fetch.getResponseBody', async () => ({ body: unknownBody, base64Encoded: false })]]),
  });
  await debuggerApi.emitPaused(request('unknown-1'));

  assert.equal(commandCalls(debuggerApi, 'Fetch.fulfillRequest').length, 0);
  assert.equal(commandCalls(debuggerApi, 'Fetch.continueRequest').length, 1);
  assert.equal(commandCalls(debuggerApi, 'Fetch.continueRequest')[0].params.requestId, 'unknown-1');
  assert.ok(reports.some(result => result.status === 'unsupported-structure'));
});

test('response body read failure fails open and continues the request', async () => {
  const { debuggerApi, reports } = await setup({
    responses: new Map([['Fetch.getResponseBody', async () => { throw new Error('body unavailable'); }]]),
  });
  await debuggerApi.emitPaused(request('body-error-1'));

  assert.equal(commandCalls(debuggerApi, 'Fetch.fulfillRequest').length, 0);
  assert.equal(commandCalls(debuggerApi, 'Fetch.continueRequest').length, 1);
  assert.equal(commandCalls(debuggerApi, 'Fetch.continueRequest')[0].params.requestId, 'body-error-1');
  assert.ok(reports.some(result => result.status === 'failed-open'));
});

test('unrelated URL and non-200 response are only continued without reading bodies', async () => {
  const { debuggerApi } = await setup({
    responses: new Map([['Fetch.getResponseBody', async () => assert.fail('must not read unrelated response bodies')]]),
  });
  await debuggerApi.emitPaused(request('other-origin', 'https://example.com/assets/index-test.js'));
  await debuggerApi.emitPaused(request('other-path', 'https://lolka.app/api/index-test.js'));
  await debuggerApi.emitPaused(request('redirect', 'https://lolka.app/assets/index-test.js', 302));

  assert.equal(commandCalls(debuggerApi, 'Fetch.getResponseBody').length, 0);
  assert.equal(commandCalls(debuggerApi, 'Fetch.fulfillRequest').length, 0);
  assert.deepEqual(commandCalls(debuggerApi, 'Fetch.continueRequest').map(command => command.params.requestId), [
    'other-origin', 'other-path', 'redirect',
  ]);
});

test('debugger attach failure reports unavailable', async () => {
  const { debuggerApi, reports } = await setup({ failAttach: true });

  assert.ok(reports.some(result => result.status === 'unavailable'));
  assert.equal(commandCalls(debuggerApi, 'Fetch.enable').length, 0);
});

test('debugger detach reports the connection state', async () => {
  const { debuggerApi, reports } = await setup();
  debuggerApi.emit('detach', {}, 'target_closed');

  assert.ok(reports.some(result => result.connection === 'detached'));
});
