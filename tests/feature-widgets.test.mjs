import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sourceModule(name) {
  const result = await build({ entryPoints: [path.join(root, `src/renderer/${name}.ts`)], bundle: true,
    format: 'esm', platform: 'node', target: 'es2022', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const [themes, indicators, miniPlayers] = await Promise.all([
  sourceModule('theme-manager'), sourceModule('stream-indicator'), sourceModule('mini-player'),
]);

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(fn); this.listeners.set(type, listeners);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this }); }
  listenerCount() { return [...this.listeners.values()].reduce((count, values) => count + values.size, 0); }
}
class Element extends Events {
  parent = null; children = []; attributes = new Map(); dataset = {}; textContent = ''; hidden = false;
  className = ''; value = ''; id = '';
  constructor(tag, doc) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc; }
  get isConnected() { return this === this.ownerDocument.documentElement || !!this.parent?.isConnected; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this);
    this.parent = null;
  }
  replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.append(...items); }
  attachShadow() { const shadow = new Element('shadow', this.ownerDocument); shadow.parent = this; this.shadowRoot = shadow; return shadow; }
}
class Document extends Events {
  pictureInPictureEnabled = true; pictureInPictureElement = null; exitCalls = 0;
  observers = new Set();
  constructor() {
    super();
    this.documentElement = new Element('html', this);
    this.head = new Element('head', this); this.body = new Element('body', this);
    this.documentElement.append(this.head, this.body);
    const owner = this;
    this.defaultView = new Events();
    this.defaultView.MutationObserver = class {
      constructor(callback) { this.callback = callback; }
      observe() { owner.observers.add(this); }
      disconnect() { owner.observers.delete(this); }
    };
  }
  createElement(tag) { return new Element(tag, this); }
  mutate() { for (const observer of [...this.observers]) observer.callback([]); }
  async exitPictureInPicture() {
    this.exitCalls++; const video = this.pictureInPictureElement;
    this.pictureInPictureElement = null; video?.dispatch('leavepictureinpicture');
  }
}
class Track extends Events {
  readyState = 'live'; stopCalls = 0;
  stop() { this.stopCalls++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatch('ended'); }
}
class Video extends Element {
  readyState = 4; videoWidth = 1280; videoHeight = 720; ended = false; disablePictureInPicture = false;
  volume = 0.37; muted = false; currentTime = 11; pauseCalls = 0; playCalls = 0; requestCalls = 0;
  constructor(doc) {
    super('video', doc); this.track = new Track(); this.srcObject = { getVideoTracks: () => [this.track] }; doc.body.append(this);
  }
  requestPictureInPicture() {
    this.requestCalls++;
    const prior = this.ownerDocument.pictureInPictureElement;
    this.ownerDocument.pictureInPictureElement = this;
    if (prior && prior !== this) prior.dispatch('leavepictureinpicture');
    return Promise.resolve({ width: 320, height: 180 });
  }
  play() { this.playCalls++; }
  pause() { this.pauseCalls++; }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const owned = (doc, id) => [...doc.head.children, ...doc.body.children].filter(element => element.id === id);
const videoUnchanged = video => {
  assert.equal(video.volume, 0.37); assert.equal(video.muted, false); assert.equal(video.currentTime, 11);
  assert.equal(video.pauseCalls, 0); assert.equal(video.playCalls, 0); assert.equal(video.track.stopCalls, 0);
};

function snapshot(overrides = {}) {
  return {
    state: { connections: 1, displayCapture: 1, samples: 2, noStream: false },
    sampledAt: 1_000,
    streams: [{ connectionId: 1, direction: 'outbound', media: 'screen',
      capture: { width: 2560, height: 1440, fps: 60 },
      encoded: { width: 1920, height: 1080, fps: 29.8 }, decoded: null,
      bitrateKbps: 1800, codec: 'AV1', packetLossCount: 23, qualityLimitationReason: 'cpu', encodings: [],
      trackId: 'Sensitive desktop title', address: '192.0.2.1', sdp: 'private SDP' }],
    ...overrides,
  };
}

test('built-in themes are local scoped palettes, preserve host classes and remove only owned state', () => {
  const doc = new Document(); doc.documentElement.className = 'dark-theme original';
  const custom = doc.createElement('style'); custom.id = 'lolkamod-custom-css'; custom.textContent = '.custom {color:red}'; doc.head.append(custom);
  const controller = themes.createThemeController(doc);
  for (const theme of themes.THEMES) {
    controller.apply(theme.id); assert.equal(controller.current(), theme.id);
    assert.equal(doc.documentElement.className, 'dark-theme original');
    assert.equal(custom.textContent, '.custom {color:red}'); assert.equal(custom.isConnected, true);
    const css = themes.themeCss(theme.id);
    assert.doesNotMatch(css, /@import|url\(|https?:/);
    if (theme.id !== 'native') {
      assert.match(css, /html\[data-lolkamod-theme=/); assert.match(css, /\.dark-theme,\.light-theme/);
      assert.match(css, /--color-bg-primary:/); assert.match(css, /--color-text-primary:/);
      assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 1);
    }
  }
  assert.match(themes.themeCss('contrast'), /:focus-visible/);
  assert.throws(() => controller.apply('foreign-theme'), /Неизвестная тема/);
  assert.equal(controller.current(), 'contrast');
  controller.apply('native');
  assert.equal(doc.documentElement.getAttribute('data-lolkamod-theme'), null);
  assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 0);
  controller.apply('graphite'); doc.documentElement.setAttribute('data-lolkamod-theme', 'other-owner');
  controller.stop(); controller.stop();
  assert.equal(doc.documentElement.getAttribute('data-lolkamod-theme'), 'other-owner');
  assert.equal(custom.isConnected, true); assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 0);
});

