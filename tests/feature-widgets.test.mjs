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
const [themes, indicators, brand] = await Promise.all([
  sourceModule('theme-manager'), sourceModule('stream-indicator'), sourceModule('../shared/brand'),
]);

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(fn); this.listeners.set(type, listeners);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, extra = {}) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this,
    preventDefault() {}, stopPropagation() {}, ...extra }); }
  listenerCount() { return [...this.listeners.values()].reduce((count, values) => count + values.size, 0); }
}
class Element extends Events {
  parent = null; children = []; attributes = new Map(); dataset = {}; textContent = ''; hidden = false;
  className = ''; value = ''; id = '';
  style = {}; bounds = { left: 400, top: 300, right: 418, bottom: 318, width: 18, height: 18 };
  constructor(tag, doc) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc; }
  get isConnected() { return this === this.ownerDocument.documentElement || !!this.parent?.isConnected; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  getBoundingClientRect() { return this.className === 'tooltip'
    ? { left: 0, top: 0, right: 280, bottom: 200, width: 280, height: 200 } : this.bounds; }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this);
    this.parent = null;
  }
  replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.append(...items); }
  attachShadow() { const shadow = new Element('shadow', this.ownerDocument); shadow.parent = this; this.shadowRoot = shadow; return shadow; }
}
class Document extends Events {
  constructor() {
    super();
    this.documentElement = new Element('html', this);
    this.head = new Element('head', this); this.body = new Element('body', this);
    this.documentElement.append(this.head, this.body);
    this.defaultView = new Events();
    this.defaultView.innerWidth = 1280; this.defaultView.innerHeight = 720;
  }
  createElement(tag) { return new Element(tag, this); }
  createElementNS(_namespace, tag) { return new Element(tag, this); }
}
const owned = (doc, id) => [...doc.head.children, ...doc.body.children].filter(element => element.id === id);
const anchor = doc => { const element = doc.createElement('span'); element.className = 'host-stream-heading'; doc.body.append(element); return element; };
const icon = container => container.children.find(element => element.getAttribute('data-lolkamod-owned') === 'stream-indicator');
const popup = doc => doc.body.children.find(element => element.getAttribute('data-lolkamod-owned') === 'stream-tooltip');

test('inline LM marks keep their cutouts and mask IDs independent across repeated panels', () => {
  const doc = new Document(), ids = new Set();
  for (let index = 0; index < 100; index++) {
    const variant = index % 2 ? 'sidebar' : 'regular';
    const svg = brand.createBrandMark(doc, variant, variant === 'sidebar' ? 24 : 38);
    const [defs, hex] = svg.children, mask = defs.children[0], id = mask.getAttribute('id');
    assert.equal(ids.has(id), false); ids.add(id);
    assert.equal(svg.getAttribute('data-lolkamod-brand'), variant);
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(hex.getAttribute('mask'), `url(#${id})`);
    assert.equal(hex.getAttribute('fill'), 'currentColor', 'native menu colors come from the surrounding tab');
    assert.equal(mask.getAttribute('maskUnits'), 'userSpaceOnUse');
    assert.equal(mask.children[0].getAttribute('fill'), 'white');
    assert.equal(mask.children.length, 3, 'LM cutouts have two independent, round-ended paths');
    for (const path of mask.children.slice(1)) {
      assert.equal(path.getAttribute('fill'), 'none'); assert.equal(path.getAttribute('stroke'), 'black');
      assert.equal(path.getAttribute('stroke-width'), String(brand.BRAND_CUTOUTS[variant].width));
      assert.equal(path.getAttribute('stroke-linecap'), 'round');
    }
    doc.body.append(svg); svg.remove();
  }
  assert.equal(ids.size, 100); assert.equal(doc.body.children.length, 0);
});

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
  assert.equal(controller.current(), themes.THEMES.at(-1).id);
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

