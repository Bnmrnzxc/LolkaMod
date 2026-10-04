import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProfile } from '../dist/settings.mjs';
import { constraintsFor, DIMENSIONS, encodingsFor, installStreamQuality } from '../dist/stream-quality.mjs';

class FakeObservers {
  tracks = new Set();
  peers = new Set();
  trackObservers = new Set();
  peerObservers = new Set();

  observeDisplayTracks(callback) {
    this.trackObservers.add(callback);
    for (const track of this.tracks) callback(track);
    return () => this.trackObservers.delete(callback);
  }
  observePeerConnections(callback) {
    this.peerObservers.add(callback);
    for (const pc of this.peers) callback(pc);
    return () => this.peerObservers.delete(callback);
  }
  addTrack(track) {
    this.tracks.add(track);
    for (const callback of this.trackObservers) callback(track);
  }
  addPeer(pc) {
    this.peers.add(pc);
    for (const callback of this.peerObservers) callback(pc);
  }
}

class FakeTrack {
  kind;
  readyState = 'live';
  calls = [];
  listeners = new Map();
  stopCalls = 0;
  behavior = () => Promise.resolve('native-result');

  constructor(kind = 'video') { this.kind = kind; }
  applyConstraints(constraints) {
    this.calls.push(constraints);
    return this.behavior(constraints);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  stop() { this.stopCalls += 1; this.readyState = 'ended'; }
}

class FakeSender {
  track;
  params;
  originalSetParameters;
  parameterCalls = [];
  getParametersCalls = 0;
  setParameters = async function(params) {
    this.parameterCalls.push(params);
    return 'set-result';
  };