test('theme controller replacement and repeated switching do not accumulate nodes', () => {
  const doc = new Document(); let controller = themes.createThemeController(doc);
  controller.apply('graphite');
  for (let iteration = 0; iteration < 100; iteration++) {
    controller = themes.createThemeController(doc); controller.apply(iteration % 2 ? 'amoled' : 'contrast');
    assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 1);
  }
  controller.stop(); assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 0);
  assert.equal(doc.documentElement.getAttribute('data-lolkamod-theme'), null);
});

test('indicator distinguishes capture settings, actual encoded metrics and inbound unknown source', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 2000, detailed: true });
  const outgoing = snapshot().streams[0];
  controller.update(snapshot({ streams: [outgoing, { ...outgoing, direction: 'inbound', media: 'unknown', capture: null,
    encoded: null, decoded: { width: 1280, height: 720, fps: 15 }, bitrateKbps: null, qualityLimitationReason: null }] }));
  const model = controller.model();
  assert.equal(model.status, 'live'); assert.equal(model.sampleAgeMs, 1000); assert.equal(model.cards.length, 2);
  const sent = model.cards[0];
  assert.match(sent.summary, /1920 × 1080 · 29\.8 FPS · 1\.80 Мбит\/с · AV1/);
  assert.ok(sent.rows.some(row => row.label === 'FPS в настройках захвата' && row.value === '60 FPS'));
  assert.ok(sent.rows.some(row => row.label === 'Фактический FPS' && row.value === '29.8 FPS'));
  assert.ok(sent.rows.some(row => row.value === 'Нагрузка процессора'));
  assert.equal(sent.rows.some(row => row.label.includes('%')), false, 'packet count is not a loss percentage');
  assert.equal(model.cards[1].title, 'Входящее видео 2');
  assert.match(model.cards[1].summary, /1280 × 720 · 15 FPS · Нет данных/);
  controller.select(model.cards[1].id); assert.equal(controller.model().selectedId, model.cards[1].id);
  model.cards[0].rows[0].value = 'corrupted'; assert.notEqual(controller.model().cards[0].rows[0].value, 'corrupted');
  for (const secret of ['Sensitive desktop title', '192.0.2.1', 'private SDP']) assert.equal(JSON.stringify(controller.model()).includes(secret), false);
  controller.stop();
});