test('custom palette edits replace the current CSS, reject malformed colors before mutation and clean up to native', () => {
  const doc = new Document(); doc.documentElement.className = 'dark-theme original';
  const controller = themes.createThemeController(doc);
  const custom = { mode: 'dark', colors: ['#322b54'], saturation: 80 };
  controller.apply('custom', custom);
  const style = owned(doc, 'lolkamod-built-in-theme')[0], previous = style.textContent;
  controller.apply('custom', { mode: 'light', colors: ['#0088ff', '#ff4488'], saturation: 40 });
  assert.notEqual(style.textContent, previous); assert.match(style.textContent, /color-scheme:light/);
  assert.match(style.textContent, /background-image:linear-gradient/);
  assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 1);
  const before = style.textContent;
  assert.throws(() => controller.apply('custom', { ...custom, colors: ['#bad'] }), /Invalid custom theme/);
  assert.equal(style.textContent, before); assert.equal(controller.current(), 'custom');
  controller.apply('native'); assert.equal(owned(doc, 'lolkamod-built-in-theme').length, 0);
  assert.equal(doc.documentElement.getAttribute('data-lolkamod-theme'), null);
  assert.equal(doc.documentElement.className, 'dark-theme original'); controller.stop();
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
  const container = anchor(doc);
  const controller = indicators.createStreamIndicator({ document: doc, enabled: false, now: () => time });
  assert.equal(icon(container), undefined); assert.equal(popup(doc), undefined);
  const dispose = controller.attach(container, { ownScreen: true });
  const element = icon(container), button = element.shadowRoot.children[1];
  assert.equal(element.hidden, true); assert.equal(popup(doc), undefined);
  controller.update(snapshot()); controller.setEnabled(true);
  assert.equal(element.hidden, false); assert.equal(container.children.length, 1);
  assert.equal(popup(doc), undefined, 'no floating card exists until hovering the compact icon');
  button.dispatch('mouseenter');
  assert.ok(popup(doc));
  time = 10_000; controller.update(snapshot());
  assert.equal(controller.model(container).status, 'stale');
  assert.equal(popup(doc).shadowRoot.children[1].children[1].textContent, 'Ожидание свежих данных');
  const missing = { ...snapshot().streams[0], encoded: null, codec: 'secret injection\n', bitrateKbps: NaN };
  controller.update(snapshot({ sampledAt: time, streams: [missing] }));
  assert.match(controller.model().cards[0].summary, /^Нет данных · Нет данных · Нет данных · Нет данных$/);
  controller.update(snapshot({ streams: [], state: { connections: 0, displayCapture: 0, samples: 3, noStream: true } }));
  assert.equal(controller.model(container).status, 'idle'); assert.equal(element.hidden, true); assert.equal(popup(doc), undefined);
  controller.update(snapshot({ streams: [], state: { connections: 0, displayCapture: 1, samples: 0, noStream: true } }));
  assert.equal(controller.model(container).status, 'waiting'); assert.equal(element.hidden, false);
  button.dispatch('mouseenter');
  assert.equal(popup(doc).shadowRoot.children[1].children[1].textContent, 'Ожидание показателей видео');
  assert.equal(button.listenerCount(), 6);
  controller.setEnabled(false); assert.equal(element.hidden, true); assert.equal(popup(doc), undefined);
  dispose(); controller.stop(); controller.stop(); assert.equal(button.listenerCount(), 0);
  controller.setEnabled(true); assert.equal(container.children.length, 0); assert.equal(popup(doc), undefined);
  assert.equal(doc.listenerCount(), 0); assert.equal(doc.defaultView.listenerCount(), 0);
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
  const container = anchor(doc); controller.attach(container, { ownScreen: true });
  controller.update(snapshot({ nativeActive: true, streams: [],
    state: { connections: 0, displayCapture: 0, samples: 3, noStream: true },
    requestedResolution: '1440p', requestedFps: 60 }));
  const model = controller.model(container);
  assert.equal(model.status, 'unavailable'); assert.equal(model.message, 'Стрим активен; фактические метрики недоступны');
  assert.deepEqual(model.cards, []);
  const element = icon(container), button = element.shadowRoot.children[1];
  assert.equal(element.hidden, false); assert.equal(popup(doc), undefined);
  button.dispatch('focus');
  assert.equal(popup(doc).shadowRoot.children[1].children[1].textContent, model.message);
  assert.equal(JSON.stringify(model).includes('1440'), false); assert.equal(JSON.stringify(model).includes('60 FPS'), false);
  controller.stop();
});

