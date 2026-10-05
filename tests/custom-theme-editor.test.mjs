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
const [{ mountCustomThemeEditor, hexToHsv, hsvToHex }, { DEFAULT_CUSTOM_THEME }] = await Promise.all([
  load('../src/renderer/custom-theme-editor.ts'), load('../src/shared/themes.ts'),
]);

class Element {
  children = []; parent = null; listeners = new Map(); attributes = new Map(); dataset = {}; style = {};
  className = ''; textContent = ''; hidden = false; disabled = false; value = ''; tabIndex = 0;
  captured = new Set(); captureReleased = [];
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getRootNode() { return this.ownerDocument; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 100 }; }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); this.captureReleased.push(id); }
  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
    if (options.signal) { setMaxListeners(0, options.signal); options.signal.addEventListener('abort', () => listeners.delete(listener), { once: true }); }
  }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...extra };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}
class Document {
  activeElement = null;
  createElement(tag) { return new Element(tag, this); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
function harness(value = DEFAULT_CUSTOM_THEME) {
  const doc = new Document(), container = doc.createElement('div'), changes = [];
  let closed = 0;
  const editor = mountCustomThemeEditor(container, { value, change(next) { changes.push(structuredClone(next)); }, close() { closed++; } });
  const nodes = descendants(container), root = nodes.find(node => node.dataset.customThemeEditor === 'true');
  const control = name => nodes.find(node => node.dataset.customControl === name);
  const color = index => nodes.find(node => node.dataset.customColor === String(index));
  const remove = index => nodes.find(node => node.dataset.removeColor === String(index));
  const mode = name => nodes.find(node => node.dataset.themeMode === name);
  return { doc, container, editor, root, nodes, control, color, remove, mode, changes, closed: () => closed,
    last: () => changes.at(-1), hex(value) { const input = control('hex'); input.focus(); input.value = value; input.dispatch('input'); } };
}

test('HSV editing round-trips RGB colors and clamps saturation and brightness at the square edges', () => {
  for (const hex of ['#000000', '#ffffff', '#322b54', '#123456', '#ff0000', '#00ff00', '#0000ff', '#aabbcc', '#808080']) {
    const { h, s, v } = hexToHsv(hex); assert.equal(hsvToHex(h, s, v), hex);
  }
  assert.equal(hsvToHex(360, 100, 100), '#ff0000'); assert.equal(hsvToHex(-120, 100, 100), '#0000ff');
  assert.equal(hsvToHex(0, -10, 200), '#ffffff'); assert.equal(hsvToHex(0, 200, -50), '#000000');
});

test('editor stays in the current panel and provides dark/light, four color slots and immediate bounded controls', () => {
  const h = harness();
  try {
    assert.equal(h.root.hidden, true); h.editor.open(DEFAULT_CUSTOM_THEME); assert.equal(h.root.hidden, false);
    assert.equal(h.root.getAttribute('aria-label'), 'Настройка своей темы');
    assert.equal(h.mode('dark').getAttribute('aria-pressed'), 'true'); assert.equal(h.mode('light').getAttribute('aria-pressed'), 'false');
    assert.equal(h.control('hex').value, '#322B54'); assert.equal(h.control('saturation').value, '80');
    assert.equal(h.control('saturation-value').textContent, '80%'); assert.equal(h.changes.length, 0);
    h.mode('light').dispatch('click'); assert.equal(h.last().mode, 'light');
    const saturation = h.control('saturation'); saturation.value = '35'; saturation.dispatch('input'); assert.equal(h.last().saturation, 35);
    assert.equal(h.control('saturation-value').textContent, '35%');
    for (let index = 0; index < 3; index++) h.control('add').dispatch('click');
    assert.equal(h.last().colors.length, 4); assert.equal(h.control('add').disabled, true);
    const count = h.changes.length; h.control('add').dispatch('click'); assert.equal(h.changes.length, count);
    assert.equal(h.color(3).getAttribute('aria-pressed'), 'true'); h.color(0).dispatch('click');
    assert.equal(h.color(0).getAttribute('aria-pressed'), 'true'); assert.equal(h.changes.length, count, 'selecting a color does not write settings');
    h.remove(1).dispatch('click'); assert.equal(h.last().colors.length, 3); assert.equal(h.control('add').disabled, false);
    while (h.last().colors.length > 1) h.remove(0).dispatch('click');
    assert.equal(h.remove(0).disabled, true); assert.equal(h.color(3).disabled, true); assert.equal(h.remove(3).disabled, true);
    const finalCount = h.changes.length; h.color(3).dispatch('click'); h.remove(3).dispatch('click'); assert.equal(h.changes.length, finalCount);
    const css = h.nodes.find(node => node.tagName === 'STYLE').textContent;
    assert.match(css, /max-width:360px;width:100%/); assert.doesNotMatch(css, /url\(|https?:|@import|position:fixed/);
    assert.doesNotMatch(h.nodes.map(node => node.textContent).join(' '), /Применить|подписк|Nitro|Мини-плеер/i);
  } finally { h.editor.dispose(); }
});

test('HEX validation rejects partial or CSS values, keeps active shadow drafts and emits normalized snapshots', () => {
  const h = harness();
  try {
    h.editor.open(DEFAULT_CUSTOM_THEME); const hex = h.control('hex');
    const shadow = { activeElement: hex }; hex.getRootNode = () => shadow; h.doc.activeElement = h.container;
    for (const invalid of ['', '#12', 'red', '#aabbcc;url(x)', '#abcdff00']) {
      hex.value = invalid; hex.dispatch('input'); h.editor.disabled(false); h.editor.update(DEFAULT_CUSTOM_THEME);
      assert.equal(hex.value, invalid); assert.equal(hex.getAttribute('aria-invalid'), 'true'); assert.equal(h.changes.length, 0);
    }
    hex.value = '#ABCDEF'; hex.dispatch('input'); assert.deepEqual(h.last().colors, ['#abcdef']);
    assert.equal(hex.value, '#ABCDEF'); assert.equal(hex.getAttribute('aria-invalid'), 'false');
    const emitted = h.last(); emitted.colors[0] = '#000000';
    h.mode('light').dispatch('click'); assert.deepEqual(h.last().colors, ['#abcdef'], 'a caller cannot mutate the editor state through a returned snapshot');
    hex.value = '#123'; hex.dispatch('input'); h.editor.update({ mode: 'dark', colors: ['#112233'], saturation: 80 });
    assert.equal(hex.value, '#123'); hex.dispatch('blur'); assert.equal(hex.value, '#112233');
  } finally { h.editor.dispose(); }
});

test('SV pointer dragging, cancellation and arrow keys update the same selected color without document listeners', () => {
  const h = harness();
  try {
    h.editor.open(DEFAULT_CUSTOM_THEME); h.hex('#ff0000');
    const square = h.control('sv'); square.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 110, clientY: 70 });
    assert.deepEqual(h.last().colors, ['#804040']); assert.equal(square.hasPointerCapture(7), true);
    square.dispatch('pointermove', { pointerId: 8, clientX: 210, clientY: 20 }); assert.deepEqual(h.last().colors, ['#804040']);
    square.dispatch('pointermove', { pointerId: 7, clientX: 210, clientY: 20 }); assert.deepEqual(h.last().colors, ['#ff0000']);
    square.dispatch('pointercancel', { pointerId: 7 }); assert.equal(square.hasPointerCapture(7), false);
    const count = h.changes.length; square.dispatch('pointermove', { pointerId: 7, clientX: 10, clientY: 120 }); assert.equal(h.changes.length, count);
    const event = square.dispatch('keydown', { key: 'ArrowDown', shiftKey: true }); assert.equal(event.defaultPrevented, true); assert.deepEqual(h.last().colors, ['#e60000']);
    square.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true }); assert.deepEqual(h.last().colors, ['#e61717']);
    assert.equal(square.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
    square.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: -500, clientY: 900 }); assert.deepEqual(h.last().colors, ['#000000']);
    const hue = h.control('hue'); hue.value = '240'; hue.dispatch('input'); square.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
    assert.deepEqual(h.last().colors, ['#1a1a1a'], 'zero saturation remains grey despite a changed hue');
    square.dispatch('keydown', { key: 'ArrowRight', shiftKey: true }); assert.deepEqual(h.last().colors, ['#17171a']);
    h.editor.hide(); assert.equal(square.hasPointerCapture(9), false); assert.equal(h.root.hidden, true);
    square.dispatch('pointerdown', { button: 0, pointerId: 11, clientX: 110, clientY: 70 });
    square.dispatch('lostpointercapture', { pointerId: 11 });
    const lostCount = h.changes.length; square.dispatch('pointermove', { pointerId: 11, clientX: 210, clientY: 20 });
    assert.equal(h.changes.length, lostCount, 'lost capture prevents hover movement from continuing a finished drag');
    square.setPointerCapture = () => { throw new Error('no active pointer'); }; square.releasePointerCapture = () => { throw new Error('capture ended'); };
    assert.doesNotThrow(() => square.dispatch('pointerdown', { button: 0, pointerId: 10, clientX: 110, clientY: 70 }));
    assert.doesNotThrow(() => square.dispatch('pointerup', { pointerId: 10 }));
  } finally { h.editor.dispose(); }
});

