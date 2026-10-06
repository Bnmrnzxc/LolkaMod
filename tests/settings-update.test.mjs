import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sourceModule(relative) {
  const result = await build({ entryPoints: [path.join(root, `src/${relative}.ts`)], bundle: true,
    platform: 'node', format: 'esm', target: 'es2022', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const [storeModule, updateModule, versions, settings] = await Promise.all([
  sourceModule('main/settings-store'), sourceModule('main/update-service'), sourceModule('shared/updates'), sourceModule('shared/settings'),
]);
const { createSettingsStore } = storeModule;
const { createUpdateService } = updateModule;
const { compareVersions, releaseURL } = versions;
const defaults = () => settings.validateSettings(settings.DEFAULT_SETTINGS);
const temporary = async callback => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-settings-test-'));
  try { await callback(directory); } finally {
    const resolved = path.resolve(directory), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('lolkamod-settings-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
};
const backups = async directory => (await fs.readdir(directory)).filter(name => /^settings-backup-.*\.json$/.test(name));
const latest = (tag = 'v0.6.0', changes = {}) => ({ tag_name: tag, html_url: `https://github.com/Bnmrnzxc/LolkaMod/releases/tag/${tag}`,
  draft: false, prerelease: false, ...changes });
const releaseResponse = (value = latest(), headers = {}) => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json', ...headers },
});

test('legacy migration preserves previous preferences and backs up exact original bytes on first write', async () => {
  await temporary(async directory => {
    const legacy = { enabled: true, customCss: 'body { font-size: 15px; }', qualityEnabled: true,
      profile: { resolution: '1080p', fps: 60, codec: 'VP9', bitrateMbps: 12 } };
    const original = Buffer.from(JSON.stringify(legacy, null, 2) + '\n');
    const file = path.join(directory, 'settings.json'); await fs.writeFile(file, original);
    const store = createSettingsStore(directory); const value = store.read();
    assert.equal(store.status(), 'migrated'); assert.equal(value.schemaVersion, 1);
    assert.equal(value.enabled, true); assert.equal(value.customCss, legacy.customCss); assert.equal(value.qualityEnabled, true);
    assert.deepEqual(value.profile, legacy.profile); assert.equal(value.themeId, 'native'); assert.equal(value.indicatorEnabled, false);
    assert.deepEqual(await fs.readFile(file), original, 'reading does not overwrite legacy bytes');
    assert.equal((await backups(directory)).length, 0);
    value.themeId = 'graphite'; store.write(value);
    assert.equal(store.status(), 'ready'); assert.equal(store.read().themeId, 'graphite');
    const names = await backups(directory); assert.equal(names.length, 1);
    assert.deepEqual(await fs.readFile(path.join(directory, names[0])), original);
    assert.equal(await fs.stat(file + '.tmp').then(() => true, () => false), false);
    store.write({ ...value, indicatorEnabled: true }); assert.equal((await backups(directory)).length, 1);
    const reopened = createSettingsStore(directory); assert.deepEqual(reopened.read(), { ...value, indicatorEnabled: true });
  });
});

test('pre-sound settings keep their palette and quality while sound choice persists across reopened stores', async () => {
  await temporary(async directory => {
    const legacy = { ...defaults(), themeId:'custom', customTheme:{mode:'light',colors:['#0088ff'],saturation:45},
      profile:{resolution:'1440p',fps:60,codec:'AV1',bitrateMbps:16} };
    delete legacy.soundThemeEnabled;
    const file=path.join(directory,'settings.json'), original=JSON.stringify(legacy);
    await fs.writeFile(file,original);
    const store=createSettingsStore(directory), value=store.read();
    assert.equal(value.soundThemeEnabled,false);assert.equal(await fs.readFile(file,'utf8'),original);
    assert.deepEqual(value.customTheme,legacy.customTheme);assert.deepEqual(value.profile,legacy.profile);
    store.write({...value,soundThemeEnabled:true});
    const reopened=createSettingsStore(directory);assert.equal(reopened.read().soundThemeEnabled,true);
    assert.throws(()=>reopened.write({...reopened.read(),soundThemeEnabled:'true'}),/Invalid feature toggle/);
    assert.equal(createSettingsStore(directory).read().soundThemeEnabled,true);
    assert.equal(reopened.reset().soundThemeEnabled,false);
  });
});

test('missing settings write atomically and malformed or future schemas remain untouched until explicit reset', async () => {
  await temporary(async directory => {
    const store = createSettingsStore(directory); const file = path.join(directory, 'settings.json');
    assert.deepEqual(store.read(), defaults()); assert.equal(store.status(), 'missing');
    const expected = { ...defaults(), enabled: true, customCss: '/* local */', themeId: 'amoled', indicatorEnabled: true,
      streamMenuEnabled: false };
    assert.deepEqual(store.write(expected), expected); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), expected);
    assert.equal(store.status(), 'ready'); assert.equal((await backups(directory)).length, 0);
    assert.equal((await fs.readdir(directory)).includes('settings.json.tmp'), false);
    for (const [raw, status] of [
      ['{ invalid json', 'invalid'],
      [JSON.stringify({ ...expected, indicatorEnabled: 'yes' }), 'invalid'],
      [JSON.stringify({ ...expected, schemaVersion: 2, futurePrivateField: 'preserve me' }), 'future-schema'],
    ]) {
      await fs.writeFile(file, raw); assert.deepEqual(store.read(), defaults()); assert.equal(store.status(), status);
      assert.throws(() => store.write(expected), /явный сброс/);
      assert.equal(await fs.readFile(file, 'utf8'), raw);
      const before = new Set(await backups(directory));
      assert.deepEqual(store.reset(), defaults()); assert.equal(store.status(), 'ready');
      const added = (await backups(directory)).filter(name => !before.has(name)); assert.equal(added.length, 1);
      assert.equal(await fs.readFile(path.join(directory, added[0]), 'utf8'), raw);
      assert.deepEqual(store.read(), defaults());
    }
  });
});

