import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Compile in memory: these isolated identity tests must not overwrite a concurrent build.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/stream-diagnostics.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
});
const { installStreamDiagnostics } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

class FakeTrack {
  kind = 'video';
  readyState = 'live';
  listeners = new Set();
  constructor(id, settings = {}) { this.id = id; this.settings = settings; }
  getSettings() { return { ...this.settings }; }
  addEventListener(type, listener) { if (type === 'ended') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'ended') this.listeners.delete(listener); }
  end() {
    this.readyState = 'ended';
    for (const listener of [...this.listeners]) listener();
  }
  stop() { this.readyState = 'ended'; }
}

class FakeStream {
  constructor(...tracks) { this.tracks = tracks; }
  getVideoTracks() { return this.tracks; }
}

class FakePeerConnection {
  connectionState = 'connected';
  senders = [];
  transceivers = [];
  inboundStats = new Map();
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  getSenders() { return this.senders; }
  getTransceivers() { return this.transceivers; }
  getStats() { return this.inboundStats; }
  close() { this.connectionState = 'closed'; }
}

function videoFor(...tracks) { return { isConnected: true, srcObject: new FakeStream(...tracks) }; }
function stats(...reports) { return new Map(reports.map(report => [report.id, report])); }
function report(direction, id, extra = {}) {
  return {
    id, type: `${direction}-rtp`, kind: 'video', timestamp: 1000,
    ...(direction === 'outbound' ? { bytesSent: 4000, framesEncoded: 30 } : { bytesReceived: 4000, framesDecoded: 30 }),
    frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30, ...extra,
  };
}
function sender(track, ...reports) {
  return { track, getParameters: () => ({ encodings: [] }), getStats: async () => stats(...reports) };
}
function receiver(track, mid) { return { mid, receiver: { track } }; }

async function withDiagnostics(callback) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const fakeWindow = { RTCPeerConnection: FakePeerConnection, navigator: { mediaDevices: {} } };
  Object.defineProperty(globalThis, 'window', { configurable: true, enumerable: true, writable: true, value: fakeWindow });
  const diagnostics = installStreamDiagnostics();
  try { await callback(diagnostics, fakeWindow); }
  finally {
    diagnostics.stop();
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else delete globalThis.window;
  }
}

test('selected sender video maps by track object to its own RTP record', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const track = new FakeTrack('private-sender-track');
    const otherTrack = new FakeTrack('private-other-sender-track');
    const pc = new win.RTCPeerConnection();
    pc.senders = [
      sender(track, report('outbound', 'private-sender-report', { frameWidth: 2560, frameHeight: 1440 })),
      sender(otherTrack, report('outbound', 'private-other-report', { frameWidth: 1280, frameHeight: 720 })),
    ];
    const selectedVideo = videoFor(track);
    assert.equal(diagnostics.streamIdForVideo(selectedVideo), undefined, 'RTP must be sampled before identity is proven');
    await diagnostics.sample();
    const records = diagnostics.snapshot().streams;
    const selected = records.find(item => item.encoded.width === 2560);
    const other = records.find(item => item.encoded.width === 1280);
    assert.ok(selected.streamId);
    assert.equal(diagnostics.streamIdForVideo(selectedVideo), selected.streamId);
    assert.equal(diagnostics.streamIdForVideo(videoFor(otherTrack)), other.streamId);
    assert.notEqual(selected.streamId, other.streamId);
    assert.equal(diagnostics.streamIdForVideo(videoFor(new FakeTrack(track.id))), undefined, 'equal raw IDs do not prove sender track object identity');
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(selectedVideo), selected.streamId, 'stable RTP reports retain the generated identity');
  });
});

test('simulcast mapping selects the largest sampled encoding for one sender track', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const track = new FakeTrack('private-simulcast-track');
    const pc = new win.RTCPeerConnection();
    pc.senders = [sender(track,
      report('outbound', 'private-layer-low', { frameWidth: 640, frameHeight: 360 }),
      report('outbound', 'private-layer-high', { frameWidth: 2560, frameHeight: 1440 }),
      report('outbound', 'private-layer-medium', { frameWidth: 1280, frameHeight: 720 }),
    )];
    await diagnostics.sample();
    const largest = diagnostics.snapshot().streams.find(item => item.encoded.width === 2560);
    assert.equal(diagnostics.streamIdForVideo(videoFor(track)), largest.streamId);
  });
});

