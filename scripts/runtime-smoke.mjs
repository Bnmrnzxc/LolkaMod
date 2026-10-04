import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CDP } from './cdp.mjs';
const cdp = await CDP.connect();
try {
  for (let i=0; i<80; i++) {
    if (await cdp.evaluate("window.LolkaMod?.ready === true && document.readyState === 'complete'")) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const initial = await cdp.evaluate(`(async () => ({ ready: document.readyState,
    appVersion: await window.electronAPI.getAppVersion(), mod: window.LolkaMod?.diagnostics(),
    bootAt: window.LolkaMod?.bootAt, panel: !!document.getElementById('lolkamod-panel'),
    rootChildren: document.getElementById('root')?.childElementCount,
    electronApi: Object.keys(window.electronAPI || {}).sort(), nodeRequire: typeof window.require,
    settingsReference: window.LolkaMod?.modules.get('ScreenShareSettings')?.snapshot(),
    entryResponseEnd: performance.getEntriesByType('resource').find(r => /index-.*js/.test(r.name))?.responseEnd }))()`);
  assert.equal(initial.mod?.ready, true);
  assert.equal(initial.mod.desktop.sandboxed, true);
  assert.equal(initial.mod.desktop.contextIsolated, true);
  assert.equal(initial.nodeRequire, 'undefined');
  assert.equal(initial.panel, true);
  const baseline = JSON.parse(await fs.readFile('.runtime/evidence/baseline.json', 'utf8'));
  assert.deepEqual(initial.electronApi, baseline.electronApi);
  assert.ok(initial.rootChildren > 0);
  assert.equal(typeof initial.settingsReference?.bitrateMbps, 'number', 'Real ESM settings reference must be registered');
  // Chromium's preload scanner may start a fetch before the preload executes.
  // An ESM script cannot execute until its response has finished downloading.
  assert.ok(initial.bootAt < initial.entryResponseEnd, 'Core must run before entry response completes');
  const tests = await cdp.evaluate(`(async () => {
    const api = window.LolkaMod;
    const css = 'html { --lolkamod-smoke-test: 1440; }';
    const profile = { resolution: '1440p', fps: 30, codec: 'auto', bitrateMbps: 16 };
    await api.saveSettings({ enabled: false, customCss: '', qualityEnabled: false, profile });
    await Promise.all([api.saveSettings({ enabled: true }), api.saveSettings({ customCss: css })]);
    const queuedPatches = api.settings().enabled && api.settings().customCss === css &&
      api.settings().qualityEnabled === false && api.settings().profile.resolution === profile.resolution;
    await api.saveSettings({ enabled: true, customCss: css, qualityEnabled: false, profile });
    const cssApplied = getComputedStyle(document.documentElement).getPropertyValue('--lolkamod-smoke-test').trim() === '1440';
    const before = document.querySelectorAll('#lolkamod-panel').length;
    for (let i=0; i<100; i++) { api.stop(); api.start(); api.start(); }
    const singlePanel = before === 1 && document.querySelectorAll('#lolkamod-panel').length === 1 && document.querySelectorAll('#lolkamod-custom-css').length === 1;
    const shadow = document.getElementById('lolkamod-panel').shadowRoot;
    const closedInitially = shadow.querySelector('section').hidden;
    const launcherHidden = shadow.querySelector('.launcher').hidden && getComputedStyle(shadow.querySelector('.launcher')).display === 'none';
    const noSeparateQualityControls = !shadow.querySelector('.stream-controls');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey:true, shiftKey:true }));
    const opened = !shadow.querySelector('section').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const escapeCloses = shadow.querySelector('section').hidden;
    api.stop();
    const cleaned = !document.getElementById('lolkamod-panel') && !document.getElementById('lolkamod-custom-css');
    api.start();
    let rejected = false;
    try { await window.LolkaModNative.writeSettings({ enabled: true, customCss: '', qualityEnabled: false,
      profile, unexpected: 'no' }); } catch { rejected = true; }
    return { queuedPatches, cssApplied, singlePanel, closedInitially, launcherHidden, noSeparateQualityControls, opened, escapeCloses, cleaned, rejected };
  })()`);
  for (const [name, result] of Object.entries(tests)) assert.equal(result, true, name);
  await cdp.send('Page.reload', { ignoreCache: true });
  let reload;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      reload = await cdp.evaluate(`({ ready: window.LolkaMod?.ready, settings: window.LolkaMod?.settings(),
        applied: getComputedStyle(document.documentElement).getPropertyValue('--lolkamod-smoke-test').trim() === '1440',
        reference: !!window.LolkaMod?.modules.get('ScreenShareSettings'),
        panelCount: document.querySelectorAll('#lolkamod-panel').length })`);
      if (reload.ready) break;
    } catch { /* New main-world execution context is being created. */ }
  }
  assert.equal(reload.ready, true);
  assert.equal(reload.settings.enabled, true);
  assert.equal(reload.settings.qualityEnabled, false);
  assert.deepEqual(reload.settings.profile, { resolution: '1440p', fps: 30, codec: 'auto', bitrateMbps: 16 });
  assert.equal(reload.applied, true);
  assert.equal(reload.panelCount, 1);
  assert.equal(reload.reference, true);
  const result = { status: 'PASS', initial, tests, reload,
    notRun: ['authenticated login/navigation', 'screen-share/audio', 'sender/receiver 1440p'],
    testedAt: new Date().toISOString() };
  await fs.writeFile('.runtime/evidence/smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { cdp.close(); }
