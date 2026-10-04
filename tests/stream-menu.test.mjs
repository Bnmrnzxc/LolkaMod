import assert from 'node:assert/strict';
import test from 'node:test';
import { setMaxListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/stream-menu.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false, logLevel: 'silent',
});
const { mountStreamMenu } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const settingsCompiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/renderer/feature-settings.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false, logLevel: 'silent',
});
const { mountFeatureSettings } = await import(`data:text/javascript;base64,${Buffer.from(settingsCompiled.outputFiles[0].text).toString('base64')}`);

class Events {
  listeners = new Map();
  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
    if (options.signal) {
      setMaxListeners(0, options.signal);
      options.signal.addEventListener('abort', () => this.removeEventListener(type, listener), { once: true });
    }
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, composedPath: () => [this], ...extra };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

class Element extends Events {
  parent = null; children = []; attributes = new Map(); textContent = ''; hidden = false; disabled = false;
  className = ''; style = {}; dataset = {}; bounds = { left: 450, right: 500, top: 500, bottom: 540, width: 50, height: 40 };
  offsetWidth = 280; offsetHeight = 280; storedValue = '';
  constructor(tag, document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  get value() { return this.storedValue; }
  set value(value) { this.storedValue = String(value); }
  get isConnected() { return this === this.ownerDocument.documentElement || !!this.parent?.isConnected; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  getBoundingClientRect() { return this.bounds; }
  append(...items) {
    for (const item of items) { item.remove(); item.parent = this; this.children.push(item); }
    if (this.tagName === 'SELECT' && !this.value && this.options.length) this.value = this.options[0].value;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  replaceChildren(...items) {
    for (const item of [...this.children]) item.remove();
    if (this.tagName === 'SELECT') this.value = '';
    this.append(...items);
  }
  attachShadow() {
    const shadow = new Element('shadow', this.ownerDocument); shadow.parent = this; this.shadowRoot = shadow; return shadow;
  }
  cloneNode(deep = false) {
    const clone = new Element(this.tagName, this.ownerDocument);
    clone.textContent = this.textContent; clone.className = this.className; clone.value = this.value;
    for (const [key, value] of this.attributes) clone.setAttribute(key, value);
    if (deep) clone.append(...this.children.map(child => child.cloneNode(true)));
    return clone;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

class Document extends Events {
  constructor() {
    super();
    this.documentElement = new Element('html', this); this.documentElement.clientWidth = 1280;
    this.body = new Element('body', this); this.documentElement.append(this.body);
    this.defaultView = new Events();
  }
  createElement(tag) { return new Element(tag, this); }
}

class Storage {
  values = new Map([
    ['screenShareResolution', '720p'], ['screenShareFps', '30'], ['screenShareCodecV3', 'vp9'],
    ['unrelated-client-setting', 'unchanged'],
  ]);
  writes = [];
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.writes.push([key, String(value)]); this.values.set(key, String(value)); }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants), ...(element.shadowRoot ? descendants(element.shadowRoot) : [])];
}
function visible(element) {
  for (let node = element; node; node = node.parent) if (node.hidden) return false;
  return true;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function withMenu(callback, { own = true, active = true } = {}) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Storage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  const doc = new Document(), container = doc.createElement('span'); doc.body.append(container);
  const settings = {
    schemaVersion: 1, enabled: false, customCss: '', qualityEnabled: false,
    profile: { resolution: '1440p', fps: 30, codec: 'auto', bitrateMbps: 16 },
    themeId: 'native', indicatorEnabled: false, indicatorDetailed: false, streamMenuEnabled: true,
  };
  const subscribers = new Set(), featureSaves = [], qualityCalls = [];
  const behavior = { quality: async () => ({ success: true }) };
  const host = {
    active: () => ({ resolution: '720p', fps: 30, codec: 'vp9' }),
    setQuality(profile) { qualityCalls.push({ ...profile }); return behavior.quality(profile); },
  };
  const features = {
    settings: () => ({ ...settings }),
    save: async patch => { featureSaves.push({ ...patch }); Object.assign(settings, patch); for (const subscriber of subscribers) subscriber(); },
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    reset: async () => {}, checkUpdates: async () => ({ state: 'current', installed: 'test' }),
    updateStatus: () => ({ state: 'current', installed: 'test' }), openRelease: async () => {},
    capabilities: () => ({ settings: true, controls: true }),
  };
  const propsCalls = { stop: 0, source: 0 };
  const controller = mountStreamMenu(container, {
    active, own, onStop: () => { propsCalls.stop++; }, onSource: async () => { propsCalls.source++; },
  }, { features, adapter: () => host });
  const hostElement = container.children[0];
  const portal = doc.body.children.find(element => element.className === 'lolkamod-stream-menu-portal');
  const menu = portal.shadowRoot.children.find(element => element.className === 'menu');
  const select = label => descendants(menu).find(element => element.tagName === 'SELECT' && element.getAttribute('aria-label') === label);
  const button = text => descendants(menu).find(element => element.tagName === 'BUTTON' && element.textContent === text);
  const controls = {
    resolution: select('Разрешение стрима'), fps: select('Частота кадров стрима'), codec: select('Кодек стрима'),
  };
  const status = descendants(menu).find(element => element.getAttribute('role') === 'status');
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; controller(); } };
  try {
    await callback({ doc, container, portal, menu, hostElement, arrow: hostElement.shadowRoot.children[1],
      controls, status, button, controller, dispose, host, behavior, settings, subscribers,
      storage, features, featureSaves, qualityCalls, propsCalls });
  } finally {
    dispose();
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior);
    else delete globalThis.localStorage;
  }
}