test('indicator no-stream, stale data, missing metrics and lifecycle are truthful without getStats', () => {
  const doc = new Document(); let time = 1000;
  const controller = indicators.createStreamIndicator({ document: doc, enabled: false, now: () => time });
  assert.equal(owned(doc, 'lolkamod-stream-indicator').length, 0);
  controller.update(snapshot()); controller.setEnabled(true);
  assert.equal(owned(doc, 'lolkamod-stream-indicator').length, 1);
  const element = owned(doc, 'lolkamod-stream-indicator')[0];
  const card = element.shadowRoot.children[1];
  time = 10_000; controller.update(snapshot());
  assert.equal(controller.model().status, 'stale'); assert.equal(card.children[2].textContent, 'Ожидание свежих данных');
  const missing = { ...snapshot().streams[0], encoded: null, codec: 'secret injection\n', bitrateKbps: NaN };
  controller.update(snapshot({ sampledAt: time, streams: [missing] }));
  assert.match(controller.model().cards[0].summary, /^Нет данных · Нет данных · Нет данных · Нет данных$/);
  controller.update(snapshot({ streams: [], state: { connections: 0, displayCapture: 0, samples: 3, noStream: true } }));
  assert.equal(controller.model().status, 'idle'); assert.equal(card.hidden, true);
  controller.update(snapshot({ streams: [], state: { connections: 0, displayCapture: 1, samples: 0, noStream: true } }));
  assert.equal(controller.model().status, 'waiting'); assert.equal(card.hidden, false);
  assert.equal(card.children[2].textContent, 'Ожидание показателей видео');
  const select = card.children[0]; assert.equal(select.listenerCount(), 1);
  controller.setEnabled(false); assert.equal(element.isConnected, false);
  controller.stop(); controller.stop(); assert.equal(select.listenerCount(), 0);
  controller.setEnabled(true); assert.equal(owned(doc, 'lolkamod-stream-indicator').length, 0);
});

test('indicator selection follows opaque local stream IDs across RTP reordering and removes vanished streams', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  const first = { ...snapshot().streams[0], streamId: '1:outbound:10' };
  const second = { ...first, streamId: '1:outbound:11', encoded: { width: 640, height: 480, fps: 15 } };
  controller.update(snapshot({ streams: [first, second] }));
  controller.select('1:outbound:11');
  controller.update(snapshot({ streams: [second, first] }));
  assert.equal(controller.model().selectedId, '1:outbound:11');
  assert.match(controller.model().cards.find(card => card.id === '1:outbound:11').summary, /640 × 480/);
  controller.update(snapshot({ streams: [first] })); assert.equal(controller.model().selectedId, '1:outbound:10');
  controller.stop();
});

test('an active native stream without browser RTP shows unavailable metrics instead of claiming no stream', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  controller.update(snapshot({ nativeActive: true, streams: [],
    state: { connections: 0, displayCapture: 0, samples: 3, noStream: true },
    requestedResolution: '1440p', requestedFps: 60 }));
  const model = controller.model();
  assert.equal(model.status, 'unavailable'); assert.equal(model.message, 'Стрим активен; фактические метрики недоступны');
  assert.deepEqual(model.cards, []);
  const element = owned(doc, 'lolkamod-stream-indicator')[0], card = element.shadowRoot.children[1];
  assert.equal(card.hidden, false); assert.equal(card.children[2].textContent, model.message);
  assert.equal(JSON.stringify(model).includes('1440'), false); assert.equal(JSON.stringify(model).includes('60 FPS'), false);
  controller.stop();
});

test('native PiP opens the explicitly chosen video synchronously and preserves existing media', async () => {
  const doc = new Document(); const first = new Video(doc); const second = new Video(doc);
  const controller = miniPlayers.createMiniPlayer({ document: doc });
  assert.equal(controller.capability().reason, 'video-required');
  const opening = controller.open(second);
  assert.equal(second.requestCalls, 1, 'request must precede first await and keep user activation');
  assert.equal(first.requestCalls, 0); assert.equal((await opening).ok, true);
  assert.equal(controller.state().status, 'open'); assert.strictEqual(doc.pictureInPictureElement, second);
  assert.equal(second.listenerCount(), 3); assert.equal(second.track.listenerCount(), 1); assert.equal(doc.observers.size, 1);
  assert.equal((await controller.open(second)).ok, true); assert.equal(second.requestCalls, 1);
  assert.equal((await controller.open(first)).ok, true); assert.strictEqual(doc.pictureInPictureElement, first);
  assert.equal(second.listenerCount(), 0); assert.equal(second.track.listenerCount(), 0); assert.equal(doc.observers.size, 1);
  await controller.close();
  assert.equal(doc.pictureInPictureElement, null); assert.equal(doc.exitCalls, 1);
  assert.equal(first.listenerCount(), 0); assert.equal(doc.observers.size, 0);
  videoUnchanged(first); videoUnchanged(second);
  controller.stop(); assert.equal(doc.defaultView.listenerCount(), 0);
});

