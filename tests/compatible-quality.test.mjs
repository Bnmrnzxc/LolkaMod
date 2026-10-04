import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { transform } from 'esbuild';
import { transformEntry, enableSourceAdapter, nativeQualityPatches } from '../dist/source-adapter.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(workspace, 'research', 'public-frontend', 'pinned-entry.js');
const hasFixture = existsSync(fixturePath);
const privateFixtureTest = (name, run) => test(name, { skip: !hasFixture && 'Private pinned vendor fixture is not distributed' }, run);

function parseFunctions(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const functions = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') functions.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  return functions;
}

function findProducerArrow(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.init?.type === 'ArrowFunctionExpression') {
      const text = source.slice(node.init.start, node.init.end);
      if (text.includes('__lmStockProfile()') && text.includes('voiceChannelId') && text.includes('maxWidth') &&
          text.includes('ownedTracks') && text.includes('getSettings')) found.push(node.init);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  assert.equal(found.length, 1, 'one native screen-capture producer should expose the expected options contract');
  return found[0];
}

privateFixtureTest('whitespace, comments and unrelated module code remain structurally compatible', async () => {
  const original = await fs.readFile(fixturePath, 'utf8');
  const variants = [
    `${original}\n// release comment\n`,
    `${original}\nconst unrelatedReleaseFlag = true;\n`,
    (await transform(original, { loader: 'js', format: 'esm', minifyIdentifiers: true,
      minifySyntax: false, minifyWhitespace: false })).code,
  ];
  for (let index = 0; index < variants.length; index++) {
    const changed = variants[index];
    const result = transformEntry(changed);
    assert.equal(result.changed, true, result.reason);
    assert.equal(result.compatibility, 'structural');
    if (index < 2) assert.ok(result.body.includes(index === 0 ? '// release comment' : 'unrelatedReleaseFlag'));
  }
});

privateFixtureTest('rebound minified picker helpers keep their 720/1080/1440 and 30/60 behavior', async () => {
  const original = await fs.readFile(fixturePath, 'utf8');
  const changed = (await transform(original, { loader: 'js', format: 'esm', minifyIdentifiers: true,
    minifySyntax: false, minifyWhitespace: false })).code;
  const result = transformEntry(changed);
  assert.equal(result.changed, true, result.reason);

  const functions = parseFunctions(result.body);
  const candidates = functions.filter(fn => fn.params.length === 3 && fn.body.body.some(statement =>
    statement.type === 'ReturnStatement' && statement.argument?.type === 'ArrayExpression'));
  assert.ok(candidates.length >= 2, 'both patched picker helpers should remain discoverable after name rebinding');
  const binding = result.binding;
  assert.notEqual(binding.my, undefined);
  assert.notEqual(binding.xg, undefined);
  assert.notEqual(binding.vR, undefined);
  assert.notEqual(binding.Q1, undefined);
  assert.notEqual(binding.uM, undefined);
  const resolution = candidates.find(fn => {
    const text = result.body.slice(fn.start, fn.end);
    return text.includes(binding.my) && text.includes(binding.xg) && text.includes(binding.vR);
  });
  const fps = candidates.find(fn => {
    const text = result.body.slice(fn.start, fn.end);
    return text.includes(binding.Q1) && text.includes(binding.uM);
  });
  assert.ok(resolution && fps, 'patched helper bodies must use rebound resolution and FPS identifiers');
  assert.deepEqual(Array.from(vm.runInNewContext(`(${result.body.slice(resolution.start, resolution.end)})`, {
    [binding.my]: '720p', [binding.xg]: '1080p', [binding.vR]: '1440p',
  })(false, false, 0)), ['720p', '1080p', '1440p']);
  assert.deepEqual(Array.from(vm.runInNewContext(`(${result.body.slice(fps.start, fps.end)})`, {
    [binding.Q1]: 30, [binding.uM]: 60,
  })(false, false, 0)), ['30', '60']);

  const registration = result.body.slice(result.body.indexOf(';globalThis.LolkaMod'));
  assert.ok(registration.includes(`encoder: ${binding.V2e}`));
  assert.ok(registration.includes(`const current = ${binding.Lyt}()`));
  assert.ok(registration.includes(`${binding.mS}[p.resolution]`));
  if (binding.Lyt !== 'Lyt') assert.equal(registration.includes('Lyt()'), false, 'adapter must not refer to the prior private global');

  const producerNode = findProducerArrow(result.body);
  const producerText = result.body.slice(producerNode.start, producerNode.end);
  const calls = [];
  const context = {
    __lmStockProfile: () => ({ resolution: '1440p', fps: 60, codec: 'av1' }),
    [binding.mS]: {
      '720p': { width: 1280, height: 720, freeBitrate: 6_000_000 },
      '1080p': { width: 1920, height: 1080, freeBitrate: 10_000_000 },
      '1440p': { width: 2560, height: 1440, freeBitrate: 16_000_000 },
    },
    [binding._xe]: value => value,
    [binding.wxe]: async value => { calls.push(value); },
  };
  const producer = vm.runInNewContext(`(${producerText})`, context);
  const videoTrack = { marker: 'video', getSettings: () => ({ displaySurface: 'window' }) }, audioTrack = { marker: 'audio' };
  const ownedTracks = [videoTrack, audioTrack];
  await producer('response', {
    getVideoTracks: () => [videoTrack], getAudioTracks: () => [audioTrack], getTracks: () => ownedTracks,
  }, 'voice-channel');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resolution, '1440p');
  assert.equal(calls[0].maxWidth, 2560);
  assert.equal(calls[0].maxHeight, 1440);
  assert.equal(calls[0].fps, 60);
  assert.equal(calls[0].codec, 'av1');
  assert.equal(calls[0].targetBitrate, 16_000_000);
  assert.strictEqual(calls[0].response, 'response');
  assert.strictEqual(calls[0].videoTrack, videoTrack);
  assert.strictEqual(calls[0].audioTrack, audioTrack);
  assert.strictEqual(calls[0].ownedTracks, ownedTracks);
  assert.equal(calls[0].voiceChannelId, 'voice-channel');
  assert.equal(calls[0].capture, 'window');
});