test('quality selector changes apply immediately with no separate apply button', async () => {
  await withMenu(async ({ controller, menu, controls, qualityCalls, storage, featureSaves }) => {
    controller.open();
    assert.equal(descendants(menu).some(element => element.tagName === 'BUTTON' && /Применить качество/i.test(element.textContent)), false);
    controls.resolution.value = '1440p'; controls.resolution.dispatch('change');
    assert.deepEqual(qualityCalls, [{ resolution: '1440p', fps: 30, codec: 'vp9' }], 'selector dispatch calls host without another user action');
    await flush();
    controls.fps.value = '60'; controls.fps.dispatch('change');
    assert.deepEqual(qualityCalls[1], { resolution: '1440p', fps: 60, codec: 'vp9' });
    await flush();
    controls.codec.value = 'H264'; controls.codec.dispatch('change');
    assert.deepEqual(qualityCalls[2], { resolution: '1440p', fps: 60, codec: 'h264' });
    await flush();
    assert.equal(storage.getItem('screenShareResolution'), '1440p');
    assert.equal(storage.getItem('screenShareFps'), '60');
    assert.equal(storage.getItem('screenShareCodecV3'), 'h264');
    assert.deepEqual([...new Set(storage.writes.map(([key]) => key))].sort(), ['screenShareCodecV3', 'screenShareFps', 'screenShareResolution']);
    assert.equal(storage.getItem('unrelated-client-setting'), 'unchanged');
    assert.deepEqual(featureSaves, [], 'native quality changes do not persist an independent mod profile');
  });
});

test('pending quality operation disables selectors, saves only after success, and reenables controls', async () => {
  await withMenu(async ({ controller, controls, behavior, storage, qualityCalls, status }) => {
    const pending = deferred(); behavior.quality = () => pending.promise;
    controller.open(); controls.resolution.value = '1080p'; controls.resolution.dispatch('change');
    assert.equal(qualityCalls.length, 1);
    for (const control of Object.values(controls)) assert.equal(control.disabled, true);
    assert.deepEqual(storage.writes, [], 'pending operation must not claim a persisted success');
    controls.resolution.dispatch('change');
    assert.equal(qualityCalls.length, 1, 'a second change event is ignored while the first operation is pending');
    pending.resolve({ success: true }); await flush();
    for (const control of Object.values(controls)) assert.equal(control.disabled, false);
    assert.equal(storage.getItem('screenShareResolution'), '1080p');
    assert.equal(status.textContent, 'Качество изменено.');
  });
});

