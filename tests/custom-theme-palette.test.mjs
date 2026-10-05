import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function source(relative) {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/' + relative + '.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const [themes, settings, renderer, stores] = await Promise.all([
  source('shared/themes'), source('shared/settings'), source('renderer/theme-manager'), source('main/settings-store'),
]);
const { DEFAULT_CUSTOM_THEME, normalizeCustomTheme, createCustomThemePalette } = themes;
const defaults = () => settings.validateSettings(settings.DEFAULT_SETTINGS);
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722;
}
function contrast(a, b) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + .05) / (lo + .05);
}
test('custom colors are canonical data, independent copies, and reject unsafe or malformed input', () => {
  const input = { mode: 'light', colors: ['#ABCDEF', '#00Ff00'], saturation: 60 };
  const a = normalizeCustomTheme(input), b = normalizeCustomTheme(input);
  assert.deepEqual(a, { mode: 'light', colors: ['#abcdef', '#00ff00'], saturation: 60 });
  input.colors[0] = '#000000'; a.colors[1] = '#ffffff';
  assert.deepEqual(b.colors, ['#abcdef', '#00ff00']);
  const bad = [null, [], {}, { ...DEFAULT_CUSTOM_THEME, mode: 'system' },
    ...[[], Array(1), Array(4), ['#fff'], ['red'], ['#123456; color:red'], ['url(https://example.com)']]
      .map(colors => ({ ...DEFAULT_CUSTOM_THEME, colors })),
    { ...DEFAULT_CUSTOM_THEME, colors: Array(5).fill('#123456') },
    ...[NaN, Infinity, -1, 101, '80'].map(saturation => ({ ...DEFAULT_CUSTOM_THEME, saturation })),
    { ...DEFAULT_CUSTOM_THEME, code: 'anything' }];
  for (const value of bad) assert.throws(() => normalizeCustomTheme(value), /Invalid custom theme/);
  assert.ok(Object.isFrozen(DEFAULT_CUSTOM_THEME)); assert.ok(Object.isFrozen(DEFAULT_CUSTOM_THEME.colors));
});
test('arbitrary color extrema keep surfaces, links, buttons and interpolated gradients readable in both modes', () => {
  const seeds = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#322b54', '#777777'];
  for (let i = 0; i < 48; i++) seeds.push('#' + ((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0'));
  for (const mode of ['dark', 'light']) for (const saturation of [0, 80, 100]) for (const seed of seeds) {
    const custom = { mode, colors: [seed, '#0000ff', '#ffff00', '#ff0000'], saturation };
    const p = createCustomThemePalette(custom);
    const backgrounds = [p.primary, p.secondary, p.tertiary, p.elevated, p.hover, ...p.gradientStops];
    for (let i = 1; i < p.gradientStops.length; i++) for (let n = 1; n < 10; n++) {
      const a = p.gradientStops[i - 1], b = p.gradientStops[i];
      backgrounds.push('#' + [1, 3, 5].map(at => Math.round(parseInt(a.slice(at, at + 2), 16) * (1 - n / 10) +
        parseInt(b.slice(at, at + 2), 16) * n / 10).toString(16).padStart(2, '0')).join(''));
    }
    for (const ink of [p.text, p.normal, p.muted, p.danger, p.success, p.warning, p.brand]) for (const background of backgrounds)
      assert.ok(contrast(ink, background) >= 4.5, `${mode}/${saturation}/${seed}: ${ink} on ${background}`);
    for (const background of [p.brand, p.brandHover]) assert.ok(contrast(p.brandText, background) >= 4.5);
    assert.ok(Object.isFrozen(p));
    const css = renderer.themeCss('custom', custom);
    assert.match(css, new RegExp(`color-scheme:${mode}`));
    assert.doesNotMatch(css, /@import|url\(|::before|::after|video\s*[{,]/i);
  }
  assert.equal(createCustomThemePalette(DEFAULT_CUSTOM_THEME).gradient, undefined);
  assert.notEqual(renderer.themeCss('custom', DEFAULT_CUSTOM_THEME), renderer.themeCss('custom', { ...DEFAULT_CUSTOM_THEME, colors: ['#992244'] }));
  assert.throws(() => renderer.themeCss('custom', { ...DEFAULT_CUSTOM_THEME, colors: ['bad'] }));
});
test('old schema-one preferences migrate without changing selected theme and custom colors survive store restart and native reset', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-custom-palette-'));
  try {
    const expected = { ...defaults(), themeId: 'neon', customCss: '/* retain */', indicatorEnabled: true,
      qualityEnabled: true, profile: { resolution: '1440p', fps: 60, codec: 'AV1', bitrateMbps: 16 } };
    const { customTheme, ...old } = expected;
    const file = path.join(directory, 'settings.json'), original = JSON.stringify(old);
    await fs.writeFile(file, original);
    const store = stores.createSettingsStore(directory);
    assert.deepEqual(store.read(), expected); assert.equal(await fs.readFile(file, 'utf8'), original);
    const own = { mode: 'light', colors: ['#123456', '#ffaabb'], saturation: 35 };
    store.write({ ...expected, themeId: 'custom', customTheme: own });
    const reopen = stores.createSettingsStore(directory);
    assert.deepEqual(reopen.read(), { ...expected, themeId: 'custom', customTheme: own });
    const native = { ...reopen.read(), themeId: 'native' }; reopen.write(native);
    assert.deepEqual(stores.createSettingsStore(directory).read(), native);
    const before = await fs.readFile(file);
    assert.throws(() => reopen.write({ ...native, customTheme: { ...own, colors: ['#invalid'] } }));
    assert.deepEqual(await fs.readFile(file), before);
    const first = defaults(); first.customTheme.colors[0] = '#000000';
    assert.deepEqual(defaults().customTheme, DEFAULT_CUSTOM_THEME);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('lolkamod-custom-palette-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