test('invalid new preferences do not mutate valid saved settings or create backups', async () => {
  await temporary(async directory => {
    const store = createSettingsStore(directory); store.write(defaults());
    const file = path.join(directory, 'settings.json'); const before = await fs.readFile(file);
    for (const invalid of [
      { ...defaults(), themeId: 'remote-url' }, { ...defaults(), customCss: 'x'.repeat(settings.MAX_CSS_LENGTH + 1) },
      { ...defaults(), miniPlayerDock:'middle' }, { ...defaults(),miniPlayerDock:['bottom-right'] },
      { ...defaults(), profile: { ...defaults().profile, bitrateMbps: NaN } }, { ...defaults(), unexpectedField: true },
    ]) assert.throws(() => store.write(invalid));
    assert.deepEqual(await fs.readFile(file), before); assert.equal((await backups(directory)).length, 0);
  });
});

test('removed mini-player preferences do not reset existing theme, CSS, menu or quality settings', async () => {
  await temporary(async directory => {
    const expected={...defaults(),themeId:'amoled',customCss:'body { color: white; }',indicatorEnabled:true,streamMenuEnabled:false};
    const legacy={...expected,miniPlayerEnabled:false,miniPlayerDock:'top-left'};
    const file=path.join(directory,'settings.json');await fs.writeFile(file,JSON.stringify(legacy));
    const store=createSettingsStore(directory);assert.deepEqual(store.read(),expected);assert.equal(store.status(),'ready');
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),legacy,'read leaves existing bytes intact');
    assert.deepEqual(store.write(expected),expected);assert.deepEqual(createSettingsStore(directory).read(),expected);
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),expected);
  });
});

test('semantic versions compare numeric components, prerelease precedence and ignore build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.9', '1.0.10', '1.1.0', '2.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1);
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(compareVersions('v1.2.3+build.11', '1.2.3+build.12'), 0);
  assert.equal(compareVersions('1.0.0-99999999999999999999999', '1.0.0-99999999999999999999998'), 1);
  for (const invalid of ['1.0', '01.2.3', '1.2.3-01', '1.2.3-alpha..beta', '1.2.3+build..id',
    '1.2.3 trailing', '99999999999999999.0.0', 'x'.repeat(129)]) assert.throws(() => compareVersions(invalid, '1.2.3'));
});

test('release URLs accept only this repository stable tag paths and reject URL lookalikes', () => {
  const value = latest(); assert.equal(releaseURL(value.tag_name, value.html_url), value.html_url);
  for (const url of [
    'https://evil.example/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0',
    'https://github.com.evil.example/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0',
    'https://github.com@evil.example/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0',
    'https://github.com/Bnmrnzxc/AnotherMod/releases/tag/v0.6.0',
    'http://github.com/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0',
    value.html_url + '?download=1', value.html_url + '#fragment', 'javascript:alert(1)',
  ]) assert.equal(releaseURL(value.tag_name, url), null);
  for (const tag of ['v0.6.0-beta.1', 'v0.6', '../v0.6.0', null]) assert.equal(releaseURL(tag, value.html_url), null);
});

