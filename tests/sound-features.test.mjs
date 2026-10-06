import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { build, transform } from 'esbuild';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(workspace, 'research', 'public-frontend', 'pinned-entry.js');
const hasFixture = existsSync(fixturePath);
const privateFixtureTest = (name, run) => test(name, { skip: !hasFixture && 'Private pinned vendor fixture is not distributed' }, run);
const sourcePath = path.join(workspace, 'src', 'main', 'sound-features.ts');
const bundle = await build({ entryPoints: [sourcePath], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22' });
const soundFeatures = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const actions = {
  voiceJoin: '/sounds/space/voice_join_2.mp3', voiceLeave: '/sounds/space/voice_leave_2.mp3',
  userLeave: '/sounds/space/voice_another_leave_2.mp3', mute: '/sounds/space/mute_3.mp3',
  unmute: '/sounds/space/unmute_3.mp3', soundDisable: '/sounds/space/sound_disable_3.mp3',
  soundEnable: '/sounds/space/sound_enable_2.mp3', cameraDisable: '/sounds/space/camera_disable.mp3',
  cameraEnable: '/sounds/space/camera_enable.mp3', radioActivation: '/sounds/space/radio_activation.mp3',
  radioDeactivation: '/sounds/space/radio_deactivation.mp3', messageSound: '/sounds/space/message.mp3',
  outgoingCall: '/sounds/space/outcoming_call_3.mp3', incomingCall: '/sounds/space/incoming_call_3.mp3',
  screenShareStarted: '/sounds/space/screenshare_started.mp3', screenShareStopped: '/sounds/space/screenshare_stopped_2.mp3',
};

function makeAudioClass(options = {}) {
  return class FakeAudio {
    constructor(src = '') { this.src = src; this.paused = true; this.volume = 1; this.loop = false; this.currentTime = 0; this.listeners = new Map(); }
    addEventListener(name, callback) { const callbacks = this.listeners.get(name) ?? []; callbacks.push(callback); this.listeners.set(name, callbacks); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== callback)); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {
      if (options.delayAudio) { options.pendingAudio = this; return; }
      queueMicrotask(() => { for (const callback of this.listeners.get('canplaythrough') ?? []) callback(); });
    }
    signal(name) { for (const callback of this.listeners.get(name) ?? []) callback(); }
    setSinkId(device) { this.device = device; return Promise.resolve(); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
}

function runtimeContext(injection, options = {}) {
  const Audio = makeAudioClass(options);
  const sounds = new Map(Object.values(actions).map(url => [url, new Audio(url)]));
  const soundUrls = new Map(Object.values(actions).map(url => [url, url]));
  const manager = {
    sounds, soundUrls, playingLoopSounds: new Map(), output: 'speaker-a', previewAudio: null,
    async preloadSounds() { await options.preloadSounds?.(); },
    async preloadAudio(url) { return new Audio(url); },
    getCurrentOutputDevice() { return this.output; },
    play(key, volume = 0.5, loop = false) {
      if (loop) {
        this.stop(key);
        const audio = this.sounds.get(key);
        if (!audio) return;
        audio.currentTime = 0; audio.volume = volume; audio.loop = true; this.playingLoopSounds.set(key, audio); audio.play();
      } else {
        const audio = new Audio(this.soundUrls.get(key) ?? key); audio.volume = volume; audio.play(); this.lastOneShot = audio;
      }
    },
    preview(key, volume = 0.5) { this.previewAudio = new Audio(this.soundUrls.get(key) ?? key); this.previewAudio.volume = volume; this.previewAudio.play(); },
    stopPreview() { this.previewAudio?.pause(); this.previewAudio = null; },
    stop(key) { const audio = this.playingLoopSounds.get(key); if (audio) { audio.pause(); this.playingLoopSounds.delete(key); } },
  };
  const modules = { register(name, api, hash) { this.name = name; this.api = api; this.hash = hash; } };
  const enabled = Object.fromEntries(Object.keys(actions).map(id => [id, true]));
  const context = {
    $a: actions, Hl: manager, Sg: { getState: () => ({ allSoundsMuted: false }) }, Qh: id => enabled[id] === true,
    globalThis: { location: { origin: 'https://lolka.app' }, URL, setTimeout, clearTimeout, LolkaMod: { modules } },
    location: { origin: 'https://lolka.app' }, URL, Audio, setTimeout, clearTimeout, queueMicrotask,
  };
  vm.runInNewContext(injection, context);
  return { api: modules.api, manager, sounds, soundUrls, enabled, Audio };
}

function injectionFrom(body) {
  const start = body.indexOf(';(() => {\n  const __lmSoundActions');
  assert.notEqual(start, -1, 'sound contract should be appended');
  return body.slice(start);
}

privateFixtureTest('pinned entry exposes one atomic, structurally checked SoundEffects contract', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const result = soundFeatures.transformSoundFeatures(source, 'fixture-hash');
  assert.equal(result.changed, true, result.reason);
  assert.deepEqual(result.features, { sounds: 'available' });
  assert.match(result.body, /modules\.register\("SoundEffects"/);
  assert.match(result.body, /"fixture-hash"/);
  assert.equal((result.body.match(/defaultUrl:/g) ?? []).length, 1);
});

privateFixtureTest('sound bindings rebind after minifier renames private identifiers', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const renamed = (await transform(source, { loader: 'js', minifyIdentifiers: true, minifySyntax: false,
    minifyWhitespace: false })).code;
  const result = soundFeatures.transformSoundFeatures(renamed, 'renamed-fixture');
  assert.equal(result.changed, true, result.reason);
  assert.match(result.body, /modules\.register\("SoundEffects"/);
  assert.ok(result.body.includes('"renamed-fixture"'));
});

privateFixtureTest('missing, duplicate, and incomplete sound contracts leave input byte-for-byte unchanged', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const cases = [
    source.replace('/sounds/space/message.mp3', '/sounds/space/message-v2.mp3'),
    `${source}\n${source.slice(source.indexOf('$a={voiceJoin:'), source.indexOf('},npt=') + 1)};`,
    'export const publicRelease = true;\r\n',
  ];
  for (const input of cases) {
    const result = soundFeatures.transformSoundFeatures(input, 'fixture-hash');
    assert.equal(result.changed, false);
    assert.equal(result.body, input);
    assert.deepEqual(result.features, { sounds: 'unsupported' });
  }
});

test('unknown synthetic source remains unchanged without a private vendor fixture', () => {
  const input = 'export const publicRelease = true;\r\n';
  const result = soundFeatures.transformSoundFeatures(input, 'fixture-hash');
  assert.equal(result.changed, false);
  assert.equal(result.body, input);
  assert.deepEqual(result.features, { sounds: 'unsupported' });
});

privateFixtureTest('sparse blob overlays only affect synchronous play/preview reads and clear preserves native edits', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const result = soundFeatures.transformSoundFeatures(source, 'fixture-hash');
  const { api, manager, sounds, soundUrls } = runtimeContext(injectionFrom(result.body));
  const originalPlay = manager.play, originalPreview = manager.preview;
  const playMap = manager.sounds, urlMap = manager.soundUrls;
  assert.equal(api.snapshot().actions.length, 16);
  assert.equal(api.snapshot().allSoundsMuted, false);

  await api.overlay({ messageSound: 'blob:https://lolka.app/discord-message' });
  assert.notStrictEqual(manager.play, originalPlay);
  assert.notStrictEqual(manager.preview, originalPreview);
  assert.strictEqual(manager.sounds, playMap);
  assert.strictEqual(manager.soundUrls, urlMap);
  manager.play(actions.messageSound);
  assert.equal(manager.lastOneShot.src, 'blob:https://lolka.app/discord-message');
  api.preview('messageSound', 0);
  assert.equal(manager.previewAudio.src, 'blob:https://lolka.app/discord-message');
  assert.equal(manager.previewAudio.volume, 0);
  const overlayPreview = manager.previewAudio;
  assert.throws(() => api.preview('messageSound', -0.01), /between 0 and 1/);
  assert.throws(() => api.preview('messageSound', Number.NaN), /between 0 and 1/);

  const custom = new (makeAudioClass())('blob:https://lolka.app/native-custom');
  manager.sounds.set(actions.messageSound, custom);
  manager.soundUrls.set(actions.messageSound, custom.src);
  manager.play(actions.messageSound);
  assert.equal(manager.lastOneShot.src, 'blob:https://lolka.app/discord-message');
  api.clear();
  assert.strictEqual(manager.play, originalPlay);
  assert.strictEqual(manager.preview, originalPreview);
  assert.strictEqual(manager.sounds, playMap);
  assert.strictEqual(manager.soundUrls, urlMap);
  assert.strictEqual(manager.sounds.get(actions.messageSound), custom);
  assert.equal(manager.soundUrls.get(actions.messageSound), custom.src);
  assert.strictEqual(manager.sounds.get(actions.voiceJoin), sounds.get(actions.voiceJoin));
  assert.equal(api.snapshot().overlayActive, false);
  assert.equal(overlayPreview.paused, true);
  assert.equal(manager.previewAudio, null);
});

privateFixtureTest('overlay keeps native loop stop/volume behavior and restart on replacement or clear', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const result = soundFeatures.transformSoundFeatures(source, 'fixture-hash');
  const { api, manager } = runtimeContext(injectionFrom(result.body));
  await api.overlay({ incomingCall: 'blob:https://lolka.app/discord-call-a' });
  manager.play(actions.incomingCall, 0.35, true);
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).src, 'blob:https://lolka.app/discord-call-a');
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).volume, 0.35);
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).loop, true);
  await api.overlay({ incomingCall: 'blob:https://lolka.app/discord-call-b' });
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).src, 'blob:https://lolka.app/discord-call-b');
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).volume, 0.35);
  manager.stop(actions.incomingCall);
  assert.equal(manager.playingLoopSounds.has(actions.incomingCall), false);
  manager.play(actions.incomingCall, 0.35, true);
  api.clear();
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).src, actions.incomingCall);
  assert.equal(manager.playingLoopSounds.get(actions.incomingCall).volume, 0.35);
});