test('compact icon exposes actual metrics on hover and keyboard focus, with one temporary body tooltip', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  const container = anchor(doc); controller.attach(container, { ownScreen: true }); controller.update(snapshot());
  const element = icon(container), button = element.shadowRoot.children[1];
  assert.equal(container.children.length, 1); assert.equal(button.tagName, 'BUTTON');
  assert.match(element.shadowRoot.children[0].textContent, /width:18px;height:18px/);
  assert.doesNotMatch(element.shadowRoot.children[0].textContent, /position:fixed/);
  assert.equal(popup(doc), undefined);
  button.dispatch('mouseenter');
  const portal = popup(doc), tooltip = portal.shadowRoot.children[1];
  assert.equal(tooltip.getAttribute('role'), 'tooltip'); assert.equal(tooltip.children[0].textContent, 'Мой стрим');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const text = tooltip.children[2].children.map(child => child.textContent).join('|');
  assert.match(text, /1920 × 1080/); assert.match(text, /29\.8 FPS/); assert.match(text, /1\.80 Мбит\/с/); assert.match(text, /AV1/);
  assert.doesNotMatch(text, /60 FPS|FPS в настройках захвата/);
  assert.equal(button.dataset.state, 'limited');
  assert.equal(tooltip.style.left, '138px'); assert.equal(tooltip.style.top, '92px');
  button.dispatch('mouseleave'); assert.equal(popup(doc), undefined); assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.dispatch('focus'); assert.ok(popup(doc));
  controller.setDetailed(true);
  assert.ok(popup(doc).shadowRoot.children[1].children[2].children.some(child => child.textContent === 'FPS в настройках захвата'));
  button.dispatch('keydown', { key: 'Escape' }); assert.equal(popup(doc), undefined);
  controller.update(snapshot()); assert.equal(popup(doc), undefined, 'refresh does not reopen an Escape-dismissed tooltip');
  button.dispatch('blur'); button.dispatch('focus'); assert.ok(popup(doc));
  button.dispatch('blur'); assert.equal(popup(doc), undefined);
  controller.stop();
});

test('video-specific tooltip requires proven track association and resolves it again after reconnect', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  const mapped = anchor(doc), unknown = anchor(doc); let id = '1:inbound:20';
  controller.attach(mapped, { streamId: () => id }); controller.attach(unknown);
  const outgoing = { ...snapshot().streams[0], streamId: '1:outbound:10' };
  const incoming = { ...outgoing, streamId: '1:inbound:20', direction: 'inbound', media: 'unknown', capture: null,
    encoded: null, decoded: { width: 1280, height: 720, fps: 15 } };
  controller.update(snapshot({ streams: [outgoing, incoming] }));
  assert.equal(controller.model(mapped).selectedId, id); assert.match(controller.model(mapped).cards[0].summary, /1280 × 720/);
  assert.equal(controller.model(unknown).status, 'unavailable'); assert.equal(controller.model(unknown).message, 'Метрики этого видео не сопоставлены');
  assert.deepEqual(controller.model(unknown).cards, [], 'unmapped incoming video never borrows own-stream metrics');
  const mappedButton = icon(mapped).shadowRoot.children[1]; mappedButton.dispatch('mouseenter');
  assert.match(popup(doc).shadowRoot.children[1].children[2].children.map(child => child.textContent).join('|'), /15 FPS/);
  id = '2:inbound:21'; controller.update(snapshot({ streams: [{ ...incoming, connectionId: 2, streamId: id,
    decoded: { width: 2560, height: 1440, fps: 59.5 } }] }));
  assert.equal(controller.model(mapped).selectedId, id); assert.match(controller.model(mapped).cards[0].summary, /2560 × 1440 · 59\.5 FPS/);
  mappedButton.dispatch('mouseleave'); id = undefined; mappedButton.dispatch('mouseenter');
  assert.equal(controller.model(mapped).status, 'unavailable', 'hover rechecks video association between collector updates');
  assert.equal(popup(doc).shadowRoot.children[1].children[1].textContent, 'Метрики этого видео не сопоставлены');
  controller.update(snapshot({ streams: [outgoing, incoming] }));
  assert.equal(controller.model(mapped).status, 'unavailable'); assert.deepEqual(controller.model(mapped).cards, []);
  controller.stop();
});