test('receiver video requires exact trackIdentifier or MID with unique matching receiver', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const byTrack = new FakeTrack('private-receiver-by-track');
    const byMid = new FakeTrack('private-receiver-by-mid');
    const pc = new win.RTCPeerConnection();
    pc.transceivers = [receiver(byTrack, 'private-mid-track'), receiver(byMid, 'private-mid-selected')];
    pc.inboundStats = stats(
      report('inbound', 'private-inbound-track-report', { trackIdentifier: byTrack.id, frameWidth: 2560 }),
      report('inbound', 'private-inbound-mid-report', { mid: 'private-mid-selected', frameWidth: 1280 }),
    );
    await diagnostics.sample();
    const records = diagnostics.snapshot().streams;
    assert.equal(diagnostics.streamIdForVideo(videoFor(byTrack)), records.find(item => item.decoded.width === 2560).streamId);
    assert.equal(diagnostics.streamIdForVideo(videoFor(byMid)), records.find(item => item.decoded.width === 1280).streamId);

    pc.inboundStats = stats(report('inbound', 'private-inbound-agree', { trackIdentifier: byMid.id, mid: 'private-mid-selected' }));
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(videoFor(byMid)), diagnostics.snapshot().streams[0].streamId);
    assert.equal(diagnostics.streamIdForVideo(videoFor(byTrack)), undefined, 'old receiver association is not retained after sample replacement');
  });
});

test('contradictory, unmatched, missing, or ambiguous receiver identifiers fail closed', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const first = new FakeTrack('private-first-receiver');
    const second = new FakeTrack('private-second-receiver');
    const pc = new win.RTCPeerConnection();
    pc.transceivers = [receiver(first, 'private-first-mid'), receiver(second, 'private-second-mid')];
    const cases = [
      { trackIdentifier: first.id, mid: 'private-second-mid' },
      { trackIdentifier: 'private-no-such-track', mid: 'private-first-mid' },
      { trackIdentifier: first.id, mid: 'private-no-such-mid' },
      { trackIdentifier: 'private-no-such-track' },
      { mid: 'private-no-such-mid' },
      {},
    ];
    for (const identifiers of cases) {
      pc.inboundStats = stats(report('inbound', 'private-conflicting-report', identifiers));
      await diagnostics.sample();
      assert.equal(diagnostics.streamIdForVideo(videoFor(first)), undefined, JSON.stringify(identifiers));
      assert.equal(diagnostics.streamIdForVideo(videoFor(second)), undefined, JSON.stringify(identifiers));
    }
    const duplicate = new FakeTrack(first.id);
    pc.transceivers = [receiver(first, 'private-first-mid'), receiver(duplicate, 'private-duplicate-mid')];
    pc.inboundStats = stats(report('inbound', 'private-ambiguous-track-report', { trackIdentifier: first.id }));
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(videoFor(first)), undefined);
    assert.equal(diagnostics.streamIdForVideo(videoFor(duplicate)), undefined);
    pc.transceivers = [receiver(first, 'private-shared-mid'), receiver(second, 'private-shared-mid')];
    pc.inboundStats = stats(report('inbound', 'private-ambiguous-mid-report', { mid: 'private-shared-mid' }));
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(videoFor(first)), undefined);
    assert.equal(diagnostics.streamIdForVideo(videoFor(second)), undefined);
  });
});

test('unrelated, detached, source-less, multi-track, and ended videos have no association', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const track = new FakeTrack('private-live-track');
    const unrelated = new FakeTrack('private-unrelated-track');
    const pc = new win.RTCPeerConnection();
    pc.senders = [sender(track, report('outbound', 'private-live-report'))];
    await diagnostics.sample();
    const selectedVideo = videoFor(track);
    assert.ok(diagnostics.streamIdForVideo(selectedVideo));
    assert.equal(diagnostics.streamIdForVideo(videoFor(unrelated)), undefined);
    assert.equal(diagnostics.streamIdForVideo(videoFor()), undefined);
    assert.equal(diagnostics.streamIdForVideo(videoFor(track, unrelated)), undefined);
    assert.equal(diagnostics.streamIdForVideo({ isConnected: true, srcObject: null }), undefined);
    assert.equal(diagnostics.streamIdForVideo({ isConnected: true, srcObject: {} }), undefined);
    assert.equal(diagnostics.streamIdForVideo({ isConnected: true, get srcObject() { throw new Error('detached media'); } }), undefined);
    selectedVideo.isConnected = false;
    assert.equal(diagnostics.streamIdForVideo(selectedVideo), undefined);
    selectedVideo.isConnected = true;
    assert.ok(diagnostics.streamIdForVideo(selectedVideo), 'reattached live video retains the sampled identity');
    track.end();
    assert.equal(diagnostics.streamIdForVideo(selectedVideo), undefined, 'ended track is rejected before another stats poll');
  });
});

