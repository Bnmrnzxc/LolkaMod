import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sourceModule(relative) {
  const result = await build({ entryPoints: [path.join(root, 'src', relative + '.ts')], bundle: true,
    format: 'esm', platform: 'node', target: 'es2022', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const [catalog, settings, storeModule, renderer] = await Promise.all([
  sourceModule('shared/themes'), sourceModule('shared/settings'),
  sourceModule('main/settings-store'), sourceModule('renderer/theme-manager'),
]);
const { BUILT_IN_THEMES: themes, THEME_IDS: ids, isThemeId } = catalog;
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722;
}
function contrast(a, b) {
  const l = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (l[1] + .05) / (l[0] + .05);
}

test('catalog offers 24 distinct local presets and a native reset, shared by validation and UI', () => {
  assert.equal(themes.length, 25); assert.equal(new Set(ids).size, 26);
  assert.deepEqual(themes.map(t => t.id), [...ids].filter(id => id !== 'custom')); assert.equal(themes[0].id, 'native');
  assert.equal(isThemeId('custom'), true, 'custom palettes have their own persistence identifier');
  assert.equal(themes.filter(t => t.group === 'light').length, 7);
  assert.equal(themes.filter(t => t.group === 'gradient').length, 7);
  assert.equal(new Set(themes.map(t => t.title)).size, 25);
  assert.equal(new Set(themes.filter(t => t.palette).map(t => t.swatch)).size, 24);
  for (const theme of themes) {
    assert.equal(isThemeId(theme.id), true); assert.ok(theme.description);
    assert.ok(Object.isFrozen(theme)); assert.ok(Object.isFrozen(themes));
    assert.doesNotMatch(theme.swatch, /url\(|https?:|javascript:|@import/i);
    if (theme.palette) assert.ok(Object.isFrozen(theme.palette));
  }
  for (const invalid of ['unknown', 'constructor', '__proto__', null, undefined, 0, {}, 'https://example.com/style.css']) {
    assert.equal(isThemeId(invalid), false);
    if (invalid !== undefined) assert.throws(() => settings.validateSettings({ ...settings.DEFAULT_SETTINGS, themeId: invalid }), /Invalid theme/);
  }
  assert.equal(settings.validateSettings({ ...settings.DEFAULT_SETTINGS, themeId: undefined }).themeId, 'native');
});

test('normal and secondary text remain readable on every surface and throughout each gradient', () => {
  for (const theme of themes.filter(t => t.palette)) {
    const p = theme.palette;
    const backgrounds = [p.primary, p.secondary, p.tertiary, p.elevated, p.hover, ...(p.gradientStops ?? [])];
    for (let i = 1; i < (p.gradientStops?.length ?? 0); i++) {
      const a = p.gradientStops[i - 1], b = p.gradientStops[i];
      for (let step = 1; step < 10; step++) {
        backgrounds.push('#' + [1, 3, 5].map(at => {
          const start = parseInt(a.slice(at, at + 2), 16), end = parseInt(b.slice(at, at + 2), 16);
          return Math.round(start + (end - start) * step / 10).toString(16).padStart(2, '0');
        }).join(''));
      }
    }
    for (const foreground of [p.text, p.normal, p.muted, p.danger]) for (const background of backgrounds) {
      assert.ok(contrast(foreground, background) >= 4.5,
        `${theme.id}: ${foreground} on ${background} has contrast ${contrast(foreground, background).toFixed(2)}`);
    }
    for (const accent of [p.brand, p.brandHover]) {
      assert.ok(contrast(p.brandText, accent) >= 4.5, `${theme.id}: primary button text must stay readable`);
    }
  }
});

test('light palettes apply the actual scheme, and gradients affect layout surfaces without covering media', () => {
  assert.equal(renderer.themeCss('native'), '');
  for (const theme of themes.filter(t => t.palette)) {
    const css = renderer.themeCss(theme.id);
    assert.match(css, new RegExp(`color-scheme:${theme.palette.mode};`));
    assert.match(css, /\.ash-theme,\.aubergine-theme,\.slack-theme/);
    assert.doesNotMatch(css, /::before|::after|position:\s*(?:fixed|absolute)|url\(|@import|video\s*[{,]/i);
    const rgb = css.match(/--color-server-header-bg-rgb:([^;]+);/)[1];
    assert.match(rgb, /^\d+, \d+, \d+$/);
    assert.doesNotMatch(css, /--color-bg-[\w-]+:linear-gradient/);
    assert.equal(css.includes('background-image:linear-gradient'), theme.group === 'gradient');
    if (theme.group === 'gradient') assert.match(css, /\[class\*="Channel-module__chatArea__/);
  }
});

test('all theme choices survive a new settings store without resetting stream or custom CSS preferences', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-theme-persistence-'));
  try {
    const expected = { ...settings.DEFAULT_SETTINGS, enabled: true, customCss: '/* keep custom styles */',
      indicatorEnabled: true, indicatorDetailed: true, streamMenuEnabled: false, qualityEnabled: true,
      profile: { resolution: '1440p', fps: 60, codec: 'AV1', bitrateMbps: 16 } };
    const store = storeModule.createSettingsStore(directory);
    for (const theme of themes) {
      const next = { ...expected, themeId: theme.id };
      store.write(next);
      assert.deepEqual(storeModule.createSettingsStore(directory).read(), next);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')), next);
    }
    assert.equal((await fs.readdir(directory)).length, 1, 'valid current settings need no migration backups');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('lolkamod-theme-persistence-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
