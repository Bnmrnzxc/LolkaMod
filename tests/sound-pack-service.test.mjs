import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(workspace, 'src', 'main', 'sound-pack-service.ts');
const bundle = await build({ entryPoints: [sourcePath], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22' });
const serviceModule = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const bytes = Buffer.from('ID3\x04\x00\x00sound fixture');
const url = 'https://cdn.discordapp.com/assets/sound_fixture.mp3';
const spec = (overrides = {}) => ({
  key: 'voice_join', url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mimeType: 'audio/mpeg', ...overrides,
});
const response = (body = bytes, headers = { 'content-type': 'application/octet-stream' }, status = 200) => new Response(body, { status, headers });

async function withCache(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-sound-pack-'));
  const directory = path.join(root, 'cache');
  try { await callback(directory); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('first load downloads verified MP3 and subsequent load uses the hash-pinned cache', async () => {
  await withCache(async (directory) => {
    let calls = 0;
    const service = serviceModule.createSoundPackService(directory, [spec()], { fetcher: async () => { calls++; return response(); } });
    assert.deepEqual(service.status(), { state: 'idle' });
    const loaded = await service.load();
    assert.deepEqual(service.status(), { state: 'ready' });
    const snapshot = service.status(); snapshot.state = 'error'; snapshot.code = 'network';
    assert.deepEqual(service.status(), { state: 'ready' }, 'status returns a defensive snapshot');
    assert.equal(loaded.id, 'discord');
    assert.deepEqual(loaded.assets, [{ key: 'voice_join', mimeType: 'audio/mpeg', base64: bytes.toString('base64') }]);
    const cacheFile = path.join(directory, `voice_join-${spec().sha256}.mp3`);
    assert.deepEqual(await fs.readFile(cacheFile), bytes);
    loaded.assets[0].base64 = 'mutated';
    assert.equal((await service.load()).assets[0].base64, bytes.toString('base64'));
    assert.equal(calls, 1);
    service.stop();
  });
});

test('bad checksum is rejected and does not create a cache file', async () => {
  await withCache(async (directory) => {
    const wrong = spec({ sha256: '0'.repeat(64) });
    const service = serviceModule.createSoundPackService(directory, [wrong], { fetcher: async () => response() });
    await assert.rejects(service.load(), /checksum mismatch/);
    assert.deepEqual(service.status(), { state: 'error', stage: 'verify', asset: 'voice_join', code: 'checksum' });
    await assert.rejects(fs.readdir(directory), { code: 'ENOENT' });
    service.stop();
  });
});

test('corrupt cache refetches, while valid offline cache remains usable', async () => {
  await withCache(async (directory) => {
    await fs.mkdir(directory, { recursive: true });
    const cacheFile = path.join(directory, `voice_join-${spec().sha256}.mp3`);
    await fs.writeFile(cacheFile, Buffer.from('ID3bad'));
    let calls = 0;
    const service = serviceModule.createSoundPackService(directory, [spec()], { fetcher: async () => { calls++; return response(); } });
    await service.load();
    assert.equal(calls, 1);
    service.stop();

    const offline = serviceModule.createSoundPackService(directory, [spec()], { fetcher: async () => { throw new Error('network should not run'); } });
    assert.equal((await offline.load()).assets[0].base64, bytes.toString('base64'));
    assert.deepEqual(offline.status(), { state: 'ready' });
    offline.stop();
  });
});

test('request timeout records a safe download status without exposing the fetch error', async () => {
  await withCache(async (directory) => {
    const service = serviceModule.createSoundPackService(directory, [spec()], {
      timeoutMs: 5,
      fetcher: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('proxy password: private-value')), { once: true });
      }),
    });
    await assert.rejects(service.load(), /timed out/);
    assert.deepEqual(service.status(), { state: 'error', stage: 'download', asset: 'voice_join', code: 'timeout' });
    assert.equal(JSON.stringify(service.status()).includes('private-value'), false);
    service.stop();
  });
});

test('HTTP failure status is recorded without response details', async () => {
  await withCache(async (directory) => {
    const service = serviceModule.createSoundPackService(directory, [spec()], {
      fetcher: async () => new Response('private response body', { status: 503, headers: { 'x-private-header': 'secret' } }),
    });
    await assert.rejects(service.load(), /status 503/);
    assert.deepEqual(service.status(), { state: 'error', stage: 'download', asset: 'voice_join', code: 'http', httpStatus: 503 });
    assert.equal(JSON.stringify(service.status()).includes('secret'), false);
    service.stop();
  });
});