test('closed peers and stopped tracks lose mapping immediately, stopped collector cannot revive it', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const track = new FakeTrack('private-closed-peer-track');
    const stoppedTrack = new FakeTrack('private-stopped-track');
    const pc = new win.RTCPeerConnection();
    const secondPc = new win.RTCPeerConnection();
    pc.senders = [sender(track, report('outbound', 'private-closed-peer-report'))];
    secondPc.senders = [sender(stoppedTrack, report('outbound', 'private-stopped-track-report'))];
    await diagnostics.sample();
    const selected = videoFor(track), secondVideo = videoFor(stoppedTrack);
    assert.ok(diagnostics.streamIdForVideo(selected));
    assert.ok(diagnostics.streamIdForVideo(secondVideo));
    pc.close();
    assert.equal(diagnostics.streamIdForVideo(selected), undefined, 'silent close is rejected without a lifecycle event');
    stoppedTrack.stop();
    assert.equal(diagnostics.streamIdForVideo(secondVideo), undefined, 'silent track stop is rejected without ended event');
    pc.dispatch('connectionstatechange');
    assert.equal(diagnostics.snapshot().streams.some(item => item.connectionId === 1), false);
    diagnostics.stop();
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(selected), undefined);
    assert.equal(diagnostics.streamIdForVideo(secondVideo), undefined);
    assert.deepEqual(diagnostics.snapshot().streams, []);
  });
});

test('removed sender, replaced track, and failed statistics discard stale associations on next sample', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const first = new FakeTrack('private-old-track');
    const replacement = new FakeTrack('private-new-track');
    const pc = new win.RTCPeerConnection();
    const sending = sender(first, report('outbound', 'private-replace-report'));
    pc.senders = [sending];
    await diagnostics.sample();
    const oldVideo = videoFor(first), newVideo = videoFor(replacement);
    assert.ok(diagnostics.streamIdForVideo(oldVideo));
    sending.track = replacement;
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(oldVideo), undefined);
    assert.ok(diagnostics.streamIdForVideo(newVideo));
    sending.getStats = async () => { throw new Error('temporary stats failure'); };
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(newVideo), undefined);
    assert.deepEqual(diagnostics.snapshot().streams, []);
    sending.getStats = async () => stats(report('outbound', 'private-restored-report'));
    await diagnostics.sample();
    assert.ok(diagnostics.streamIdForVideo(newVideo));
    pc.senders = [];
    await diagnostics.sample();
    assert.equal(diagnostics.streamIdForVideo(newVideo), undefined);
    assert.deepEqual(diagnostics.snapshot().streams, []);
  });
});

test('a pending sample cannot recreate track mapping after collector stop', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const track = new FakeTrack('private-pending-track');
    const pc = new win.RTCPeerConnection();
    let resolveStats;
    pc.senders = [{
      track, getParameters: () => ({ encodings: [] }),
      getStats: () => new Promise(resolve => { resolveStats = resolve; }),
    }];
    const pending = diagnostics.sample();
    assert.equal(typeof resolveStats, 'function');
    diagnostics.stop();
    resolveStats(stats(report('outbound', 'private-pending-report')));
    await pending;
    assert.equal(diagnostics.streamIdForVideo(videoFor(track)), undefined);
    assert.deepEqual(diagnostics.snapshot().streams, []);
  });
});

test('snapshot exposes generated identities without raw track, RTP, or MID identifiers', async () => {
  await withDiagnostics(async (diagnostics, win) => {
    const outgoing = new FakeTrack('private-output-track-id');
    const incoming = new FakeTrack('private-input-track-id');
    outgoing.label = 'Private window title'; incoming.label = 'Private friend title';
    const pc = new win.RTCPeerConnection();
    pc.senders = [sender(outgoing, report('outbound', 'private-output-report-id', {
      trackIdentifier: outgoing.id, mid: 'private-output-mid', ssrc: 123456789,
    }))];
    pc.transceivers = [receiver(incoming, 'private-input-mid')];
    pc.inboundStats = stats(report('inbound', 'private-input-report-id', {
      trackIdentifier: incoming.id, mid: 'private-input-mid', ssrc: 987654321,
    }));
    await diagnostics.sample();
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.streams.length, 2);
    for (const record of snapshot.streams) assert.match(record.streamId, /^\d+:(?:inbound|outbound):\d+$/);
    assert.ok(diagnostics.streamIdForVideo(videoFor(outgoing)));
    assert.ok(diagnostics.streamIdForVideo(videoFor(incoming)));
    const serialized = JSON.stringify(snapshot);
    for (const sensitive of [
      outgoing.id, incoming.id, outgoing.label, incoming.label,
      'private-output-report-id', 'private-input-report-id', 'private-output-mid', 'private-input-mid',
      '123456789', '987654321', 'trackIdentifier',
    ]) assert.equal(serialized.includes(sensitive), false, `snapshot leaked ${sensitive}`);
  });
});
