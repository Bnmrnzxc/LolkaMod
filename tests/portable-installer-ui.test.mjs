import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getUpdateOffer } from '../DesktopInstaller/renderer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('portable installer separates local bundle update from stable release update', () => {
  const local = getUpdateOffer({
    version: '0.6.0',
    status: { installed: true, modVersion: '0.5.5' },
  });
  assert.deepEqual(local, {
    installerVersion: '0.6.0',
    installedVersion: '0.5.5',
    localAvailable: true,
    remoteAvailable: false,
    remoteVersion: null,
    targetVersion: '0.6.0',
    primaryOperation: 'install',
  });

  const remote = getUpdateOffer({
    version: '0.5.5',
    status: { installed: true, modVersion: '0.5.5' },
    release: { version: '0.6.0', url: 'https://github.com/example/release' },
  });
  assert.equal(remote?.primaryOperation, 'release');
  assert.equal(remote?.targetVersion, '0.6.0');
  assert.equal(getUpdateOffer({ version: '0.6.0', status: { installed: true, modVersion: '0.6.0' } }), null);
  assert.equal(getUpdateOffer({ version: 'invalid', status: { modVersion: '0.5.0' } }), null);
});

test('portable installer shell keeps local-only renderer and safe semantic controls', async () => {
  const html = await readFile(path.join(root, 'DesktopInstaller', 'renderer.html'), 'utf8');
  const js = await readFile(path.join(root, 'DesktopInstaller', 'renderer.js'), 'utf8');
  const preload = await readFile(path.join(root, 'DesktopInstaller', 'preload.cjs'), 'utf8');

  assert.match(html, /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.match(html, /src="\.\/logo\.png"/);
  assert.match(html, /<dialog\b[^>]*aria-labelledby=/);
  assert.match(html, /<details\b/);
  assert.match(html, /id="install-button"/);
  assert.match(html, /id="uninstall-button"/);
  assert.match(html, /id="repair-button"/);
  assert.doesNotMatch(html, /<audio\b|<video\b|microphone|микрофон/i);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.match(js, /api\.action\(\{ operation, installation \}\)/);
  assert.match(js, /api\.openRelease\(\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('installer'/);
  assert.doesNotMatch(preload, /nodeIntegration|remote\.require/);
});

test('renderer lifecycle renders initial state, preserves picker cancellation and routes actions', async () => {
  const html = await readFile(path.join(root, 'DesktopInstaller', 'renderer.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  class Element {
    constructor() {
      this.listeners = new Map();
      this.dataset = {};
      this.textContent = '';
      this.value = '';
      this.disabled = false;
      this.hidden = false;
      this.open = false;
    }
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    }
    async emit(name, event = {}) {
      const callbacks = this.listeners.get(name) || [];
      const results = callbacks.map(callback => callback({ preventDefault() {}, ...event }));
      await Promise.all(results);
    }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close(returnValue = '') {
      this.open = false;
      this.returnValue = returnValue;
      void this.emit('close');
    }
  }

  const elements = new Map(ids.map(id => [id, new Element()]));
  let state = {
    version: '0.5.5', platform: 'linux', installation: '/opt/Lolka',
    status: { found: true, hostVersion: '1.0.113', modVersion: '0.5.5', installed: true },
    release: { version: '0.6.0', url: 'https://github.com/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0' },
  };
  let actionRequest;
  let releaseCalls = 0;
  let progressListener;
  let resolveAction;
  const actionPending = new Promise(resolve => { resolveAction = resolve; });
  const installer = {
    getState: async () => state,
    chooseFolder: async () => state,
    inspect: async installation => ({ ...state, installation }),
    action: request => { actionRequest = request; return actionPending; },
    openRelease: async () => { releaseCalls += 1; },
    onProgress: callback => { progressListener = callback; return () => { progressListener = null; }; },
  };
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = { installer };
  globalThis.document = { querySelector: selector => elements.get(selector.slice(1)) };

  try {
    await import(`../DesktopInstaller/renderer.js?lifecycle=${Date.now()}`);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(elements.get('installation-path').value, '/opt/Lolka');
    assert.equal(elements.get('install-button').disabled, false);
    assert.equal(elements.get('repair-button').disabled, false);
    assert.equal(elements.get('update-dialog').open, true);
    assert.equal(elements.get('update-installed-label').textContent, 'Текущий установщик');
    assert.equal(elements.get('update-installed').textContent, '0.5.5');
    assert.equal(elements.get('update-target').textContent, '0.6.0');

    await elements.get('skip-update-button').emit('click');
    state = { ...state, installation: '/opt/Lolka', status: { found: true, installed: true, message: 'Файлы восстановления найдены.' } };
    await elements.get('browse-button').emit('click');
    assert.equal(elements.get('installation-path').value, '/opt/Lolka', 'canceling the native picker leaves the selected path intact');
    assert.equal(elements.get('mod-version-value').textContent, 'Неизвестна');
    assert.equal(elements.get('mod-version-detail').textContent, 'Можно восстановить клиент');
    assert.equal(elements.get('repair-button').disabled, false, 'recoverable state remains repairable with no readable mod version');

    const pendingClick = elements.get('install-button').emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(actionRequest, { operation: 'install', installation: '/opt/Lolka' });
    assert.equal(elements.get('install-button').disabled, true);
    progressListener({ message: 'Проверка и изменение файлов…' });
    assert.equal(elements.get('status-message').textContent, 'Проверка и изменение файлов…');
    resolveAction({ ...state, status: { found: true, installed: true, modVersion: '0.5.5', message: 'LolkaMod установлен.' } });
    await pendingClick;
    assert.equal(elements.get('mod-version-value').textContent, '0.5.5');
    assert.equal(elements.get('status-message').textContent, 'LolkaMod установлен.');

    state = { ...state, status: { found: true, installed: true, modVersion: '0.5.5' } };
    await elements.get('check-button').emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.get('update-dialog').open, true);
    await elements.get('apply-update-button').emit('click');
    assert.equal(releaseCalls, 1);
    assert.match(elements.get('status-message').textContent, /Страница релиза открыта/);
  } finally {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
  }
});
