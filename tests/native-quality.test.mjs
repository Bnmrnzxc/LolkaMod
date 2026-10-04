import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  applyPatchGroup,
  nativeProfileReference,
  nativeQualityPatches,
} from '../dist/source-adapter.mjs';

const fixturePath = 'research/public-frontend/pinned-entry.js';

function findPositions(source, needle) {
  const positions = [];
  let offset = 0;
  while (true) {
    const found = source.indexOf(needle, offset);
    if (found < 0) return positions;
    positions.push(found);
    offset = found + 1;
  }
}

function makeStorage(values) {
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    localStorage: {
      getItem(key) {
        reads.push(key);
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem(...args) { writes.push(args); },
    },
  };
}

function readNativeProfile(values) {
  const storage = makeStorage(values);
  const context = vm.createContext({ localStorage: storage.localStorage });
  vm.runInContext(`${nativeProfileReference}\nglobalThis.result = __lmStockProfile();`, context);
  return {
    profile: JSON.parse(JSON.stringify(context.result)),
    reads: storage.reads,
    writes: storage.writes,
  };
}

test('native quality patch group is atomic when a later anchor is absent or duplicated', () => {
  assert.ok(nativeQualityPatches.length > 1);
  const missingSource = nativeQualityPatches
    .slice(0, -1)
    .map(patch => `prefix:${patch.find}:suffix`)
    .join('\n');
  const missingResult = applyPatchGroup(missingSource, nativeQualityPatches);
  assert.equal(missingResult.changed, false);
  assert.equal(missingResult.failedPatch, nativeQualityPatches[nativeQualityPatches.length - 1].id);
  assert.deepEqual(missingResult.applied, []);
  assert.equal(missingResult.body, missingSource);

  const duplicateSource = nativeQualityPatches
    .map(patch => `prefix:${patch.find}:suffix`)
    .concat(`duplicate:${nativeQualityPatches[nativeQualityPatches.length - 1].find}`)
    .join('\n');
  const duplicateResult = applyPatchGroup(duplicateSource, nativeQualityPatches);
  assert.equal(duplicateResult.changed, false);
  assert.equal(duplicateResult.failedPatch, nativeQualityPatches[nativeQualityPatches.length - 1].id);
  assert.deepEqual(duplicateResult.applied, []);
  assert.equal(duplicateResult.body, duplicateSource);
});

test('native stock-profile helper uses safe defaults, only regular stream keys, and no LM override', () => {
  const defaults = readNativeProfile({ lolkamodProfile: { resolution: '1440p', fps: 60, codec: 'av1' } });
  assert.deepEqual(defaults.profile, { resolution: '720p', fps: 30, codec: 'vp9' });
  assert.deepEqual(defaults.reads, ['screenShareResolution', 'screenShareFps', 'screenShareCodecV3']);
  assert.deepEqual(defaults.writes, []);

  const valid = readNativeProfile({
    screenShareResolution: '1440p',
    screenShareFps: '60',
    screenShareCodecV3: 'av1',
    lolkamodProfile: { resolution: '720p', fps: 15, codec: 'h264' },
    'screenShareResolution.native': '720p',
  });
  assert.deepEqual(valid.profile, { resolution: '1440p', fps: 60, codec: 'av1' });
  assert.deepEqual(valid.reads, ['screenShareResolution', 'screenShareFps', 'screenShareCodecV3']);
  assert.deepEqual(valid.writes, []);

  for (const resolution of ['720p', '1080p', '1440p']) {
    for (const fps of ['30', '60']) {
      for (const codec of ['vp8', 'vp9', 'h264', 'av1']) {
        const result = readNativeProfile({
          screenShareResolution: resolution,
          screenShareFps: fps,
          screenShareCodecV3: codec,
        });
        assert.deepEqual(result.profile, { resolution, fps: Number(fps), codec });
        assert.deepEqual(result.reads, ['screenShareResolution', 'screenShareFps', 'screenShareCodecV3']);
        assert.deepEqual(result.writes, []);
      }
    }
  }

  const invalid = readNativeProfile({
    screenShareResolution: '2160p',
    screenShareFps: '120',
    screenShareCodecV3: 'unsupported-codec',
  });
  assert.deepEqual(invalid.profile, { resolution: '720p', fps: 30, codec: 'vp9' });
  assert.deepEqual(invalid.reads, ['screenShareResolution', 'screenShareFps', 'screenShareCodecV3']);
  assert.deepEqual(invalid.writes, []);

  const throwingStorage = makeStorage({});
  throwingStorage.localStorage.getItem = () => { throw new Error('storage unavailable'); };
  const throwingContext = vm.createContext({ localStorage: throwingStorage.localStorage });
  vm.runInContext(`${nativeProfileReference}\nglobalThis.result = __lmStockProfile();`, throwingContext);
  assert.deepEqual(JSON.parse(JSON.stringify(throwingContext.result)), { resolution: '720p', fps: 30, codec: 'vp9' });
  assert.deepEqual(throwingStorage.writes, []);
});