test('successful async quality operation persists the profile that was applied, not later selector mutations', async () => {
  await withMenu(async ({ controller, controls, behavior, storage, qualityCalls }) => {
    const pending = deferred(); behavior.quality = () => pending.promise;
    controller.open(); controls.resolution.value = '1440p'; controls.resolution.dispatch('change');
    assert.deepEqual(qualityCalls[0], { resolution: '1440p', fps: 30, codec: 'vp9' });
    // A late host render or scripted change must not save values that the adapter never accepted.
    controls.resolution.value = '1080p'; controls.fps.value = '60'; controls.codec.value = 'AV1';
    controls.fps.dispatch('change'); assert.equal(qualityCalls.length, 1);
    pending.resolve({ success: true }); await flush();
    assert.equal(storage.getItem('screenShareResolution'), '1440p');
    assert.equal(storage.getItem('screenShareFps'), '30');
    assert.equal(storage.getItem('screenShareCodecV3'), 'vp9');
  });
});

test('failed or rejected quality changes do not save false success and restore usable selectors', async () => {
  await withMenu(async ({ controller, controls, behavior, storage, status, menu }) => {
    controller.open(); behavior.quality = async () => ({ success: false, error: 'private host error' });
    controls.resolution.value = '1440p'; controls.resolution.dispatch('change'); await flush();
    assert.deepEqual(storage.writes, []);
    assert.equal(storage.getItem('screenShareResolution'), '720p');
    assert.equal(menu.hidden, false);
    assert.match(status.textContent, /Действие не удалось/); assert.doesNotMatch(status.textContent, /private/);
    for (const control of Object.values(controls)) assert.equal(control.disabled, false);
    behavior.quality = async () => { throw new Error('private rejected error'); };
    controls.codec.value = 'AV1'; controls.codec.dispatch('change'); await flush();
    assert.deepEqual(storage.writes, []);
    assert.equal(storage.getItem('screenShareCodecV3'), 'vp9');
    for (const control of Object.values(controls)) assert.equal(control.disabled, false);
    assert.doesNotMatch(status.textContent, /private/);
  });
});

test('source, stop and indicator actions remain usable without any mini-player controls', async () => {
  await withMenu(async ({ controller, button, menu, status, featureSaves, propsCalls }) => {
    controller.open();
    assert.equal(descendants(menu).filter(element => element.tagName === 'SELECT').length, 3);
    assert.equal(button('Мини-плеер'), undefined);
    button('Изменить источник').dispatch('click'); await flush();
    assert.equal(propsCalls.source, 1); assert.equal(menu.hidden, true);
    assert.match(status.textContent, /штатный выбор/);
    controller.open(); button('Показать индикатор').dispatch('click'); await flush();
    assert.deepEqual(featureSaves, [{ indicatorEnabled: true }]);
    assert.equal(button('Скрыть индикатор').disabled, false);
    button('Прекратить стрим').dispatch('click'); await flush();
    assert.equal(propsCalls.stop, 1); assert.equal(menu.hidden, true);
    assert.equal(status.textContent, 'Стрим остановлен.');
  });
});

test('feature settings retain themes, indicator and stream menu without mini-player toggle or capability text', async () => {
  await withMenu(async ({ doc, features, subscribers, featureSaves }) => {
    const container = doc.createElement('section'); doc.body.append(container);
    const dispose = mountFeatureSettings(container, features);
    try {
      const nodes = descendants(container);
      const toggles = nodes.filter(element => element.tagName === 'INPUT');
      assert.deepEqual(toggles.map(element => element.dataset.setting).sort(),
        ['indicatorDetailed', 'indicatorEnabled', 'streamMenuEnabled']);
      assert.equal(nodes.filter(element => element.tagName === 'SELECT').length, 1);
      assert.equal(nodes.find(element => element.dataset.setting === 'themeId').options.length, 4);
      assert.doesNotMatch(nodes.map(element => element.textContent).join('\n'), /Мини-плеер|PiP/);
      const indicator = toggles.find(element => element.dataset.setting === 'indicatorEnabled');
      indicator.checked = true; indicator.dispatch('change'); await flush();
      assert.deepEqual(featureSaves, [{ indicatorEnabled: true }]);
      assert.equal(subscribers.size, 2);
    } finally { dispose(); }
    assert.equal(container.children.length, 0); assert.equal(subscribers.size, 1);
  });
});