privateFixtureTest('missing, duplicate, changed size table and helper collision fail open byte-for-byte', async () => {
  const original = await fs.readFile(fixturePath, 'utf8');
  const cases = [
    original.replace('getDisplayMedia({audio:o,video:{frameRate:30}})', 'getDisplayMedia({audio:o,video:{frameRate:29}})'),
    `${original}\nconst duplicateContainer=()=>{${nativeQualityPatches[0].find}};\n`,
    original.replace('[my]:{width:1280,height:720', '[my]:{width:1279,height:720'),
    original.replace('await t.setParameters(n)', 'await t.setParameters({})'),
    `${original}\nconst __lmStockProfile = () => null;\n`,
  ];
  for (let index = 0; index < cases.length; index++) {
    const source = cases[index];
    const result = transformEntry(source);
    assert.equal(result.changed, false, `case ${index}: ${result.reason}`);
    assert.equal(result.body, source);
    assert.deepEqual(result.patches, []);
  }
});

test('synthetic public negative inputs return the exact original bytes without private fixture', () => {
  const inputs = [
    'export const label = "public release";\r\n',
    'export function broken( {',
    'const __lmStockProfile = 1; export default __lmStockProfile;\n',
  ];
  for (const source of inputs) {
    const result = transformEntry(source);
    assert.equal(result.changed, false);
    assert.equal(result.body, source);
    assert.deepEqual(result.patches, []);
  }
});

privateFixtureTest('a renamed frontend asset path is intercepted and transformed', async () => {
  const body = `${await fs.readFile(fixturePath, 'utf8')}\n// changed asset filename`;
  let listener;
  const commands = [];
  const debuggerApi = {
    attach() {},
    on(event, callback) { if (event === 'message') listener = callback; },
    async sendCommand(method, params) {
      commands.push({ method, params });
      if (method === 'Fetch.getResponseBody') return { base64Encoded: false, body };
      return {};
    },
  };
  const reports = [];
  await enableSourceAdapter({ debugger: debuggerApi }, report => reports.push(report));
  assert.equal(typeof listener, 'function');
  await listener({}, 'Fetch.requestPaused', {
    requestId: 'test-request', request: { url: 'https://lolka.app/assets/main-new.js' },
    responseStatusCode: 200, responseHeaders: [],
  });
  assert.ok(commands.some(call => call.method === 'Fetch.fulfillRequest'));
  assert.equal(reports.some(report => report.status === 'transformed' && report.compatibility === 'structural'), true);
});