  constructor(track, encodings = [{ rid: 'f', scaleResolutionDownBy: 1 }]) {
    this.track = track;
    this.params = { encodings };
    this.originalSetParameters = this.setParameters;
  }
  getParameters() { this.getParametersCalls += 1; return this.params; }
}

class FakePeer {
  connectionState = 'connected';
  senders = [];
  listeners = new Map();
  closeCalls = 0;
  addTrackCalls = [];
  transceiverCalls = [];

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  addTrack(track, ...streams) {
    this.addTrackCalls.push([track, ...streams]);
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
  addTransceiver(track, init) {
    this.transceiverCalls.push([track, init]);
    const sender = new FakeSender(track, init.sendEncodings);
    this.senders.push(sender);
    return { sender, direction: init.direction };
  }
  getSenders() { return this.senders; }
  close() { this.closeCalls += 1; this.connectionState = 'closed'; }
}

const profile = { resolution: '1440p', fps: 30, codec: 'VP9', bitrateMbps: 16 };
const settings = (qualityEnabled = true, selected = profile) => () => ({ qualityEnabled, profile: selected });

test('dimensions and capture constraints represent 1440p without mutating caller constraints', () => {
  assert.deepEqual(DIMENSIONS['1440p'], [2560, 1440]);
  const original = { deviceId: { exact: 'camera-1' }, width: { min: 640 }, advanced: [{ aspectRatio: 1.7 }] };
  const saved = structuredClone(original);
  const result = constraintsFor(profile, original);

  assert.deepEqual(result.width, { ideal: 2560, max: 2560 });
  assert.deepEqual(result.height, { ideal: 1440, max: 1440 });
  assert.deepEqual(result.frameRate, { ideal: 30, max: 30 });
  assert.deepEqual(result.deviceId, original.deviceId);
  assert.deepEqual(original, saved);
  assert.notStrictEqual(result, original);
});

test('encoding bitrate is distributed by scale and preserves RID/scalability fields', () => {
  const original = [
    { rid: 'f', scaleResolutionDownBy: 1, scalabilityMode: 'L3T3_KEY', active: true },
    { rid: 'h', scaleResolutionDownBy: 2, scalabilityMode: 'L2T2', active: true },
  ];
  const saved = structuredClone(original);
  const adjusted = encodingsFor(profile, original);

  assert.equal(adjusted[0].maxBitrate, 16_000_000);
  assert.equal(adjusted[1].maxBitrate, 4_000_000);
  assert.equal(adjusted[0].maxFramerate, profile.fps);
  assert.equal(adjusted[1].maxFramerate, profile.fps);
  assert.equal(adjusted[0].rid, 'f');
  assert.equal(adjusted[0].scalabilityMode, 'L3T3_KEY');
  assert.equal(adjusted[1].rid, 'h');
  assert.deepEqual(original, saved);
  assert.notStrictEqual(adjusted, original);
  assert.notStrictEqual(adjusted[0], original[0]);
  assert.equal(encodingsFor(profile, [])[0].maxBitrate, 16_000_000);
});

test('disabled quality passes capture and sender calls through unchanged', async () => {
  const observers = new FakeObservers();
  const track = new FakeTrack();
  const pc = new FakePeer();
  const camera = new FakeTrack();
  const audio = new FakeTrack('audio');
  const quality = installStreamQuality(observers, settings(false));
  observers.addTrack(track);
  observers.addTrack(audio);
  observers.addPeer(pc);

  const requested = { width: { ideal: 700 }, frameRate: { max: 25 } };
  assert.equal(await track.applyConstraints(requested), 'native-result');
  assert.deepEqual(track.calls, [requested]);
  const screenSender = pc.addTrack(track, { id: 'private-stream' });
  const params = { encodings: [{ rid: 'x', maxBitrate: 900_000, maxFramerate: 24 }] };
  await screenSender.setParameters(params);
  assert.strictEqual(screenSender.parameterCalls[0], params);
  assert.deepEqual(params.encodings[0], { rid: 'x', maxBitrate: 900_000, maxFramerate: 24 });
  assert.equal(pc.addTrackCalls.length, 1);
  quality.stop();

  assert.equal(pc.listeners.get('connectionstatechange')?.size ?? 0, 0);
  assert.equal(quality.snapshot().activeTracks, 0);
});

test('enabled profile applies constraints and sender parameters only to observed display video', async () => {
  const observers = new FakeObservers();
  const screen = new FakeTrack();
  const camera = new FakeTrack();
  const audio = new FakeTrack('audio');
  const pc = new FakePeer();
  const quality = installStreamQuality(observers, settings(true));
  observers.addTrack(screen);

  assert.deepEqual(screen.calls[0].width, { ideal: 2560, max: 2560 });
  assert.deepEqual(screen.calls[0].height, { ideal: 1440, max: 1440 });
  assert.deepEqual(screen.calls[0].frameRate, { ideal: 30, max: 30 });
  assert.notStrictEqual(screen.applyConstraints, FakeTrack.prototype.applyConstraints);

  observers.addTrack(audio);
  const cameraConstraints = { width: { ideal: 640 } };
  await camera.applyConstraints(cameraConstraints);
  assert.strictEqual(camera.calls[0], cameraConstraints);
  assert.equal(audio.calls.length, 0);

  observers.addPeer(pc);
  const screenSender = pc.addTrack(screen, { id: 'private-stream' });
  const inputParameters = { encodings: [
    { rid: 'f', scaleResolutionDownBy: 1, scalabilityMode: 'L3T3_KEY', active: true },
    { rid: 'h', scaleResolutionDownBy: 2, scalabilityMode: 'L2T2', active: true },
  ], transactionId: 'private-transaction' };
  await screenSender.setParameters(inputParameters);
  const changed = screenSender.parameterCalls[0];
  assert.equal(changed.encodings[0].maxBitrate, 16_000_000);
  assert.equal(changed.encodings[1].maxBitrate, 4_000_000);
  assert.equal(changed.encodings[0].rid, 'f');
  assert.equal(changed.encodings[0].scalabilityMode, 'L3T3_KEY');
  assert.equal(changed.transactionId, 'private-transaction');
  assert.deepEqual(inputParameters, {
    encodings: [
      { rid: 'f', scaleResolutionDownBy: 1, scalabilityMode: 'L3T3_KEY', active: true },
      { rid: 'h', scaleResolutionDownBy: 2, scalabilityMode: 'L2T2', active: true },
    ],
    transactionId: 'private-transaction',
  });

  const cameraSender = pc.addTrack(camera);
  const cameraParams = { encodings: [{ rid: 'camera', maxBitrate: 500_000, scaleResolutionDownBy: 1 }] };
  await cameraSender.setParameters(cameraParams);
  assert.strictEqual(cameraSender.parameterCalls[0], cameraParams);

  const transceiverInput = { direction: 'sendonly', sendEncodings: [
    { rid: 'a', scaleResolutionDownBy: 1 },
    { rid: 'b', scaleResolutionDownBy: 2 },
  ] };
  const savedTransceiverInput = structuredClone(transceiverInput);
  const transceiver = pc.addTransceiver(screen, transceiverInput);
  assert.equal(transceiver.direction, 'sendonly');
  assert.equal(transceiverInput.sendEncodings[0].maxBitrate, undefined);
  assert.deepEqual(transceiverInput, savedTransceiverInput);
  assert.equal(pc.transceiverCalls[0][1].sendEncodings[0].maxBitrate, 16_000_000);
  assert.equal(pc.transceiverCalls[0][1].sendEncodings[1].maxBitrate, 4_000_000);

  quality.stop();
  assert.equal(quality.snapshot().activeTracks, 0);
});

test('empty getParameters encodings are not synthesized during initial application', async () => {
  const observers = new FakeObservers();
  const screen = new FakeTrack();
  const sender = new FakeSender(screen, []);
  const pc = new FakePeer();
  pc.senders = [sender];
  const quality = installStreamQuality(observers, settings(true));
  observers.addTrack(screen);
  observers.addPeer(pc);

  await new Promise(resolve => setTimeout(resolve, 1_050));
  assert.equal(sender.getParametersCalls, 1);
  assert.equal(sender.parameterCalls.length, 0);
  assert.deepEqual(sender.params.encodings, []);
  quality.stop();
});

test('native constraint errors propagate, with only OverconstrainedError falling back once', async () => {
  const observers = new FakeObservers();
  const screen = new FakeTrack();
  const quality = installStreamQuality(observers, settings(true));
  observers.addTrack(screen);
  const original = { width: { exact: 1280 }, height: { exact: 720 } };

  let fallbackCalls = 0;
  const overconstrained = new Error('not supported by device');
  overconstrained.name = 'OverconstrainedError';
  screen.behavior = constraints => {
    if (fallbackCalls++ === 0) return Promise.reject(overconstrained);
    return Promise.resolve('fallback-result');
  };
  assert.equal(await screen.applyConstraints(original), 'fallback-result');
  assert.equal(screen.calls.length, 3); // Initial profile request, patched call, single fallback.
  assert.deepEqual(screen.calls[2], original);

  const nativeError = new Error('native failure');
  let rejectNext = false;
  screen.behavior = () => rejectNext ? Promise.reject(nativeError) : Promise.resolve();
  rejectNext = true;
  await assert.rejects(screen.applyConstraints(original), error => error === nativeError);
  assert.equal(screen.calls.length, 4);
  assert.equal(quality.snapshot().errors, 2);
  quality.stop();
});

test('stop removes owned resources without closing host peers or tracks and preserves foreign replacements', async () => {
  const observers = new FakeObservers();
  const screen = new FakeTrack();
  const pc = new FakePeer();
  const quality = installStreamQuality(observers, settings(true));
  observers.addTrack(screen);
  observers.addPeer(pc);
  const originalPatch = screen.applyConstraints;
  const originalAddTrack = pc.addTrack;
  assert.notStrictEqual(originalPatch, FakeTrack.prototype.applyConstraints);
  assert.notStrictEqual(originalAddTrack, FakePeer.prototype.addTrack);
  assert.equal(screen.listeners.get('ended')?.size, 1);
  assert.equal(pc.listeners.get('connectionstatechange')?.size, 1);

  const foreignConstraints = function foreignConstraints(value) { return Promise.resolve(value); };
  const foreignAddTrack = function foreignAddTrack() { return 'foreign'; };
  screen.applyConstraints = foreignConstraints;
  pc.addTrack = foreignAddTrack;
  quality.stop();
  quality.stop();

  assert.strictEqual(screen.applyConstraints, foreignConstraints);
  assert.strictEqual(pc.addTrack, foreignAddTrack);
  assert.equal(screen.listeners.get('ended')?.size ?? 0, 0);
  assert.equal(pc.listeners.get('connectionstatechange')?.size ?? 0, 0);
  assert.equal(screen.stopCalls, 0);
  assert.equal(pc.closeCalls, 0);
  assert.equal(quality.snapshot().activeTracks, 0);
  assert.equal(quality.snapshot().trackedPeers, 0);
});

test('snapshot prunes stopped tracks and closed peers without events and restores owned hooks', async () => {
  const observers = new FakeObservers();
  const screen = new FakeTrack();
  const pc = new FakePeer();
  const originalApplyConstraints = screen.applyConstraints;
  const originalAddTrack = pc.addTrack;
  const originalAddTransceiver = pc.addTransceiver;
  const quality = installStreamQuality(observers, settings(true));
  observers.addTrack(screen);
  observers.addPeer(pc);
  const sender = pc.addTrack(screen);
  assert.notStrictEqual(screen.applyConstraints, originalApplyConstraints);
  assert.notStrictEqual(pc.addTrack, originalAddTrack);
  assert.notStrictEqual(pc.addTransceiver, originalAddTransceiver);
  assert.notStrictEqual(sender.setParameters, sender.originalSetParameters);
  assert.equal(screen.listeners.get('ended')?.size, 1);
  assert.equal(pc.listeners.get('connectionstatechange')?.size, 1);

  screen.stop();
  pc.close();
  assert.equal(screen.listeners.get('ended')?.size, 1, 'stop did not emit ended');
  assert.equal(pc.listeners.get('connectionstatechange')?.size, 1, 'close did not emit state change');
  assert.deepEqual(quality.snapshot(), {
    activeTracks: 0, trackedPeers: 0, errors: 0, target: { ...profile },
    mode: 'capture-and-sender', verified1440p: false,
  });

  assert.strictEqual(screen.applyConstraints, originalApplyConstraints);
  assert.strictEqual(pc.addTrack, originalAddTrack);
  assert.strictEqual(pc.addTransceiver, originalAddTransceiver);
  assert.strictEqual(sender.setParameters, sender.originalSetParameters);
  assert.equal(screen.listeners.get('ended')?.size ?? 0, 0);
  assert.equal(pc.listeners.get('connectionstatechange')?.size ?? 0, 0);
  assert.equal(screen.stopCalls, 1);
  assert.equal(pc.closeCalls, 1);
  quality.stop();
});

test('more than 32 stop cycles prune without events and apply the latest profile each time', async () => {
  const observers = new FakeObservers();
  let selectedProfile = { ...profile };
  const quality = installStreamQuality(observers, () => ({ qualityEnabled: true, profile: selectedProfile }));
  const cycles = 40;

  for (let index = 0; index < cycles; index++) {
    if (index === 32) {
      selectedProfile = { resolution: '720p', fps: 60, codec: 'H264', bitrateMbps: 12 };
    }
    const screen = new FakeTrack();
    const pc = new FakePeer();
    const originalApplyConstraints = screen.applyConstraints;
    const originalAddTrack = pc.addTrack;
    const originalAddTransceiver = pc.addTransceiver;
    observers.addTrack(screen);
    observers.addPeer(pc);

    assert.deepEqual(screen.calls[0].width, {
      ideal: selectedProfile.resolution === '1440p' ? 2560 : 1280,
      max: selectedProfile.resolution === '1440p' ? 2560 : 1280,
    }, `capture ${index + 1} should receive the current profile`);
    assert.equal(screen.calls[0].frameRate.ideal, selectedProfile.fps);

    const sender = pc.addTrack(screen);
    await sender.setParameters({ encodings: [{ rid: 'f', scaleResolutionDownBy: 1 }] });
    const appliedParameters = sender.parameterCalls[0];
    assert.equal(appliedParameters.degradationPreference, 'maintain-resolution');
    assert.equal(appliedParameters.encodings[0].maxBitrate, selectedProfile.bitrateMbps * 1_000_000);
    assert.equal(appliedParameters.encodings[0].maxFramerate, selectedProfile.fps);

    screen.stop();
    pc.close();
    assert.equal(screen.listeners.get('ended')?.size, 1);
    assert.equal(pc.listeners.get('connectionstatechange')?.size, 1);
    assert.equal(quality.snapshot().activeTracks, 0);
    assert.equal(quality.snapshot().trackedPeers, 0);
    assert.strictEqual(screen.applyConstraints, originalApplyConstraints);
    assert.strictEqual(pc.addTrack, originalAddTrack);
    assert.strictEqual(pc.addTransceiver, originalAddTransceiver);
    assert.strictEqual(sender.setParameters, sender.originalSetParameters);
    assert.equal(screen.listeners.get('ended')?.size ?? 0, 0);
    assert.equal(pc.listeners.get('connectionstatechange')?.size ?? 0, 0);
  }

  assert.equal(quality.snapshot().activeTracks, 0);
  assert.equal(quality.snapshot().trackedPeers, 0);
  quality.stop();
});

test('profile validation rejects invalid types, unsupported combinations, and bitrate limits', () => {
  const valid = { resolution: '1440p', fps: 30, codec: 'VP9', bitrateMbps: 16 };
  assert.deepEqual(validateProfile(valid), valid);
  const invalid = [
    null,
    [],
    { ...valid, resolution: '2160p' },
    { ...valid, fps: '30' },
    { ...valid, fps: 24 },
    { ...valid, codec: 'vp9' },
    { ...valid, bitrateMbps: '16' },
    { ...valid, bitrateMbps: 0.99 },
    { ...valid, bitrateMbps: 50.01 },
    { ...valid, bitrateMbps: Infinity },
    { ...valid, unexpected: true },
  ];
  for (const candidate of invalid) assert.throws(() => validateProfile(candidate), /Invalid stream profile/);
});