test('patched vendor picker helpers expose 720/1080/1440 and 30/60 without reading gates', {
  skip: !existsSync(fixturePath),
}, () => {
  const original = readFileSync(fixturePath, 'utf8');
  const patched = applyPatchGroup(original, nativeQualityPatches);
  assert.equal(patched.changed, true);

  const resolutionSource = patched.body.match(/function \$tr\(e,t,n=0\)\{[^}]*\}/g) ?? [];
  const fpsSource = patched.body.match(/function Btr\(e,t,n=0\)\{[^}]*\}/g) ?? [];
  assert.equal(resolutionSource.length, 1);
  assert.equal(fpsSource.length, 1);

  const context = vm.createContext({});
  vm.runInContext(`const my="720p",xg="1080p",vR="1440p",Q1=30,uM=60;\n${resolutionSource[0]}\n${fpsSource[0]}\nglobalThis.helpers=[$tr,Btr];`, context);
  const helpers = context.helpers;
  for (const serverLevel of [0, 1, 2, 3, 4, 10, 100]) {
    assert.deepEqual(Array.from(helpers[0](false, false, serverLevel)), ['720p', '1080p', '1440p']);
    assert.deepEqual(Array.from(helpers[1](false, false, serverLevel)), ['30', '60']);
  }
});

test('patched browser capture consumes saved native profile and preserves capture/audio inputs', {
  skip: !existsSync(fixturePath),
}, async () => {
  const original = readFileSync(fixturePath, 'utf8');
  const patched = applyPatchGroup(original, nativeQualityPatches);
  assert.equal(patched.changed, true);

  const start = 'Tyt=async(e,t,n)=>';
  const startPositions = findPositions(patched.body, start);
  assert.equal(startPositions.length, 1);
  const startAt = startPositions[0];
  const endAt = patched.body.indexOf('},Myt=', startAt);
  assert.ok(endAt > startAt && endAt - startAt < 2_000);
  const captureFunction = patched.body.slice(startAt + 'Tyt='.length, endAt + 1);
  const storage = makeStorage({
    screenShareResolution: '1440p',
    screenShareFps: '60',
    screenShareCodecV3: 'vp9',
    lolkamodProfile: { resolution: '720p', fps: 15, codec: 'h264' },
  });
  const calls = [];
  const map = {
    '720p': { width: 1280, height: 720, freeBitrate: 6_000_000 },
    '1080p': { width: 1920, height: 1080, freeBitrate: 10_000_000 },
    '1440p': { width: 2560, height: 1440, freeBitrate: 16_000_000 },
  };
  const context = vm.createContext({
    localStorage: storage.localStorage,
    mS: map,
    _xe: value => value,
    wxe: async value => { calls.push(value); },
  });
  vm.runInContext(`${nativeProfileReference}\nglobalThis.testCapture = ${captureFunction};`, context);

  const response = { marker: 'response' };
  const videoTrack = { getSettings: () => ({ displaySurface: 'window' }) };
  const audioTrack = { marker: 'audio-track' };
  const ownedTracks = [videoTrack, audioTrack];
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
    getTracks: () => ownedTracks,
  };
  await context.testCapture(response, stream, 'channel-one');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resolution, '1440p');
  assert.equal(calls[0].maxWidth, 2560);
  assert.equal(calls[0].maxHeight, 1440);
  assert.equal(calls[0].fps, 60);
  assert.equal(calls[0].codec, 'vp9');
  assert.equal(calls[0].targetBitrate, 16_000_000);
  assert.strictEqual(calls[0].response, response);
  assert.strictEqual(calls[0].videoTrack, videoTrack);
  assert.strictEqual(calls[0].audioTrack, audioTrack);
  assert.strictEqual(calls[0].ownedTracks, ownedTracks);
  assert.equal(calls[0].voiceChannelId, 'channel-one');
  assert.equal(calls[0].capture, 'window');

  storage.localStorage.getItem = key => {
    storage.reads.push(key);
    return ({ screenShareResolution: '720p', screenShareFps: '30', screenShareCodecV3: 'av1' })[key] ?? null;
  };
  const screenTrack = { getSettings: () => ({ displaySurface: 'monitor' }) };
  const screenStream = {
    getVideoTracks: () => [screenTrack],
    getAudioTracks: () => [],
    getTracks: () => [screenTrack],
  };
  await context.testCapture(response, screenStream, 'channel-two');

  assert.equal(calls.length, 2);
  assert.equal(calls[1].resolution, '720p');
  assert.equal(calls[1].maxWidth, 1280);
  assert.equal(calls[1].maxHeight, 720);
  assert.equal(calls[1].fps, 30);
  assert.equal(calls[1].codec, 'av1');
  assert.equal(calls[1].targetBitrate, 6_000_000);
  assert.strictEqual(calls[1].response, response);
  assert.strictEqual(calls[1].videoTrack, screenTrack);
  assert.equal(calls[1].audioTrack, null);
  assert.deepEqual(Array.from(calls[1].ownedTracks), [screenTrack]);
  assert.equal(calls[1].voiceChannelId, 'channel-two');
  assert.equal(calls[1].capture, 'screen');
  assert.deepEqual(storage.writes, []);
});

