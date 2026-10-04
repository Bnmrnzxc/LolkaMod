import assert from 'node:assert/strict';
import test from 'node:test';

import { installStreamDiagnostics } from '../dist/stream-diagnostics.mjs';

class FakeTrack {
  kind = 'video';
  id = 'private-track-id';
  label = 'Sensitive desktop title';
  readyState = 'live';
  settings;
  listeners = new Set();
  stopCalls = 0;

  constructor(settings = {}) { this.settings = settings; }
  getSettings() { return { ...this.settings }; }
  addEventListener(type, listener) { if (type === 'ended') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'ended') this.listeners.delete(listener); }
  end() {
    this.readyState = 'ended';
    for (const listener of [...this.listeners]) listener();
  }
  stop() { this.stopCalls += 1; this.readyState = 'ended'; }
}

class FakeStream {
  constructor(tracks) { this.tracks = tracks; }
  getVideoTracks() { return this.tracks; }
}

class FakePeerConnection {
  static marker = 'native-static-marker';
  args;
  connectionState = 'connected';
  senders = [];
  inboundStats = new Map();
  listeners = new Map();
  closeCalls = 0;

  constructor(...args) { this.args = args; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  getSenders() { return this.senders; }
  getStats() { return this.inboundStats; }
  close() { this.closeCalls += 1; this.connectionState = 'closed'; }
}

async function withWindow(fakeWindow, callback) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: fakeWindow,
  });
  try {
    return await callback();
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else delete globalThis.window;
  }
}

function makeCodec(id = 'internal-codec-id', mimeType = 'video/VP9') {
  return { id, type: 'codec', mimeType, sdpFmtpLine: 'private=codec-metadata' };
}

function makeInbound({ timestamp, bytesReceived, framesDecoded }) {
  return {
    id: 'private-inbound-report-id',
    type: 'inbound-rtp',
    kind: 'video',
    timestamp,
    bytesReceived,
    framesDecoded,
    frameWidth: 1280,
    frameHeight: 720,
    packetsLost: 3,
    codecId: 'internal-codec-id',
    ssrc: 123456,
    remoteId: 'private-remote-id',
    address: '192.0.2.10',
    usernameFragment: 'private-candidate-fragment',
  };
}

test('constructor proxy and capture wrapper preserve host behavior and restore safely', async () => {
  const track = new FakeTrack({ width: 1920, height: 1080, frameRate: 30, displaySurface: 'window' });
  const stream = new FakeStream([track]);
  const calls = [];
  const mediaDevices = {
    marker: 'media-device-this',
    getDisplayMedia(options) {
      calls.push({ receiver: this, options });
      if (options?.syncThrow) throw new Error('sync capture error');
      if (options?.reject) return Promise.reject(new Error('async capture error'));
      return Promise.resolve(stream);
    },
  };
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia;
  const fakeWindow = { RTCPeerConnection: FakePeerConnection, navigator: { mediaDevices } };

  await withWindow(fakeWindow, async () => {
    const diagnostics = installStreamDiagnostics();
    const WrappedPeerConnection = fakeWindow.RTCPeerConnection;
    assert.notStrictEqual(WrappedPeerConnection, FakePeerConnection);
    assert.equal(WrappedPeerConnection.marker, FakePeerConnection.marker);

    const pc = new WrappedPeerConnection('stun:private.example', { iceTransportPolicy: 'all' });
    assert.ok(pc instanceof FakePeerConnection);
    assert.ok(pc instanceof WrappedPeerConnection);
    assert.deepEqual(pc.args, ['stun:private.example', { iceTransportPolicy: 'all' }]);
    assert.equal(diagnostics.snapshot().state.connections, 1);

    assert.strictEqual(await mediaDevices.getDisplayMedia({ video: true }), stream);
    assert.strictEqual(calls[0].receiver, mediaDevices);
    assert.deepEqual(calls[0].options, { video: true });
    assert.equal(diagnostics.snapshot().state.displayCapture, 1);
    assert.throws(() => mediaDevices.getDisplayMedia({ syncThrow: true }), /sync capture error/);
    await assert.rejects(mediaDevices.getDisplayMedia({ reject: true }), /async capture error/);

    diagnostics.stop();
    diagnostics.stop();
    assert.strictEqual(fakeWindow.RTCPeerConnection, FakePeerConnection);
    assert.strictEqual(mediaDevices.getDisplayMedia, originalGetDisplayMedia);
    assert.equal(pc.closeCalls, 0);
    assert.equal(track.stopCalls, 0);
    assert.equal(pc.listeners.get('connectionstatechange')?.size ?? 0, 0);
    assert.equal(track.listeners.size, 0);

    const diagnosticsAgain = installStreamDiagnostics();
    const ownerConstructor = function ReplacementPeerConnection() {};
    const ownerCapture = function replacementCapture() {};
    fakeWindow.RTCPeerConnection = ownerConstructor;
    mediaDevices.getDisplayMedia = ownerCapture;
    diagnosticsAgain.stop();
    assert.strictEqual(fakeWindow.RTCPeerConnection, ownerConstructor);
    assert.strictEqual(mediaDevices.getDisplayMedia, ownerCapture);
  });
});