privateFixtureTest('inactive clear preserves native previews and active loops; cache-miss clear stops old overlay loops', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const result = soundFeatures.transformSoundFeatures(source, 'fixture-hash');
  const { api, manager } = runtimeContext(injectionFrom(result.body));
  const nativePreview = (manager.preview(actions.messageSound), manager.previewAudio);
  manager.play(actions.incomingCall, 0.4, true);
  const nativeLoop = manager.playingLoopSounds.get(actions.incomingCall);
  const originalPlay = manager.play;
  api.clear();
  assert.strictEqual(manager.play, originalPlay);
  assert.strictEqual(manager.previewAudio, nativePreview);
  assert.equal(nativePreview.paused, false);
  assert.strictEqual(manager.playingLoopSounds.get(actions.incomingCall), nativeLoop);
  assert.equal(nativeLoop.paused, false);

  await api.overlay({ incomingCall: 'blob:https://lolka.app/discord-call' });
  manager.play(actions.incomingCall, 0.4, true);
  const overlayLoop = manager.playingLoopSounds.get(actions.incomingCall);
  manager.sounds.delete(actions.incomingCall);
  api.clear();
  assert.equal(overlayLoop.paused, true);
  assert.equal(manager.playingLoopSounds.has(actions.incomingCall), false);
});

