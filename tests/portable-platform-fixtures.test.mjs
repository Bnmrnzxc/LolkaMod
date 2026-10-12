import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPackage } from '@electron/asar';
import { applyOperation, bundleDigest, inspectInstallation, macStateDirectory } from '../scripts/portable-platform.mjs';
import { install, repair, uninstall } from '../scripts/install.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const hostPackage = {
  name: 'Lolka', homepage: 'https://lolka.app', version: '1.0.100',
  main: 'dist-js/main.js',
};
const hostMain = `const {app, BrowserWindow, ipcMain} = require('electron');
app.whenReady().then(() => new BrowserWindow({webPreferences:{preload:require('path').join(__dirname,'preload.js')}}).loadURL('https://lolka.app/'));
ipcMain.handle('get-desktop-sources', () => []);
ipcMain.handle('set-display-media-selected-source', () => true);
`;
const hostPreload = `const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  desktopCapturer: {
    getSources: options => ipcRenderer.invoke('get-desktop-sources', options),
    setSelectedSource: source => ipcRenderer.invoke('set-display-media-selected-source', source),
  },
});
`;

async function fixture(layout) {
  const base = path.join(workspace, '.runtime');
  await mkdir(base, { recursive: true });
  const temp = await mkdtemp(path.join(base, 'portable-platform-fixture-'));
  const root = layout === 'mac'
    ? path.join(temp, 'Lolka.app')
    : path.join(temp, 'Lolka');
  const resources = layout === 'mac'
    ? path.join(root, 'Contents', 'Resources')
    : path.join(root, 'resources');
  const source = path.join(temp, 'host-source');
  const payloadDirectory = path.join(temp, 'payload');
  await mkdir(source, { recursive: true });
  await mkdir(resources, { recursive: true });
  await mkdir(path.join(source, 'dist-js'), { recursive: true });
  await mkdir(payloadDirectory, { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify(hostPackage));
  await writeFile(path.join(source, 'dist-js', 'main.js'), hostMain);
  await writeFile(path.join(source, 'dist-js', 'preload.js'), hostPreload);
  await createPackage(source, path.join(resources, 'app.asar'));
  await writeFile(path.join(payloadDirectory, 'main.cjs'), '/* fixture mod main */\n');
  await writeFile(path.join(payloadDirectory, 'preload.js'), '/* fixture mod preload */\n');
  await writeFile(path.join(payloadDirectory, 'build.json'), JSON.stringify({ version: '0.5.5-fixture' }));
  return { temp, root, resources, payloadDirectory };
}

async function exercise(layout) {
  const current = await fixture(layout);
  const userData = path.join(current.temp, 'isolated-user-data');
  const opts = { payloadDirectory: current.payloadDirectory, testMode: true, userData };
  try {
    const baseline = await inspectInstallation(current.root);
    assert.equal(baseline.found, true);
    assert.equal(baseline.installed, false);
    assert.equal(baseline.hostVersion, '1.0.100');
    assert.match(baseline.originalHash, /^[a-f0-9]{64}$/);
    const originalArchive = await readFile(path.join(current.resources, 'app.asar'));

    const installResult = await install(current.root, opts);
    assert.ok(installResult);
    const installed = await inspectInstallation(current.root);
    assert.equal(installed.installed, true);
    assert.equal(installed.originalHash, baseline.originalHash);
    assert.match(installed.shimHash, /^[a-f0-9]{64}$/);
    const config = JSON.parse(await readFile(path.join(current.resources, 'lolkamod', 'config.json'), 'utf8'));
    assert.equal(config.testMode, true);
    assert.equal(path.resolve(config.userData), userData);

    await install(current.root, opts);
    const reinstalled = await inspectInstallation(current.root);
    assert.equal(reinstalled.shimHash, installed.shimHash, 'Repeat install should be idempotent');
    assert.equal(reinstalled.originalHash, baseline.originalHash);

    if (layout === 'mac') {
      await repair(current.root);
      const repaired = await inspectInstallation(current.root);
      assert.equal(repaired.installed, false);
      assert.equal(repaired.originalHash, baseline.originalHash);
      assert.deepEqual(await readFile(path.join(current.resources, 'app.asar')), originalArchive, 'Repaired archive bytes must match the fixture');
    } else {
      await uninstall(current.root);
      const restored = await inspectInstallation(current.root);
      assert.equal(restored.installed, false);
      assert.equal(restored.originalHash, baseline.originalHash);
      assert.deepEqual(await readFile(path.join(current.resources, 'app.asar')), originalArchive, 'Restored archive bytes must match the fixture');
    }
  } finally {
    await rm(current.temp, { recursive: true, force: true });
  }
}

test('portable installer handles Linux resources layout and restores exact ASAR bytes', async () => {
  await exercise('linux');
});

test('portable installer handles macOS app bundle layout and repair across all fixture hosts', async () => {
  await exercise('mac');
});

test('macOS signing failure restores the complete isolated ditto copy', {
  skip: process.platform !== 'darwin' ? 'Mac native rollback requires the macOS CI runner' : false,
}, async () => {
  const source = await fixture('mac');
  const framework = path.join(source.root, 'Contents', 'Frameworks', 'Electron Framework.framework');
  const infoPlist = path.join(source.root, 'Contents', 'Info.plist');
  const copiedRoot = path.join(source.temp, 'rollback-copy', 'Lolka.app');
  const stateDirectory = macStateDirectory(copiedRoot);
  try {
    await mkdir(framework, { recursive: true });
    await writeFile(path.join(framework, 'Electron Framework'), Buffer.concat([
      Buffer.from('synthetic-electron-prefix'),
      Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
      Buffer.from([1, 6, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30]),
      Buffer.from('synthetic-electron-suffix'),
    ]));
    await writeFile(infoPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>app.lolka.ci.rollback</string>
  <key>ElectronAsarIntegrity</key><dict>
    <key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>0000000000000000000000000000000000000000000000000000000000000000</string></dict>
  </dict>
</dict></plist>
`);
    await mkdir(path.dirname(copiedRoot), { recursive: true });
    await run('/usr/bin/ditto', ['--rsrc', '--extattr', source.root, copiedRoot]);
    await run('/usr/bin/plutil', ['-remove', 'ElectronAsarIntegrity', path.join(copiedRoot, 'Contents', 'Info.plist')]);
    const beforeDigest = await bundleDigest(copiedRoot);
    const before = await inspectInstallation(copiedRoot);
    assert.equal(before.installed, false);

    await assert.rejects(applyOperation('install', copiedRoot, {
      payloadDirectory: source.payloadDirectory,
      testMode: true,
      userData: path.join(source.temp, 'rollback-user-data'),
    }), /plutil|ElectronAsarIntegrity/i, 'The intentionally missing ElectronAsarIntegrity must fail after core mutation');

    assert.equal(await bundleDigest(copiedRoot), beforeDigest, 'Failed signing must restore every file and metadata in the copied bundle');
    const after = await inspectInstallation(copiedRoot);
    assert.equal(after.installed, false, 'Failed signing must leave the core uninstalled');
    assert.equal(after.originalHash, before.originalHash);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source.temp, { recursive: true, force: true });
  }
});