test('snapshot reports read-only capture and RTP metrics with private identifiers omitted', async () => {
  const track = new FakeTrack({ width: 2560, height: 1440, frameRate: 60, displaySurface: 'monitor' });
  const stream = new FakeStream([track]);
  const mediaDevices = { getDisplayMedia: async () => stream };
  const fakeWindow = { RTCPeerConnection: FakePeerConnection, navigator: { mediaDevices } };

  await withWindow(fakeWindow, async () => {
    const diagnostics = installStreamDiagnostics();
    const pc = new fakeWindow.RTCPeerConnection();
    const outbound = {
      id: 'private-outbound-report-id',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1000,
      bytesSent: 1000,
      framesEncoded: 30,
      frameWidth: 2560,
      frameHeight: 1440,
      codecId: 'internal-codec-id',
      qualityLimitationReason: 'cpu',
      ssrc: 654321,
      rid: 'private-layer-id',
      localId: 'private-track-id',
    };
    const sender = {
      track,
      getParameters: () => ({ encodings: [
        { maxBitrate: 4_000_000, scaleResolutionDownBy: 1, maxFramerate: 60, active: true },
        { maxBitrate: 'secret', scaleResolutionDownBy: Infinity, maxFramerate: 30, active: false },
      ] }),
      getStats: async () => new Map([
        [outbound.id, outbound],
        ['internal-codec-id', makeCodec()],
      ]),
    };
    pc.senders = [sender];
    pc.inboundStats = new Map([
      ['private-inbound-report-id', makeInbound({ timestamp: 1000, bytesReceived: 500, framesDecoded: 15 })],
      ['internal-codec-id', makeCodec()],
    ]);
    const captured = await mediaDevices.getDisplayMedia({ video: true });
    assert.strictEqual(captured, stream);

    assert.deepEqual(diagnostics.snapshot().state, {
      connections: 1, displayCapture: 1, samples: 0, noStream: true,
    });
    await diagnostics.sample();
    assert.equal(diagnostics.snapshot().streams.length, 2);

    outbound.timestamp = 3000;
    outbound.bytesSent = 101_000;
    outbound.framesEncoded = 90;
    pc.inboundStats.set('private-inbound-report-id', makeInbound({
      timestamp: 3000, bytesReceived: 12_500, framesDecoded: 45,
    }));
    await diagnostics.sample();

    const snapshot = diagnostics.snapshot();
    const outgoing = snapshot.streams.find(item => item.direction === 'outbound');
    const incoming = snapshot.streams.find(item => item.direction === 'inbound');
    assert.equal(snapshot.state.connections, 1);
    assert.equal(snapshot.state.displayCapture, 1);
    assert.equal(snapshot.state.samples, 2);
    assert.equal(snapshot.state.noStream, false);
    assert.equal(outgoing.media, 'screen');
    assert.deepEqual(outgoing.capture, { width: 2560, height: 1440, fps: 60 });
    assert.deepEqual(outgoing.encoded, { width: 2560, height: 1440, fps: 30 });
    assert.equal(outgoing.codec, 'VP9');
    assert.equal(outgoing.bitrateKbps, 400);
    assert.equal(outgoing.qualityLimitationReason, 'cpu');
    assert.deepEqual(outgoing.encodings, [
      { maxBitrate: 4_000_000, scaleResolutionDownBy: 1, maxFramerate: 60, active: true },
      { maxBitrate: null, scaleResolutionDownBy: null, maxFramerate: 30, active: false },
    ]);
    assert.equal(incoming.media, 'unknown');
    assert.equal(incoming.capture, null);
    assert.deepEqual(incoming.decoded, { width: 1280, height: 720, fps: 15 });
    assert.equal(incoming.bitrateKbps, 48);
    assert.equal(incoming.packetLossCount, 3);
    assert.equal(incoming.codec, 'VP9');

    outgoing.capture.width = 7;
    assert.equal(diagnostics.snapshot().streams.find(item => item.direction === 'outbound').capture.width, 2560);
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      'private-track-id', 'Sensitive desktop title', 'private-inbound-report-id',
      'private-outbound-report-id', 'private-remote-id', 'private-candidate-fragment',
      'private-layer-id', 'private-codec-metadata', '192.0.2.10', '654321',
    ]) assert.equal(serialized.includes(privateValue), false, `snapshot leaked ${privateValue}`);

    track.end();
    assert.equal(diagnostics.snapshot().state.displayCapture, 0);
    assert.equal(track.listeners.size, 0);
    pc.connectionState = 'closed';
    pc.dispatch('connectionstatechange');
    assert.equal(diagnostics.snapshot().state.connections, 0);
    assert.equal(diagnostics.snapshot().streams.length, 0);
    diagnostics.stop();
  });
});