test('patched live quality updates dimensions, frame rate, bitrate and recreates codec producer', {
  skip: !existsSync(fixturePath),
}, async () => {
  const original = readFileSync(fixturePath, 'utf8');
  const patched = applyPatchGroup(original, nativeQualityPatches);
  assert.equal(patched.changed, true);

  const start = 'lgt=async e=>';
  const positions = findPositions(patched.body, start);
  assert.equal(positions.length, 1);
  const startAt = positions[0];
  const endAt = patched.body.indexOf(',FZ=', startAt);
  assert.ok(endAt > startAt && endAt - startAt < 2_000);
  const liveUpdate = patched.body.slice(startAt + 'lgt='.length, endAt);

  const updates = [];
  const produced = [];
  const producer = name => ({ close() { updates.push({ producerClosed: name }); } });
  const state = {
    videoConstraints: { width: { max: 2560 }, height: { max: 1440 }, frameRate: { min: 30, ideal: 60, max: 60 } },
    videoTrack: { async applyConstraints(value) { updates.push({ constraints: value }); } },
    videoProducer: producer('initial'),
    sendTransport: {
      async produce(options) {
        produced.push(options);
        return producer('replacement-' + produced.length);
      },
    },
    device: { rtpCapabilities: { codecs: [{ mimeType: 'video/VP9' }, { mimeType: 'video/AV1' }, { mimeType: 'video/VP8' }] } },
    settings: { resolution: '1440p', fps: 60, bitrate: 16_000_000, codec: 'vp9' },
  };
  const initialProducer = state.videoProducer;
  const context = vm.createContext({
    fi: state,
    ngt: async (_producer, fps) => { updates.push({ fps }); },
    tgt: async (_producer, bitrate) => { updates.push({ bitrate }); },
    W2e: bitrate => ({ targetBitrate: bitrate }),
    H2e: (_device, codec) => ({ mimeType: 'video/' + codec }),
    V2e: async _producer => {},
  });
  vm.runInContext(`globalThis.update = ${liveUpdate};`, context);

  const presets = [
    { width: 2560, height: 1440, fps: 60, bitrate: 16_000_000, codec: 'vp9', resolution: '1440p' },
    { width: 1280, height: 720, fps: 30, bitrate: 6_000_000, codec: 'av1', resolution: '720p' },
    { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, codec: 'vp8', resolution: '1080p' },
  ];
  for (let i = 0; i < presets.length; i++) {
    const result = await context.update(presets[i]);
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse(JSON.stringify(state.videoConstraints)), {
      width: { max: presets[i].width },
      height: { max: presets[i].height },
      frameRate: { min: 30, ideal: presets[i].fps, max: presets[i].fps },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(state.settings)), {
      resolution: presets[i].resolution,
      fps: presets[i].fps,
      bitrate: presets[i].bitrate,
      codec: presets[i].codec,
    });
    assert.ok(updates.some(update => update.fps === presets[i].fps));
    assert.ok(updates.some(update => update.bitrate === presets[i].bitrate));
    assert.equal(produced.length, i);
    if (i === 0) {
      assert.strictEqual(state.videoProducer, initialProducer);
      continue;
    }
    const producerOptions = produced[i - 1];
    assert.equal(producerOptions.encodings[0].maxFramerate, presets[i].fps);
    assert.equal(producerOptions.encodings[0].maxBitrate, presets[i].bitrate);
    assert.equal(producerOptions.codec.mimeType, 'video/' + presets[i].codec);
    assert.equal(producerOptions.stopTracks, false);
    assert.deepEqual(JSON.parse(JSON.stringify(producerOptions.appData)), { source: 'screen' });
  }
});