test('a later parallel asset completion cannot replace the aggregate failure status', async () => {
  await withCache(async (directory) => {
    let resolveSecond;
    let calls = 0;
    let markSecondStarted;
    const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
    const assets = [
      spec({ key: 'first', url: 'https://cdn.discordapp.com/assets/first.mp3' }),
      spec({ key: 'second', url: 'https://cdn.discordapp.com/assets/second.mp3' }),
    ];
    const service = serviceModule.createSoundPackService(directory, assets, {
      fetcher: async (requestUrl) => {
        calls++;
        if (new URL(requestUrl).pathname.endsWith('first.mp3')) throw new Error('network unavailable');
        return new Promise((resolve) => { resolveSecond = resolve; markSecondStarted(); });
      },
    });
    const pending = service.load();
    await secondStarted;
    await assert.rejects(pending, /network unavailable/);
    assert.equal(calls, 2);
    assert.deepEqual(service.status(), { state: 'error', stage: 'download', asset: 'first', code: 'network' });
    resolveSecond(response());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(service.status(), { state: 'error', stage: 'download', asset: 'first', code: 'network' });
    service.stop();
  });
});

test('oversized response body is stopped before it can be cached', async () => {
  await withCache(async (directory) => {
    const expected = spec({ bytes: 6 });
    const service = serviceModule.createSoundPackService(directory, [expected], {
      fetcher: async () => response(Buffer.from('ID3way-too-long')),
    });
    await assert.rejects(service.load(), /exceeds expected size/);
    await assert.rejects(fs.readdir(directory), { code: 'ENOENT' });
    service.stop();
  });
});

test('catalog URLs and redirects are restricted to approved Discord MP3 paths', async () => {
  await withCache(async (directory) => {
    for (const badUrl of [
      'http://cdn.discordapp.com/assets/a.mp3',
      'https://cdn.discordapp.com:8443/assets/a.mp3',
      'https://user@cdn.discordapp.com/assets/a.mp3',
      'https://cdn.discordapp.com/assets/a.mp3?x=1',
      'https://discord.com/not-assets/a.mp3',
      'https://example.org/assets/a.mp3',
    ]) {
      assert.throws(() => serviceModule.createSoundPackService(directory, [spec({ url: badUrl })]), /URL/);
    }
    const sparseCatalog = new Array(1);
    assert.throws(() => serviceModule.createSoundPackService(directory, sparseCatalog), /catalog/);
    let calls = 0;
    const service = serviceModule.createSoundPackService(directory, [spec()], {
      fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.org/assets/evil.mp3' } }); },
    });
    await assert.rejects(service.load(), /approved Discord CDN paths/);
    assert.equal(calls, 1);
    service.stop();
  });
});

test('loads coalesce, failed loads can retry, and stop aborts an active request', async () => {
  await withCache(async (directory) => {
    let calls = 0;
    const service = serviceModule.createSoundPackService(directory, [spec()], { fetcher: async () => { calls++; return response(); } });
    const [a, b] = await Promise.all([service.load(), service.load()]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    service.stop();

    let attempts = 0;
    const retry = serviceModule.createSoundPackService(path.join(directory, 'retry'), [spec()], {
      fetcher: async () => { attempts++; if (attempts === 1) throw new Error('temporary'); return response(); },
    });
    await assert.rejects(retry.load(), /temporary/);
    assert.equal((await retry.load()).assets.length, 1);
    assert.equal(attempts, 2);
    retry.stop();

    let observedAbort;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const cancelled = serviceModule.createSoundPackService(path.join(directory, 'cancel'), [spec()], {
      fetcher: (_url, init) => new Promise((_resolve, reject) => {
        observedAbort = init.signal;
        markStarted();
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    const pending = cancelled.load();
    await started;
    cancelled.stop();
    await assert.rejects(pending, /aborted|stopped/);
    assert.equal(observedAbort.aborted, true);
    await assert.rejects(fs.access(path.join(directory, 'cancel')), { code: 'ENOENT' });
    await assert.rejects(cancelled.load(), /stopped/);
  });
});