test('snapshot and sample prune stopped tracks and closed peers without lifecycle events', async () => {
  const track = new FakeTrack({ width: 2560, height: 1440, frameRate: 60 });
  const stream = new FakeStream([track]);
  const mediaDevices = { getDisplayMedia: async () => stream };
  const fakeWindow = { RTCPeerConnection: FakePeerConnection, navigator: { mediaDevices } };
  const originalCapture = mediaDevices.getDisplayMedia;

  await withWindow(fakeWindow, async () => {
    const diagnostics = installStreamDiagnostics();
    const instrumentedConstructor = fakeWindow.RTCPeerConnection;
    const pc = new fakeWindow.RTCPeerConnection();
    await mediaDevices.getDisplayMedia({ video: true });
    assert.equal(diagnostics.snapshot().state.displayCapture, 1);
    assert.equal(track.listeners.size, 1);
    assert.equal(pc.listeners.get('connectionstatechange')?.size, 1);

    track.stop();
    assert.equal(track.listeners.size, 1, 'stop did not emit ended');
    assert.equal(diagnostics.snapshot().state.displayCapture, 0, 'snapshot prunes the ended track');
    assert.equal(track.listeners.size, 0, 'pruning removes the owned ended listener');

    pc.close();
    assert.equal(pc.listeners.get('connectionstatechange')?.size, 1, 'close did not emit state change');
    await diagnostics.sample();
    assert.equal(diagnostics.snapshot().state.connections, 0, 'sampling prunes the closed peer');
    assert.equal(pc.listeners.get('connectionstatechange')?.size, 0, 'pruning removes the owned peer listener');

    diagnostics.stop();
    assert.strictEqual(fakeWindow.RTCPeerConnection, FakePeerConnection);
    assert.strictEqual(mediaDevices.getDisplayMedia, originalCapture);
    assert.notStrictEqual(instrumentedConstructor, FakePeerConnection);
    assert.equal(track.stopCalls, 1);
    assert.equal(pc.closeCalls, 1);
  });
});

test('unsupported APIs and failing statistics remain harmless', async () => {
  await withWindow({ navigator: { mediaDevices: {} } }, async () => {
    const diagnostics = installStreamDiagnostics();
    await assert.doesNotReject(diagnostics.sample());
    assert.deepEqual(diagnostics.snapshot(), {
      state: { connections: 0, displayCapture: 0, samples: 1, noStream: true },
      streams: [],
    });
    diagnostics.stop();
  });

  await withWindow({ RTCPeerConnection: FakePeerConnection, navigator: { mediaDevices: {} } }, async () => {
    const diagnostics = installStreamDiagnostics();
    const pc = new globalThis.window.RTCPeerConnection();
    pc.getStats = async () => { throw new Error('stats unavailable'); };
    await assert.doesNotReject(diagnostics.sample());
    assert.deepEqual(diagnostics.snapshot().streams, []);
    diagnostics.stop();
    assert.strictEqual(globalThis.window.RTCPeerConnection, FakePeerConnection);
  });
});

test('internal observers replay references, isolate callback errors, and unsubscribe', async () => {
  const firstTrack = new FakeTrack({ width: 800, height: 600, frameRate: 30 });
  const secondTrack = new FakeTrack({ width: 640, height: 480, frameRate: 24 });
  const streams = [new FakeStream([firstTrack]), new FakeStream([secondTrack])];
  let captureNumber = 0;
  const mediaDevices = { getDisplayMedia: async () => streams[captureNumber++] };
  const fakeWindow = { RTCPeerConnection: FakePeerConnection, navigator: { mediaDevices } };

  await withWindow(fakeWindow, async () => {
    const diagnostics = installStreamDiagnostics();
    try {
      const pc = new fakeWindow.RTCPeerConnection();
      await mediaDevices.getDisplayMedia();

      const observedPCs = [];
      const observedTracks = [];
      const unsubscribePC = diagnostics.observePeerConnections(value => observedPCs.push(value));
      const unsubscribeTrack = diagnostics.observeDisplayTracks(value => observedTracks.push(value));
      assert.deepEqual(observedPCs, [pc]);
      assert.deepEqual(observedTracks, [firstTrack]);

      const observerThatThrows = diagnostics.observePeerConnections(() => { throw new Error('observer error'); });
      let secondPc;
      assert.doesNotThrow(() => { secondPc = new fakeWindow.RTCPeerConnection(); });
      await assert.doesNotReject(mediaDevices.getDisplayMedia());
      assert.deepEqual(observedPCs, [pc, secondPc]);
      assert.deepEqual(observedTracks, [firstTrack, secondTrack]);

      unsubscribePC();
      unsubscribeTrack();
      observerThatThrows();
      new fakeWindow.RTCPeerConnection();
      await mediaDevices.getDisplayMedia();
      assert.equal(observedPCs.length, 2);
      assert.equal(observedTracks.length, 2);
    } finally {
      diagnostics.stop();
    }
    assert.doesNotThrow(() => diagnostics.observePeerConnections(() => assert.fail('stopped observer ran'))());
    assert.doesNotThrow(() => diagnostics.observeDisplayTracks(() => assert.fail('stopped observer ran'))());
  });
});