test('PiP handles disabled capability and errors without leaking native error text', async () => {
  const doc = new Document(); const video = new Video(doc); const controller = miniPlayers.createMiniPlayer({ document: doc });
  doc.pictureInPictureEnabled = false;
  assert.equal((await controller.open(video)).reason, 'unsupported'); assert.equal(video.requestCalls, 0);
  doc.pictureInPictureEnabled = true; video.disablePictureInPicture = true;
  assert.equal((await controller.open(video)).reason, 'disabled-by-host');
  video.disablePictureInPicture = false; video.readyState = 0;
  assert.equal(controller.capability(video).reason, 'video-unavailable'); video.readyState = 4;
  video.requestPictureInPicture = () => Promise.reject(Object.assign(new Error('private video title'), { name: 'NotAllowedError' }));
  assert.equal((await controller.open(video)).reason, 'user-gesture-required');
  assert.equal(controller.state().message.includes('private'), false);
  assert.equal(video.listenerCount(), 0); assert.equal(video.track.listenerCount(), 0); assert.equal(doc.observers.size, 0);
  controller.stop(); videoUnchanged(video);
});

test('PiP cleanup on native close, video removal and ended tracks preserves unrelated host PiP', async () => {
  const doc = new Document(); const video = new Video(doc); const other = new Video(doc);
  const controller = miniPlayers.createMiniPlayer({ document: doc });
  await controller.open(video);
  doc.pictureInPictureElement = null; video.dispatch('leavepictureinpicture');
  assert.equal(controller.state().status, 'idle'); assert.equal(video.listenerCount(), 0); assert.equal(doc.observers.size, 0);
  await controller.open(video); video.remove(); doc.mutate(); await flush();
  assert.equal(doc.pictureInPictureElement, null); assert.equal(video.track.listenerCount(), 0); assert.equal(doc.observers.size, 0);
  doc.body.append(video); await controller.open(video); video.track.end(); await flush();
  assert.equal(doc.pictureInPictureElement, null); assert.equal(video.track.stopCalls, 0);
  doc.pictureInPictureElement = other; const exits = doc.exitCalls;
  controller.stop(); await flush(); assert.strictEqual(doc.pictureInPictureElement, other); assert.equal(doc.exitCalls, exits);
  assert.equal(doc.defaultView.listenerCount(), 0); videoUnchanged(other);
});

test('a pending PiP request is cancelled on stop, with no orphan window or media mutation', async () => {
  const doc = new Document(); const video = new Video(doc);
  let resolve;
  video.requestPictureInPicture = () => new Promise(done => { resolve = () => { doc.pictureInPictureElement = video; done({}); }; });
  const controller = miniPlayers.createMiniPlayer({ document: doc });
  const opening = controller.open(video);
  assert.equal((await controller.open(video)).reason, 'operation-in-progress');
  controller.stop(); resolve();
  assert.equal((await opening).reason, 'stopped'); await flush();
  assert.equal(doc.pictureInPictureElement, null); assert.equal(doc.exitCalls, 1);
  assert.equal(controller.state().status, 'stopped'); assert.equal(controller.capability(video).reason, 'stopped');
  assert.equal(video.listenerCount(), 0); assert.equal(video.track.listenerCount(), 0); assert.equal(doc.observers.size, 0);
  assert.equal(doc.defaultView.listenerCount(), 0); videoUnchanged(video);
});

test('replacing a controller during a pending request preserves the replacement-owned PiP', async () => {
  const doc = new Document(); const video = new Video(doc);
  let resolveOld;
  const nativeRequest = video.requestPictureInPicture.bind(video);
  video.requestPictureInPicture = () => new Promise(done => {
    resolveOld = () => { doc.pictureInPictureElement = video; done({}); };
  });
  const old = miniPlayers.createMiniPlayer({ document: doc });
  const oldRequest = old.open(video);
  const replacement = miniPlayers.createMiniPlayer({ document: doc });
  assert.equal(old.state().status, 'stopped');
  video.requestPictureInPicture = nativeRequest;
  assert.equal((await replacement.open(video)).ok, true);
  resolveOld(); assert.equal((await oldRequest).reason, 'stopped');
  assert.strictEqual(doc.pictureInPictureElement, video); assert.equal(doc.exitCalls, 0);
  assert.equal(video.listenerCount(), 3); assert.equal(doc.observers.size, 1);
  replacement.stop(); await flush();
  assert.equal(doc.pictureInPictureElement, null); assert.equal(doc.defaultView.listenerCount(), 0);
  videoUnchanged(video);
});