test('remote stream menu hides source, quality and stop but keeps viewer actions available', async () => {
  await withMenu(async ({ controller, controls, button, menu, propsCalls }) => {
    controller.open();
    assert.equal(menu.hidden, false);
    assert.equal(visible(button('Изменить источник')), false);
    assert.equal(visible(button('Прекратить стрим')), false);
    for (const control of Object.values(controls)) assert.equal(visible(control), false);
    assert.equal(button('Мини-плеер'), undefined);
    assert.equal(descendants(menu).find(element => element.getAttribute('aria-label') === 'Видео для мини-плеера'), undefined);
    assert.equal(visible(button('Показать индикатор')), true);
    assert.equal(propsCalls.stop, 0); assert.equal(propsCalls.source, 0);
  }, { own: false });
});

test('external-anchor popup uses a top-level portal, retains inside clicks and cleans up only owned nodes/listeners', async () => {
  await withMenu(async ({ doc, controller, menu, portal, container, hostElement, arrow, subscribers, dispose }) => {
    const anchor = doc.createElement('button'), unrelated = doc.createElement('span'); doc.body.append(anchor, unrelated);
    let unrelatedEvents = 0; doc.addEventListener('pointerdown', () => { unrelatedEvents++; });
    controller.open(anchor);
    assert.strictEqual(portal.parent, doc.body, 'popup escapes transformed native control ancestors');
    assert.strictEqual(hostElement.parent, container, 'trigger remains inside its native toolbar container');
    assert.equal(menu.hidden, false); assert.equal(arrow.getAttribute('aria-expanded'), 'true');
    assert.match(menu.style.left, /^\d+px$/); assert.match(menu.style.top, /^\d+px$/);
    doc.dispatch('pointerdown', { composedPath: () => [menu, portal.shadowRoot, portal, doc.body] });
    assert.equal(menu.hidden, false);
    doc.dispatch('pointerdown', { composedPath: () => [anchor, doc.body] });
    assert.equal(menu.hidden, false, 'external controlling anchor is treated as owned popup context');
    doc.dispatch('pointerdown', { composedPath: () => [unrelated, doc.body] });
    assert.equal(menu.hidden, true); assert.equal(arrow.getAttribute('aria-expanded'), 'false');
    controller.toggle(anchor); assert.equal(menu.hidden, false);
    controller.toggle(anchor); assert.equal(menu.hidden, true);
    controller.open(anchor); doc.dispatch('keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true); assert.strictEqual(doc.activeElement, arrow);
    controller.open(anchor); doc.defaultView.dispatch('resize'); assert.equal(menu.hidden, true);
    assert.equal(subscribers.size, 1); dispose();
    assert.equal(hostElement.isConnected, false); assert.equal(portal.isConnected, false);
    assert.equal(container.isConnected, true); assert.equal(anchor.isConnected, true); assert.equal(unrelated.isConnected, true);
    assert.equal(subscribers.size, 0); assert.equal(doc.defaultView.listenerCount(), 0); assert.equal(arrow.listenerCount(), 0);
    assert.equal(doc.listenerCount(), 1, 'outside-click cleanup preserves unrelated document listener');
    const before = unrelatedEvents; doc.dispatch('pointerdown'); assert.equal(unrelatedEvents, before + 1);
  });
});

test('active native codec remains selectable when Chromium capability list does not expose it', async () => {
  await withMenu(async ({ doc, controller, host, controls, menu }) => {
    host.active = () => ({ resolution: '1440p', fps: 60, codec: 'av1' });
    doc.defaultView.RTCRtpSender = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) };
    controller.open();
    assert.equal(menu.hidden, false); assert.equal(controls.codec.value, 'AV1');
    assert.equal(controls.codec.options.find(option => option.value === 'AV1').disabled, false);
    assert.equal(controls.codec.options.find(option => option.value === 'VP9').disabled, true);
  });
});