test('ambiguous own streams remain unmapped and only one tooltip opens across multiple stream anchors', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  const first = anchor(doc), second = anchor(doc); controller.attach(first, { ownScreen: true }); controller.attach(second);
  const stream = snapshot().streams[0]; controller.update(snapshot({ streams: [stream, { ...stream, connectionId: 2 }] }));
  assert.equal(controller.model(first).status, 'unavailable'); assert.deepEqual(controller.model(first).cards, []);
  const firstButton = icon(first).shadowRoot.children[1], secondButton = icon(second).shadowRoot.children[1];
  firstButton.dispatch('mouseenter'); const firstPortal = popup(doc);
  secondButton.dispatch('focus'); assert.notStrictEqual(popup(doc), firstPortal); assert.equal(firstPortal.isConnected, false);
  assert.equal(doc.body.children.filter(element => element.getAttribute('data-lolkamod-owned') === 'stream-tooltip').length, 1);
  secondButton.bounds = { left: 2, top: 2, right: 20, bottom: 20, width: 18, height: 18 };
  doc.defaultView.dispatch('resize');
  const tooltip = popup(doc).shadowRoot.children[1]; assert.equal(tooltip.style.left, '8px'); assert.equal(tooltip.style.top, '28px');
  controller.detach(second); assert.equal(popup(doc), undefined); assert.equal(second.children.length, 0);
  assert.equal(secondButton.listenerCount(), 0); controller.stop();
});

test('repeated anchor attachment, disable, disposal and disconnected streams leave no tooltip or listeners', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  const container = anchor(doc); const firstDispose = controller.attach(container, { ownScreen: true });
  const dispose = controller.attach(container, { ownScreen: true }); firstDispose();
  assert.equal(container.children.length, 1, 'an older host-effect disposer cannot remove a replacement attachment');
  controller.update(snapshot()); const button = icon(container).shadowRoot.children[1];
  button.dispatch('mouseenter'); assert.ok(popup(doc));
  container.remove(); controller.update(snapshot()); assert.equal(popup(doc), undefined);
  doc.body.append(container); controller.setEnabled(false); assert.equal(icon(container).hidden, true);
  controller.setEnabled(true); assert.equal(icon(container).hidden, false);
  assert.equal(popup(doc), undefined, 'disable/disconnection clears stale hover state');
  dispose(); assert.equal(container.children.length, 0); assert.equal(button.listenerCount(), 0);
  assert.equal(doc.listenerCount(), 0); assert.equal(doc.defaultView.listenerCount(), 0);
  controller.stop(); assert.equal(popup(doc), undefined);
  assert.equal(controller.attach(container, { ownScreen: true })(), undefined); assert.equal(container.children.length, 0);
});

test('requested native settings are explicitly separate from unavailable measured values and active state', () => {
  const doc = new Document(); const controller = indicators.createStreamIndicator({ document: doc, now: () => 1000 });
  const own = anchor(doc), incoming = anchor(doc); let active = true;
  const requested = () => ({ resolution: '1440p', fps: 60, codec: 'av1' });
  controller.attach(own, { ownScreen: true, active: () => active, requested });
  controller.attach(incoming, { active: () => true, requested });
  controller.update(snapshot({ nativeActive: true, streams: [],
    state: { connections: 0, displayCapture: 0, samples: 2, noStream: true } }));
  const model = controller.model(own); assert.equal(model.status, 'unavailable'); assert.deepEqual(model.cards, []);
  assert.deepEqual(model.requested, { resolution: '1440p', fps: 60, codec: 'AV1' });
  assert.equal(controller.model(incoming).requested, undefined, 'requested own profile is never shown for another video');
  const button = icon(own).shadowRoot.children[1]; button.dispatch('focus');
  const text = popup(doc).shadowRoot.children[1].children[1].textContent;
  assert.equal(text, 'Выбрано: 1440p · 60 FPS · AV1\nСтрим активен; фактические метрики недоступны');
  assert.equal(popup(doc).shadowRoot.children[1].children[2].hidden, true, 'no requested values in the measurements table');
  model.requested.fps = 15; assert.equal(controller.model(own).requested.fps, 60);
  active = false; controller.update(snapshot()); assert.equal(icon(own).hidden, true); assert.equal(popup(doc), undefined);
  controller.stop();
});