privateFixtureTest('wrapper preflight rolls back the first hook when the second assignment throws', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const result = soundFeatures.transformSoundFeatures(source, 'fixture-hash');
  const { api, manager } = runtimeContext(injectionFrom(result.body));
  const originalPlay = manager.play, originalPreview = manager.preview;
  Object.defineProperty(manager, 'preview', { configurable: true, get: () => originalPreview, set: () => { throw new Error('blocked'); } });
  await assert.rejects(api.overlay({ messageSound: 'blob:https://lolka.app/discord-message' }), /blocked/);
  assert.strictEqual(manager.play, originalPlay);
  assert.strictEqual(manager.preview, originalPreview);
  assert.equal(api.snapshot().overlayActive, false);
});

privateFixtureTest('clear cancels pending loads; invalid IDs and foreign blob origins are rejected', async () => {
  const source = await fs.readFile(fixturePath, 'utf8');
  const result = soundFeatures.transformSoundFeatures(source, 'fixture-hash');
  const options = { delayAudio: true };
  const { api, manager } = runtimeContext(injectionFrom(result.body), options);
  const originalPlay = manager.play;
  const pending = api.overlay({ voiceJoin: 'blob:https://lolka.app/join' });
  assert.ok(options.pendingAudio);
  api.clear();
  await assert.rejects(pending, /superseded/);
  await assert.rejects(api.overlay({ madeUp: 'blob:https://lolka.app/x' }), /Unknown sound action/);
  await assert.rejects(api.overlay({ voiceJoin: 'blob:https://other.example/x' }), /local blobs/);
  assert.equal(manager.soundUrls.get(actions.voiceJoin), actions.voiceJoin);
  assert.strictEqual(manager.play, originalPlay);
  assert.equal(api.snapshot().overlayActive, false);
});
