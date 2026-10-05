import assert from 'node:assert/strict';
import test from 'node:test';
import { setMaxListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(relative) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const [{ mountFeatureSettings }, { THEMES }, { DEFAULT_CUSTOM_THEME }] = await Promise.all([
  load('../src/renderer/feature-settings.ts'), load('../src/renderer/theme-manager.ts'),
  load('../src/shared/themes.ts'),
]);

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
    const event = { type, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}
class Element extends Events {
  parent = null; children = []; attributes = new Map(); textContent = ''; hidden = false; disabled = false;
  className = ''; style = {}; dataset = {}; tabIndex = 0; title = ''; value = '';
  constructor(tag, document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus() { this.ownerDocument.activeElement = this; this.dispatch('focus'); }
}
class Document {
  activeElement = null;
  constructor() { this.body = this.createElement('body'); }
  createElement(tag) { return new Element(tag, this); }
  createElementNS(namespace, tag) { const element = this.createElement(tag); element.namespaceURI = namespace; return element; }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness({ initial = 'native', manual = false } = {}) {
  const doc = new Document(), container = doc.createElement('section'); doc.body.append(container);
  const settings = { schemaVersion: 1, enabled: true, customCss: '', qualityEnabled: false,
    profile: { resolution: '1440p', fps: 60, codec: 'auto', bitrateMbps: 16 },
    themeId: initial, customTheme: structuredClone(DEFAULT_CUSTOM_THEME), indicatorEnabled: false, indicatorDetailed: false, streamMenuEnabled: true };
  const subscribers = new Set(), requests = [];
  let active = 0, maximumActive = 0, unsubscribed = 0;
  const behavior = { reset: async () => { settings.themeId = 'native'; settings.customTheme = structuredClone(DEFAULT_CUSTOM_THEME); notify(); },
    updates: async () => ({ state: 'current', installed: 'test' }), open: async () => {} };
  function notify() { for (const subscriber of subscribers) subscriber(); }
  const options = {
    settings: () => structuredClone(settings),
    async save(patch) {
      const pending = deferred(); requests.push({ patch: structuredClone(patch), pending });
      active++; maximumActive = Math.max(maximumActive, active);
      try {
        if (manual) await pending.promise;
        Object.assign(settings, structuredClone(patch)); notify();
      } finally { active--; }
    },
    subscribe(callback) { subscribers.add(callback); return () => { unsubscribed++; subscribers.delete(callback); }; },
    reset: () => behavior.reset(), checkUpdates: () => behavior.updates(), openRelease: () => behavior.open(),
    updateStatus: () => ({ state: 'current', installed: 'test' }), capabilities: () => ({ settings: true, controls: true }),
  };
  const dispose = mountFeatureSettings(container, options);
  const nodes = descendants(container), swatches = nodes.filter(node => node.getAttribute('role') === 'radio');
  const byTheme = id => nodes.find(node => node.dataset.themeId === id);
  const control = id => nodes.find(node => node.dataset.customControl === id);
  const action = text => nodes.find(node => node.tagName === 'BUTTON' && node.textContent === text);
  return { doc, container, nodes, swatches, byTheme, control, action, requests, settings, subscribers, behavior, notify, options, dispose,
    grid: nodes.find(node => node.getAttribute('role') === 'radiogroup'),
    status: nodes.find(node => node.getAttribute('role') === 'status' && !node.hidden),
    editor: nodes.find(node => node.dataset.customThemeEditor === 'true'),
    selected: () => nodes.filter(node => node.dataset.themeId && (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true')).map(node => node.dataset.themeId),
    maximumActive: () => maximumActive, unsubscribed: () => unsubscribed };
}

test('theme grid has the custom editor and 24 presets, while native appearance is a separate action', () => {
  const chosen = THEMES[5], h = harness({ initial: chosen.id });
  try {
    assert.equal(THEMES.length, 25); assert.equal(h.swatches.length, THEMES.length);
    assert.equal(h.grid.getAttribute('aria-label'), 'Тема LolkaMod');
    assert.deepEqual(h.selected(), [chosen.id]);
    assert.deepEqual(h.swatches.filter(node => node.tabIndex === 0).map(node => node.dataset.themeId), [chosen.id]);
    for (const theme of THEMES.filter(theme => theme.id !== 'native')) {
      const button = h.byTheme(theme.id);
      assert.equal(button.getAttribute('aria-label'), theme.title);
      assert.equal(button.title, `${theme.title} — ${theme.description}`);
      assert.equal(button.dataset.group, theme.group);
      assert.equal(button.children.find(node => node.className === 'theme-check').hidden, theme.id !== chosen.id);
      assert.equal(button.style.background, theme.swatch);
      assert.doesNotMatch(button.style.background, /url\(|https?:|@import/i);
    }
    assert.equal(h.nodes.find(node => node.className === 'theme-choice').children[0].textContent, chosen.title);
    assert.equal(h.nodes.find(node => node.className === 'theme-choice').children[1].textContent, chosen.description);
    assert.ok(h.byTheme('custom').children.some(node => node.tagName === 'SVG' && node.getAttribute('aria-hidden') === 'true'));
    assert.equal(h.byTheme('custom').getAttribute('aria-label'), 'Своя тема');
    assert.equal(h.swatches.includes(h.byTheme('native')), false);
    assert.equal(h.byTheme('native').textContent, 'Оформление Lolka');
    assert.equal(h.editor.hidden, true);
    assert.equal(h.nodes.some(node => node.tagName === 'SELECT'), false);
    assert.doesNotMatch(h.nodes.map(node => node.textContent).join(' '), /Nitro|подписк|Применить|Мини-плеер/i);
    const css = h.nodes.find(node => node.tagName === 'STYLE').textContent;
    assert.match(css, /repeat\(auto-fill,minmax\(48px,1fr\)\)/);
    assert.match(css, /\.feature-settings \.feature-actions button/);
    assert.match(css, /--color-text-on-brand/); assert.match(css, /:focus-visible/);
    h.byTheme(THEMES[1].id).dispatch('mouseenter'); assert.equal(h.requests.length, 0, 'hover is a preview only');
  } finally { h.dispose(); }
});

test('theme click saves only themeId, applies without an Apply action and survives remounting', async () => {
  const h = harness();
  try {
    const chosen = THEMES[4]; h.byTheme(chosen.id).dispatch('click'); await flush();
    assert.deepEqual(h.requests.map(item => item.patch), [{ themeId: chosen.id }]);
    assert.deepEqual(h.selected(), [chosen.id]); assert.equal(h.grid.getAttribute('aria-busy'), 'false');
    assert.equal(h.settings.indicatorEnabled, false); assert.equal(h.settings.customCss, '');
    h.dispose();
    const dispose = mountFeatureSettings(h.container, h.options);
    try {
      const selected = descendants(h.container).filter(node => node.getAttribute('aria-checked') === 'true');
      assert.equal(selected.length, 1); assert.equal(selected[0].dataset.themeId, chosen.id);
      assert.equal(h.subscribers.size, 1);
    } finally { dispose(); }
  } finally { h.dispose(); }
});

test('rapid choices serialize writes and collapse intermediate themes to the latest requested choice', async () => {
  const h = harness({ manual: true }), [first, middle, last] = THEMES.slice(1, 4);
  try {
    h.byTheme(first.id).dispatch('click'); h.byTheme(middle.id).dispatch('click'); h.byTheme(last.id).dispatch('click');
    assert.deepEqual(h.requests.map(item => item.patch), [{ themeId: first.id }]);
    assert.deepEqual(h.selected(), ['native'], 'pending write is not advertised as a persisted theme');
    assert.equal(h.byTheme(last.id).getAttribute('data-pending'), 'true');
    assert.equal(h.grid.getAttribute('aria-busy'), 'true');
    h.requests[0].pending.resolve(); await flush();
    assert.deepEqual(h.requests.map(item => item.patch), [{ themeId: first.id }, { themeId: last.id }]);
    assert.deepEqual(h.selected(), [first.id]);
    h.requests[1].pending.resolve(); await flush();
    assert.deepEqual(h.selected(), [last.id]); assert.equal(h.settings.themeId, last.id);
    assert.equal(h.maximumActive(), 1); assert.equal(h.grid.getAttribute('aria-busy'), 'false');
    assert.equal(h.swatches.some(node => node.getAttribute('data-pending') === 'true'), false);
  } finally { h.dispose(); }
});

test('returning to the originally saved swatch during a pending write is retained as the latest choice', async () => {
  const h = harness({ manual: true }), first = THEMES[1];
  try {
    h.byTheme(first.id).dispatch('click'); h.byTheme('native').dispatch('click');
    h.requests[0].pending.resolve(); await flush();
    assert.deepEqual(h.requests.map(item => item.patch), [{ themeId: first.id }, { themeId: 'native' }]);
    h.requests[1].pending.resolve(); await flush(); assert.deepEqual(h.selected(), ['native']);
    h.byTheme('native').dispatch('click'); await flush(); assert.equal(h.requests.length, 2, 'already saved choice avoids an unnecessary write');
  } finally { h.dispose(); }
});

test('failed saves retain the real saved theme and a later queued choice can still succeed', async () => {
  const h = harness({ manual: true }), [failed, latest] = THEMES.slice(1, 3);
  try {
    h.byTheme(failed.id).dispatch('click'); h.requests[0].pending.reject(new Error('disk failure')); await flush();
    assert.deepEqual(h.selected(), ['native']); assert.equal(h.grid.getAttribute('aria-busy'), 'false');
    assert.match(h.status.textContent, /Не удалось сохранить/);
    h.byTheme(failed.id).dispatch('click'); h.byTheme(latest.id).dispatch('click');
    h.requests[1].pending.reject(new Error('older request failed')); await flush();
    assert.deepEqual(h.requests[2].patch, { themeId: latest.id }); assert.deepEqual(h.selected(), ['native']);
    h.requests[2].pending.resolve(); await flush(); assert.deepEqual(h.selected(), [latest.id]);
    assert.equal(h.status.textContent, 'Тема сохранена');
  } finally { h.dispose(); }
});

test('returning to an already stored choice after an older failure resolves the pending status without a redundant write', async () => {
  const h = harness({ manual: true });
  try {
    h.byTheme('graphite').dispatch('click'); h.byTheme('native').dispatch('click');
    h.requests[0].pending.reject(new Error('older failed')); await flush();
    assert.equal(h.requests.length, 1); assert.deepEqual(h.selected(), ['native']);
    assert.equal(h.grid.getAttribute('aria-busy'), 'false'); assert.equal(h.status.textContent, 'Тема сохранена');
  } finally { h.dispose(); }
});

test('arrow keys, Home and End move focus and selection while Space and Enter retain native activation', async () => {
  const h = harness();
  try {
    let button = h.byTheme('custom'); button.focus();
    assert.equal(button.dispatch('keydown', { key: 'ArrowLeft' }).defaultPrevented, true); await flush();
    assert.strictEqual(h.doc.activeElement, h.byTheme(THEMES.at(-1).id)); assert.deepEqual(h.selected(), [THEMES.at(-1).id]);
    button = h.doc.activeElement; button.dispatch('keydown', { key: 'Home' }); await flush();
    assert.strictEqual(h.doc.activeElement, h.byTheme('custom')); assert.deepEqual(h.selected(), ['custom']);
    h.doc.activeElement.dispatch('keydown', { key: 'ArrowDown' }); await flush();
    assert.strictEqual(h.doc.activeElement, h.byTheme(THEMES[1].id)); assert.deepEqual(h.selected(), [THEMES[1].id]);
    h.doc.activeElement.dispatch('keydown', { key: 'End' }); await flush();
    assert.strictEqual(h.doc.activeElement, h.byTheme(THEMES.at(-1).id));
    h.doc.activeElement.dispatch('keydown', { key: 'ArrowRight' }); await flush();
    assert.deepEqual(h.selected(), ['custom']);
    button = h.byTheme(THEMES[5].id); button.focus();
    const count = h.requests.length;
    for (const key of [' ', 'Enter', 'Tab']) assert.equal(button.dispatch('keydown', { key }).defaultPrevented, false);
    assert.equal(h.requests.length, count, 'keydown does not duplicate native browser click activation');
    button.dispatch('click'); await flush(); assert.deepEqual(h.selected(), [THEMES[5].id]);
    assert.deepEqual(h.swatches.filter(node => node.tabIndex === 0), [button]);
  } finally { h.dispose(); }
});

test('external setting notifications update the selected swatch and preserve indicator controls', async () => {
  const h = harness();
  try {
    h.settings.themeId = THEMES[6].id; h.notify(); assert.deepEqual(h.selected(), [THEMES[6].id]);
    const indicator = h.nodes.find(node => node.dataset.setting === 'indicatorEnabled');
    indicator.checked = true; indicator.dispatch('change'); await flush();
    assert.deepEqual(h.requests.map(item => item.patch), [{ indicatorEnabled: true }]);
    assert.deepEqual(h.selected(), [THEMES[6].id]); assert.equal(h.settings.streamMenuEnabled, true);
    const pending = deferred(); h.behavior.reset = async () => { await pending.promise; h.settings.themeId = 'native'; h.notify(); };
    h.action('Сбросить настройки').dispatch('click'); h.action('Сбросить').dispatch('click');
    assert.ok(h.swatches.every(node => node.disabled)); pending.resolve(); await flush();
    assert.deepEqual(h.selected(), ['native']); assert.ok(h.swatches.every(node => !node.disabled));
    assert.match(h.status.textContent, /Настройки сброшены/);
  } finally { h.dispose(); }
});

test('disposing during a theme request cancels queued choices and leaves detached UI untouched', async () => {
  const h = harness({ manual: true });
  h.byTheme(THEMES[1].id).dispatch('click'); h.byTheme(THEMES[2].id).dispatch('click');
  const snapshot = h.nodes.map(node => ({ text: node.textContent, attributes: [...node.attributes], disabled: node.disabled }));
  h.dispose(); h.dispose(); h.requests[0].pending.resolve(); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.unsubscribed(), 1); assert.equal(h.subscribers.size, 0);
  assert.equal(h.container.children.length, 0); assert.ok(h.nodes.every(node => node.listenerCount() === 0));
  assert.deepEqual(h.nodes.map(node => ({ text: node.textContent, attributes: [...node.attributes], disabled: node.disabled })), snapshot);
  h.byTheme(THEMES[3].id).dispatch('click'); assert.equal(h.requests.length, 1);
});

test('pending update, release and reset failures cannot update disposed settings', async () => {
  const h = harness(), update = deferred(), release = deferred(), reset = deferred();
  h.behavior.updates = () => update.promise; h.behavior.open = () => release.promise; h.behavior.reset = () => reset.promise;
  h.action('Проверить обновления').dispatch('click'); h.action('Открыть релиз').dispatch('click');
  h.action('Сбросить настройки').dispatch('click'); h.action('Сбросить').dispatch('click');
  const text = h.status.textContent, updateDisabled = h.action('Проверить обновления').disabled;
  h.dispose(); update.reject(new Error('offline')); release.reject(new Error('unavailable')); reset.reject(new Error('write failure')); await flush();
  assert.equal(h.status.textContent, text); assert.equal(h.action('Проверить обновления').disabled, updateDisabled);
  assert.equal(h.unsubscribed(), 1); assert.equal(h.container.children.length, 0);
});

test('repeated mount and disposal releases theme listeners and subscriptions without retaining an extra picker', () => {
  const h = harness(); h.dispose();
  for (let iteration = 0; iteration < 50; iteration++) {
    const dispose = mountFeatureSettings(h.container, h.options), nodes = descendants(h.container);
    assert.equal(h.subscribers.size, 1); assert.equal(h.container.children.length, 1);
    dispose(); dispose(); assert.equal(h.subscribers.size, 0); assert.equal(h.container.children.length, 0);
    assert.ok(nodes.every(node => node.listenerCount() === 0));
  }
});

test('palette glyph activates and opens the custom editor; native appearance preserves its saved palette', async () => {
  const h = harness();
  try {
    assert.deepEqual(h.selected(), ['native']); assert.equal(h.byTheme('custom').tabIndex, 0);
    h.byTheme('custom').dispatch('click'); await flush();
    assert.equal(h.editor.hidden, false); assert.deepEqual(h.selected(), ['custom']);
    assert.deepEqual(h.requests[0].patch, { themeId: 'custom', customTheme: structuredClone(DEFAULT_CUSTOM_THEME) });
    const hex = h.control('hex'); hex.focus(); hex.value = '#AABBCC'; hex.dispatch('input'); await flush();
    assert.deepEqual(h.settings.customTheme.colors, ['#aabbcc']);
    h.byTheme('native').dispatch('click'); await flush();
    assert.equal(h.editor.hidden, true); assert.deepEqual(h.selected(), ['native']);
    assert.deepEqual(h.settings.customTheme.colors, ['#aabbcc']);
    assert.deepEqual(h.requests.at(-1).patch, { themeId: 'native' });
    h.byTheme('custom').dispatch('click'); await flush();
    assert.equal(hex.value, '#AABBCC'); assert.deepEqual(h.settings.profile, { resolution: '1440p', fps: 60, codec: 'auto', bitrateMbps: 16 });
    assert.equal(h.settings.streamMenuEnabled, true); assert.equal(h.settings.indicatorDetailed, false);
  } finally { h.dispose(); }
});

test('rapid custom edits and switching to a preset save the latest palette snapshot in a single ordered queue', async () => {
  const h = harness({ manual: true });
  try {
    h.byTheme('custom').dispatch('click');
    const hex = h.control('hex'); hex.focus();
    for (const color of ['#112233', '#445566', '#aabbcc']) { hex.value = color; hex.dispatch('input'); }
    h.byTheme('midnight').dispatch('click');
    assert.equal(h.requests.length, 1); assert.deepEqual(h.requests[0].patch.customTheme, structuredClone(DEFAULT_CUSTOM_THEME));
    assert.equal(h.editor.hidden, true); assert.deepEqual(h.selected(), ['native']);
    h.requests[0].pending.resolve(); await flush();
    assert.equal(h.requests.length, 2); assert.deepEqual(h.requests[1].patch, { themeId: 'midnight', customTheme: { mode: 'dark', colors: ['#aabbcc'], saturation: 80 } });
    h.requests[1].pending.resolve(); await flush();
    assert.deepEqual(h.selected(), ['midnight']); assert.deepEqual(h.settings.customTheme.colors, ['#aabbcc']);
    assert.equal(h.maximumActive(), 1); assert.equal(h.grid.getAttribute('aria-busy'), 'false');
    h.byTheme('custom').dispatch('click'); assert.equal(hex.value, '#AABBCC');
    assert.equal(h.requests[2].patch.customTheme.colors[0], '#aabbcc');
    h.requests[2].pending.resolve(); await flush();
  } finally { h.dispose(); }
});

test('resetting a pending custom palette and returning to native retains the reset as the final saved configuration', async () => {
  const h = harness({ initial: 'custom', manual: true });
  try {
    h.byTheme('custom').dispatch('click'); assert.equal(h.requests.length, 0, 'opening the existing palette avoids an unchanged write');
    const hex = h.control('hex'); hex.focus(); hex.value = '#112233'; hex.dispatch('input');
    hex.value = '#ddeeff'; hex.dispatch('input');
    h.control('reset').dispatch('click'); h.byTheme('native').dispatch('click');
    h.requests[0].pending.resolve(); await flush();
    assert.deepEqual(h.requests[1].patch, { themeId: 'native', customTheme: structuredClone(DEFAULT_CUSTOM_THEME) });
    h.requests[1].pending.resolve(); await flush(); assert.deepEqual(h.selected(), ['native']);
    assert.deepEqual(h.settings.customTheme, structuredClone(DEFAULT_CUSTOM_THEME));
    assert.equal(h.settings.enabled, true); assert.equal(h.settings.profile.fps, 60); assert.equal(h.settings.streamMenuEnabled, true);
  } finally { h.dispose(); }
});

test('invalid HEX drafts survive shadow-root refreshes and never produce a settings write', async () => {
  const h = harness({ initial: 'custom' });
  try {
    h.byTheme('custom').dispatch('click'); const hex = h.control('hex');
    const shadowHost = h.doc.createElement('section'), shadowRoot = { activeElement: hex };
    hex.getRootNode = () => shadowRoot; h.doc.activeElement = shadowHost;
    hex.value = '#12'; hex.dispatch('input'); h.notify(); h.notify();
    assert.equal(hex.value, '#12'); assert.equal(hex.getAttribute('aria-invalid'), 'true'); assert.equal(h.requests.length, 0);
    h.settings.indicatorEnabled = true; h.notify(); assert.equal(hex.value, '#12');
    hex.value = '#123456'; hex.dispatch('input'); await flush(); assert.deepEqual(h.settings.customTheme.colors, ['#123456']);
    assert.equal(hex.getAttribute('aria-invalid'), 'false'); assert.equal(hex.value, '#123456');
    hex.value = '#123'; hex.dispatch('input'); hex.dispatch('blur'); assert.equal(hex.value, '#123456');
    assert.equal(h.settings.indicatorEnabled, true);
    const focused = h.byTheme('graphite'); focused.getRootNode = () => ({ activeElement: focused }); focused.dispatch('focus');
    h.notify(); assert.equal(focused.tabIndex, 0, 'radio focus is resolved inside the shadow root');
  } finally { h.dispose(); }
});

test('failed custom saves expose the actual stored theme and resync the editor without losing queued recovery', async () => {
  const h = harness({ initial: 'custom', manual: true });
  try {
    h.byTheme('custom').dispatch('click'); const hex = h.control('hex'); hex.focus(); hex.value = '#abcdef'; hex.dispatch('input');
    h.requests[0].pending.reject(new Error('write failed')); await flush();
    assert.deepEqual(h.settings.customTheme, structuredClone(DEFAULT_CUSTOM_THEME)); assert.match(h.status.textContent, /Не удалось сохранить/);
    hex.dispatch('blur'); assert.equal(hex.value, '#322B54'); assert.deepEqual(h.selected(), ['custom']);
    hex.value = '#112233'; hex.dispatch('input'); hex.value = '#445566'; hex.dispatch('input');
    h.requests[1].pending.reject(new Error('older failed')); await flush();
    assert.deepEqual(h.requests[2].patch.customTheme.colors, ['#445566']);
    h.requests[2].pending.resolve(); await flush(); assert.deepEqual(h.settings.customTheme.colors, ['#445566']);
    assert.equal(h.status.textContent, 'Тема сохранена');
  } finally { h.dispose(); }
});

test('disposing a custom edit drops queued configurations and releases the editor subscription and listeners', async () => {
  const h = harness({ initial: 'custom', manual: true });
  h.byTheme('custom').dispatch('click'); const hex = h.control('hex'); hex.value = '#112233'; hex.dispatch('input'); hex.value = '#445566'; hex.dispatch('input');
  h.dispose(); const text = hex.value; h.requests[0].pending.resolve(); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.container.children.length, 0); assert.equal(h.unsubscribed(), 1);
  assert.ok(h.nodes.every(node => node.listenerCount() === 0)); assert.equal(hex.value, text);
  hex.value = '#abcdef'; hex.dispatch('input'); assert.equal(h.requests.length, 1);
});