test('reset restores the whole custom default, random generates valid colors, and closing never reverts applied changes', () => {
  const h = harness({ mode: 'light', colors: ['#123456', '#abcdef'], saturation: 15 });
  try {
    h.editor.open({ mode: 'light', colors: ['#123456', '#abcdef'], saturation: 15 }); h.color(1).dispatch('click'); h.control('reset').dispatch('click');
    assert.deepEqual(h.last(), structuredClone(DEFAULT_CUSTOM_THEME)); assert.equal(h.control('hex').value, '#322B54');
    assert.equal(h.mode('dark').getAttribute('aria-pressed'), 'true'); assert.equal(h.control('saturation-value').textContent, '80%');
    h.control('random').dispatch('click'); assert.equal(h.last().colors.length, 3); assert.ok(h.last().colors.every(color => /^#[0-9a-f]{6}$/.test(color)));
    const count = h.changes.length, previous = structuredClone(h.last());
    const event = h.root.dispatch('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true); assert.equal(h.closed(), 1); assert.equal(h.root.hidden, true);
    assert.equal(h.changes.length, count); assert.deepEqual(h.last(), previous);
  } finally { h.editor.dispose(); }
});

test('disable and disposal release pointer capture and every listener, and stopped imperative updates do nothing', () => {
  const h = harness(); h.editor.open(DEFAULT_CUSTOM_THEME);
  const square = h.control('sv'); square.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 70 });
  h.editor.disabled(true); assert.equal(square.hasPointerCapture(1), false); assert.equal(square.tabIndex, -1);
  const count = h.changes.length; h.control('saturation').value = '1'; h.control('saturation').dispatch('input'); h.mode('light').dispatch('click'); assert.equal(h.changes.length, count);
  h.editor.disabled(false); square.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 110, clientY: 70 });
  h.editor.dispose(); h.editor.dispose(); assert.equal(square.hasPointerCapture(2), false); assert.equal(h.container.children.length, 0);
  assert.ok(h.nodes.every(node => node.listenerCount() === 0));
  const snapshot = h.nodes.map(node => ({ value: node.value, text: node.textContent, attributes: [...node.attributes], disabled: node.disabled }));
  h.editor.open(DEFAULT_CUSTOM_THEME); h.editor.hide(); h.editor.update(DEFAULT_CUSTOM_THEME); h.editor.disabled(true);
  h.control('hex').dispatch('input'); assert.deepEqual(h.nodes.map(node => ({ value: node.value, text: node.textContent, attributes: [...node.attributes], disabled: node.disabled })), snapshot);
});