test('update check is manual, fixed public endpoint, unauthenticated singleflight with ETag 304 cache', async () => {
  let time = 1000; const requests = []; let releaseFetch;
  const fetcher = (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return new Promise(resolve => { releaseFetch = resolve; });
    return Promise.resolve(new Response(null, { status: 304 }));
  };
  const service = createUpdateService('0.5.0', fetcher, () => time);
  assert.equal(service.status().state, 'idle'); assert.equal(requests.length, 0);
  const first = service.check(), second = service.check(); assert.strictEqual(first, second);
  assert.equal(service.status().state, 'checking'); assert.equal(requests.length, 1);
  releaseFetch(releaseResponse(latest(), { etag: '"release-one"' }));
  const available = await first; assert.equal(available.state, 'available'); assert.equal(available.latest, '0.6.0');
  available.url = 'mutated'; assert.equal(service.status().url, latest().html_url);
  await service.check(); assert.equal(requests.length, 1, 'cooldown avoids repeat requests');
  time += 60001;
  const cached = await service.check(); assert.equal(cached.state, 'available'); assert.equal(cached.checkedAt, time);
  assert.equal(requests.length, 2); assert.equal(requests[1].options.headers['If-None-Match'], '"release-one"');
  for (const request of requests) {
    assert.equal(request.url, 'https://api.github.com/repos/Bnmrnzxc/LolkaMod/releases/latest');
    assert.equal(request.options.method, 'GET'); assert.equal(request.options.redirect, 'error');
    const headers = new Headers(request.options.headers);
    assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
    assert.ok(request.options.signal instanceof AbortSignal); assert.equal(request.options.body, undefined);
  }
  service.stop();
});

test('update service separates current/ahead and rejects drafts, prereleases and forged release links', async () => {
  for (const [tag, expected] of [['v0.5.0', 'current'], ['v0.4.0', 'ahead'], ['v0.10.0', 'available']]) {
    const service = createUpdateService('0.5.0', async () => releaseResponse(latest(tag)), () => 1000);
    assert.equal((await service.check()).state, expected); service.stop();
  }
  for (const invalid of [latest('v0.6.0', { draft: true }), latest('v0.6.0', { prerelease: true }),
    latest('v0.6.0-beta'), latest('v0.6.0', { html_url: 'https://evil.example/download.exe' }),
    latest('v0.6.0', { draft: undefined }), { message: 'private backend exception' }]) {
    const service = createUpdateService('0.5.0', async () => releaseResponse(invalid), () => 1000);
    const status = await service.check(); assert.equal(status.state, 'error'); assert.equal(status.url, undefined);
    assert.equal(JSON.stringify(status).includes('private backend exception'), false); service.stop();
  }
});

test('response body limit cancels oversized streaming content and rejects oversized declared length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
    cancel() { cancelled = true; } });
  const streamed = createUpdateService('0.5.0', async () => new Response(body, { status: 200 }), () => 1000);
  assert.equal((await streamed.check()).state, 'error'); assert.equal(cancelled, true); streamed.stop();
  const declared = createUpdateService('0.5.0', async () => releaseResponse(latest(), { 'content-length': String(512 * 1024 + 1) }), () => 1000);
  assert.equal((await declared.check()).state, 'error'); declared.stop();
  const malformed = createUpdateService('0.5.0', async () => new Response('{ bad JSON'), () => 1000);
  assert.equal((await malformed.check()).state, 'error'); malformed.stop();
});

test('offline errors are generic, short cooldown retries, rate-limit response defers to server headers', async () => {
  let time = 1000, calls = 0;
  const offline = createUpdateService('0.5.0', async () => { calls++; throw Error('private proxy password'); }, () => time);
  const failed = await offline.check(); assert.equal(failed.state, 'error'); assert.equal(failed.message.includes('private'), false);
  time += 9999; await offline.check(); assert.equal(calls, 1);
  time += 2; await offline.check(); assert.equal(calls, 2); offline.stop();
  for (const [code, headers, retryAt] of [
    [429, { 'retry-after': '120' }, time + 120000],
    [403, { 'x-ratelimit-reset': String((time + 180000) / 1000) }, time + 180000],
    [429, { 'retry-after': '99999999' }, time + 86400000],
  ]) {
    let count = 0;
    const service = createUpdateService('0.5.0', async () => { count++; return new Response(null, { status: code, headers }); }, () => time);
    const status = await service.check(); assert.equal(status.state, 'rate-limited'); assert.equal(status.retryAt, retryAt);
    await service.check(); assert.equal(count, 1); service.stop();
  }
});

test('stop aborts in-flight check without exposing native errors', async () => {
  let signal;
  const service = createUpdateService('0.5.0', (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal; signal.addEventListener('abort', () => reject(new Error('private network detail')), { once: true });
  }), () => 1000);
  const checking = service.check(); assert.equal(signal.aborted, false); service.stop(); assert.equal(signal.aborted, true);
  const status = await checking; assert.equal(status.state, 'error'); assert.equal(status.message.includes('private'), false);
});
