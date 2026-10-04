import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPackage, extractFile } from '@electron/asar';

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
const modVersion = packageInfo.version;
const installerFilename = `LolkaModInstaller-${modVersion}.exe`;
const installerPath = path.join(workspace, 'release', installerFilename);
const installerChecksumPath = path.join(workspace, 'release', `LolkaModInstaller-${modVersion}.sha256`);
const originalArchivePath = path.join(workspace, 'research', 'original', 'app.asar');
const originalArchiveHash = 'fd94ecec264d7d7a56a0b5d1bb5ac1e416b6c9a4ee2d171b3704b0b72f0260a8';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function directoryDigest(folder) {
  const items = [];
  async function walk(current, prefix) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name), relative = prefix + name;
      if ((await fs.stat(file)).isDirectory()) { items.push(`d:${relative}\n`); await walk(file, `${relative}/`); }
      else items.push(`f:${relative}:${hash(await fs.readFile(file))}\n`);
    }
  }
  await walk(folder, ''); return hash(Buffer.from(items.join('')));
}

async function fileExists(file) {
  return fs.access(file).then(() => true, () => false);
}

const missingRequirements = [];
if (process.platform !== 'win32') missingRequirements.push('native installer tests require Windows');
if (!(await fileExists(installerPath))) missingRequirements.push(`release/${installerFilename} is absent`);
if (!(await fileExists(originalArchivePath))) missingRequirements.push('research/original/app.asar fixture is absent');
const skipReason = missingRequirements.length ? missingRequirements.join('; ') : undefined;

let observedInstallerHash;
let observedArchiveHash;
let checksumText;
if (!skipReason) {
  observedInstallerHash = hash(await fs.readFile(installerPath));
  observedArchiveHash = hash(await fs.readFile(originalArchivePath));
  checksumText = await fs.readFile(installerChecksumPath, 'utf8').catch(() => '');
}
const integrityValid = !skipReason &&
  /^[a-f0-9]{64}$/i.test(checksumText.trim().split(/\s+/)[0] ?? '') &&
  observedInstallerHash === checksumText.trim().split(/\s+/)[0] &&
  observedArchiveHash === originalArchiveHash &&
  checksumText.trim().split(/\s+/)[1] === installerFilename;
const operationSkipReason = skipReason ?? (!integrityValid ? 'installer/source integrity check failed; see integrity test' : undefined);

async function withFixture(callback) {
  const tempRoot = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-native-installer-')));
  const resources = path.join(tempRoot, 'resources');
  const userData = path.join(tempRoot, 'separate-user-data');
  await fs.mkdir(resources);
  await fs.mkdir(userData);
  await fs.copyFile(originalArchivePath, path.join(resources, 'app.asar'));
  assert.equal(hash(await fs.readFile(path.join(resources, 'app.asar'))), originalArchiveHash);
  assert.equal(await fileExists(path.join(tempRoot, 'Lolka.exe')), false, 'fixture must not contain a client executable');

  try {
    return await callback({ tempRoot, resources, userData, archive: path.join(resources, 'app.asar') });
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), tempRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing recursive cleanup outside OS temp: ${tempRoot}`);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function invoke(operation, root, args = []) {
  const reportPath = path.join(root, `report-${crypto.randomUUID()}.json`);
  const commandArgs = [operation, root, ...args, '--report', reportPath];
  let processResult;
  try {
    processResult = await execFileAsync(installerPath, commandArgs, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    processResult = {
      error,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
  const report = await fs.readFile(reportPath, 'utf8').then(JSON.parse, () => null);
  return {
    exitCode: processResult.error ? processResult.error.code ?? 1 : 0,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    report,
  };
}

function assertSuccess(result) {
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.report?.ok, true, JSON.stringify(result.report));
  assert.equal(result.report?.version, modVersion);
}

function assertFailure(result, messagePattern) {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.report?.ok, false, JSON.stringify(result.report));
  assert.match(result.report?.result ?? '', messagePattern);
}

test('release installer and original fixture match their pinned integrity data', { skip: skipReason }, () => {
  const [expectedInstallerHash, expectedFilename] = checksumText.trim().split(/\s+/);
  assert.match(expectedInstallerHash ?? '', /^[a-f0-9]{64}$/i, 'release checksum sidecar is malformed or missing');
  assert.equal(expectedFilename, installerFilename);
  assert.equal(observedInstallerHash, expectedInstallerHash, 'release executable hash differs from its sidecar');
  assert.equal(observedArchiveHash, originalArchiveHash, 'original app.asar fixture hash changed');
});

test('install backs up exact original and writes its manifest and composed preload', { skip: operationSkipReason }, async () => {
  const originalBytes = await fs.readFile(originalArchivePath);
  const { extractFile } = await import('@electron/asar');

  await withFixture(async ({ tempRoot, resources, userData, archive }) => {
    const userSettingsPath = path.join(userData, 'settings-sentinel.json');
    const userSettings = Buffer.from('{"keep":"user profile sentinel"}\n');
    await fs.writeFile(userSettingsPath, userSettings);
    const result = await invoke('--install', tempRoot, ['--test-user-data', userData]);
    assertSuccess(result);

    const backup = await fs.readFile(path.join(resources, '_app.asar'));
    const installedBytes = await fs.readFile(archive);
    const manifest = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'install.json'), 'utf8'));
    const config = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'config.json'), 'utf8'));
    const originalPreload = extractFile(originalArchivePath, 'dist-js/preload.js').toString('utf8');
    const composedPreload = await fs.readFile(path.join(resources, 'lolkamod', 'preload.js'), 'utf8');

    assert.deepEqual(backup, originalBytes);
    assert.equal(hash(backup), originalArchiveHash);
    assert.equal(manifest.modVersion, modVersion);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.hostVersion, '1.0.120');
    assert.equal(manifest.originalHash, originalArchiveHash);
    assert.equal(manifest.shimHash, hash(installedBytes));
    assert.equal(manifest.testMode, true);
    assert.equal(config.testMode, true);
    assert.equal(config.hostMain, 'dist-js/main.js');
    assert.equal(config.hostPreload, 'dist-js/preload.js');
    assert.equal(config.userData, path.resolve(userData));
    assert.ok(composedPreload.startsWith('// Original preload retained in its own scope.\n(function(){\n'));
    assert.ok(composedPreload.includes(`\n${originalPreload}\n})();\n`));
    assert.ok(composedPreload.slice(composedPreload.indexOf(`\n${originalPreload}\n})();\n`) + originalPreload.length).length > 0);
    assert.deepEqual(await fs.readFile(userSettingsPath), userSettings);

    const status = await invoke('--status', tempRoot);
    assertSuccess(status);
    assert.match(status.report.result, /Backup проверен/);
  });
});

test('repeated install upgrades a valid installation and preserves the original backup', { skip: operationSkipReason }, async () => {
  const originalBytes = await fs.readFile(originalArchivePath);

  await withFixture(async ({ tempRoot, resources, userData, archive }) => {
    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    const firstManifest = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'install.json'), 'utf8'));
    const firstArchive = await fs.readFile(archive);

    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    const secondManifest = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'install.json'), 'utf8'));
    const secondArchive = await fs.readFile(archive);

    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), originalBytes);
    assert.equal(firstManifest.originalHash, originalArchiveHash);
    assert.equal(secondManifest.originalHash, originalArchiveHash);
    assert.equal(hash(firstArchive), firstManifest.shimHash);
    assert.equal(hash(secondArchive), secondManifest.shimHash);
    assert.equal(secondManifest.modVersion, modVersion);
  });
});

test('uninstall restores byte-identical original and can repeat idempotently', { skip: operationSkipReason }, async () => {
  const originalBytes = await fs.readFile(originalArchivePath);

  await withFixture(async ({ tempRoot, resources, userData, archive }) => {
    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    assertSuccess(await invoke('--uninstall', tempRoot));
    assert.deepEqual(await fs.readFile(archive), originalBytes);
    assert.equal(await fileExists(path.join(resources, '_app.asar')), false);
    assert.equal(await fileExists(path.join(resources, 'lolkamod')), false);

    const repeated = await invoke('--uninstall', tempRoot);
    assertSuccess(repeated);
    assert.match(repeated.report.result, /уже удалён/);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
  });
});

test('unsupported archive remains byte-identical after install refusal', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    const unknown = Buffer.from('not an Electron ASAR');
    await fs.writeFile(archive, unknown);

    const result = await invoke('--install', tempRoot);
    assertFailure(result, /Неподдерживаемый или изменённый/);
    assert.deepEqual(await fs.readFile(archive), unknown);
    assert.equal(await fileExists(path.join(resources, '_app.asar')), false);
    assert.equal(await fileExists(path.join(resources, 'lolkamod')), false);
  });
});

async function changedHost(root, { version = '1.0.121', minor = '', removeBridge = false, formatted = false } = {}) {
  const folder = path.join(root, `host-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(folder, 'dist-js'), { recursive: true });
  const pkg = JSON.parse(extractFile(originalArchivePath, 'package.json').toString());
  pkg.version = version;
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify(pkg));
  let main = extractFile(originalArchivePath, 'dist-js/main.js').toString();
  let preload = extractFile(originalArchivePath, 'dist-js/preload.js').toString();
  if (formatted) {
    main = main.replaceAll('require("electron")', 'require ( "electron" )');
    preload = preload.replaceAll('require("electron")', 'require ( "electron" )').replace('exposeInMainWorld("electronAPI",', 'exposeInMainWorld ( "electronAPI" ,');
  }
  if (removeBridge) main = main.replaceAll('set-display-media-selected-source', 'changed-bridge');
  await fs.writeFile(path.join(folder, 'dist-js', 'main.js'), `${main}\n// ${minor}\n`);
  await fs.writeFile(path.join(folder, 'dist-js', 'preload.js'), preload);
  const output = path.join(root, `host-${crypto.randomUUID()}.asar`);
  await createPackage(folder, output); return fs.readFile(output);
}

test('native installer accepts compatible new versions and same-version ASAR rebuilds', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    for (const minor of ['first compatible build', 'same version rebuilt']) {
      const next = await changedHost(tempRoot, { version: '1.2.9', minor });
      await fs.writeFile(archive, next);
      assertSuccess(await invoke('--install', tempRoot));
      const manifest = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'install.json')));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.hostVersion, '1.2.9');
      assert.equal(manifest.originalHash, hash(next));
      assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), next);
      assertSuccess(await invoke('--uninstall', tempRoot));
      assert.deepEqual(await fs.readFile(archive), next);
    }
  });
});

test('native desktop compatibility tolerates whitespace-only main and preload reformatting', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, archive, resources }) => {
    const formatted = await changedHost(tempRoot, { formatted: true }); await fs.writeFile(archive, formatted);
    assertSuccess(await invoke('--install', tempRoot));
    const manifest = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'install.json')));
    assert.equal(manifest.originalHash, hash(formatted));
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), formatted);
    assertSuccess(await invoke('--uninstall', tempRoot)); assert.deepEqual(await fs.readFile(archive), formatted);
  });
});

test('native repatch after vendor update repairs orphan files and restores latest original on uninstall', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    assertSuccess(await invoke('--install', tempRoot));
    const next = await changedHost(tempRoot);
    await fs.writeFile(archive, next);
    await fs.writeFile(path.join(resources, 'lolkamod', 'install.json'), 'invalid old manifest');
    await fs.writeFile(path.join(resources, 'lolkamod', 'compatibility.json'), '{"status":"transformed"}');
    const status = await invoke('--status', tempRoot); assertSuccess(status);
    assert.match(status.report.result, /обновлена или мод снят/);
    assertSuccess(await invoke('--install', tempRoot));
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), next);
    assert.equal(await fileExists(path.join(resources, 'lolkamod', 'compatibility.json')), false);
    const rotations = (await fs.readdir(resources)).filter(name => name.startsWith('lolkamod-backup-'));
    assert.equal(rotations.length, 1);
    assert.deepEqual(await fs.readFile(path.join(resources, rotations[0])), await fs.readFile(originalArchivePath));
    assertSuccess(await invoke('--install', tempRoot));
    assertSuccess(await invoke('--uninstall', tempRoot));
    assert.deepEqual(await fs.readFile(archive), next);
    assert.equal(await fileExists(path.join(resources, rotations[0])), true);
  });
});

test('native uninstall and repair never downgrade a valid live vendor update', { skip: operationSkipReason }, async () => {
  for (const operation of ['--uninstall', '--repair']) await withFixture(async ({ tempRoot, resources, archive, userData }) => {
    assertSuccess(await invoke('--install', tempRoot));
    const next = await changedHost(tempRoot, { version: '2.0.0' });
    await fs.writeFile(archive, next);
    await fs.writeFile(path.join(resources, '_app.asar'), 'damaged obsolete backup');
    await fs.writeFile(path.join(resources, 'lolkamod', 'install.json'), '{}');
    const sentinel = path.join(userData, 'sentinel.json'); await fs.writeFile(sentinel, '{"keep":"profile"}');
    assertSuccess(await invoke(operation, tempRoot));
    assert.deepEqual(await fs.readFile(archive), next);
    assert.equal(await fs.readFile(sentinel, 'utf8'), '{"keep":"profile"}');
    assert.equal(await fileExists(path.join(resources, 'lolkamod')), false);
  });
});

test('native own shim with missing backup or corrupt manifest stays byte-identical', { skip: operationSkipReason }, async () => {
  for (const damage of ['backup', 'manifest']) await withFixture(async ({ tempRoot, resources, archive }) => {
    assertSuccess(await invoke('--install', tempRoot));
    if (damage === 'backup') await fs.unlink(path.join(resources, '_app.asar'));
    else await fs.writeFile(path.join(resources, 'lolkamod', 'install.json'), 'broken');
    const installed = await fs.readFile(archive);
    for (const operation of ['--install', '--uninstall', '--repair']) assert.notEqual((await invoke(operation, tempRoot)).exitCode, 0);
    assert.deepEqual(await fs.readFile(archive), installed);
  });
});

test('native installer rejects unsupported changed IPC bridge without modifying files', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    const next = await changedHost(tempRoot, { removeBridge: true });
    await fs.writeFile(archive, next);
    assertFailure(await invoke('--install', tempRoot), /Неподдерживаемый или изменённый/);
    assert.deepEqual(await fs.readFile(archive), next);
    assert.equal(await fileExists(path.join(resources, '_app.asar')), false);
  });
});

test('native installer migrates old schema 1 manifests without replacing verified backup', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    assertSuccess(await invoke('--install', tempRoot));
    const manifestPath = path.join(resources, 'lolkamod', 'install.json'), manifest = JSON.parse(await fs.readFile(manifestPath));
    delete manifest.schemaVersion; delete manifest.hostMain; delete manifest.hostPreload;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    assertSuccess(await invoke('--install', tempRoot));
    assert.equal(JSON.parse(await fs.readFile(manifestPath)).schemaVersion, 2);
    assertSuccess(await invoke('--uninstall', tempRoot));
    assert.deepEqual(await fs.readFile(archive), await fs.readFile(originalArchivePath));
  });
});

test('native installer recovers a journaled interrupted entry/backup replacement', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    const original = await fs.readFile(archive), interrupted = Buffer.from('interrupted own entry');
    const stageName = `.lolkamod-stage-${crypto.randomUUID()}`, stage = path.join(resources, stageName);
    await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'entry.before'), original);
    await fs.writeFile(path.join(resources, '_app.asar'), original); await fs.writeFile(archive, interrupted);
    await fs.writeFile(path.join(resources, '.lolkamod-transaction.json'), JSON.stringify({ schemaVersion: 1, stage: stageName, archiveBeforeHash: hash(original), archiveAfterHash: hash(interrupted), backupBeforeHash: null, backupAfterHash: hash(original), beforeModHash: null, afterModHash: null }));
    assertSuccess(await invoke('--install', tempRoot));
    assert.equal(await fileExists(path.join(resources, '.lolkamod-transaction.json')), false);
    assert.equal(await fileExists(stage), false);
    assertSuccess(await invoke('--uninstall', tempRoot));
    assert.deepEqual(await fs.readFile(archive), original);
  });
});

test('native installer rejects traversal in recovery journal and preserves live entry', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    const original = await fs.readFile(archive);
    await fs.writeFile(path.join(resources, '.lolkamod-transaction.json'), JSON.stringify({ schemaVersion: 1, stage: '..', archiveBeforeHash: hash(original), archiveAfterHash: hash(original) }));
    assertFailure(await invoke('--install', tempRoot), /recovery journal/);
    assert.deepEqual(await fs.readFile(archive), original);
  });
});

test('native journal recovery rolls back an interrupted payload directory swap before uninstall', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, archive, resources }) => {
    assertSuccess(await invoke('--install', tempRoot));
    const mod = path.join(resources, 'lolkamod'), original = await fs.readFile(path.join(resources, '_app.asar'));
    const entryBefore = await fs.readFile(archive), entryAfter = Buffer.from('staged new shim before simulated process exit');
    const stageName = `.lolkamod-stage-${crypto.randomUUID()}`, stage = path.join(resources, stageName);
    await fs.mkdir(stage);
    await fs.writeFile(path.join(stage, 'entry.before'), entryBefore);
    await fs.writeFile(path.join(stage, 'backup.before'), original);
    const beforeModHash = await directoryDigest(mod);
    await fs.cp(mod, path.join(stage, 'mod.before'), { recursive: true });
    await fs.rename(mod, path.join(stage, 'mod.removed'));
    await fs.cp(path.join(stage, 'mod.before'), mod, { recursive: true });
    await fs.writeFile(path.join(mod, 'update-in-progress.txt'), 'partial new payload');
    const afterModHash = await directoryDigest(mod);
    await fs.writeFile(archive, entryAfter);
    await fs.writeFile(path.join(resources, '.lolkamod-transaction.json'), JSON.stringify({ schemaVersion: 1, stage: stageName, archiveBeforeHash: hash(entryBefore), archiveAfterHash: hash(entryAfter), backupBeforeHash: hash(original), backupAfterHash: hash(original), beforeModHash, afterModHash }));
    assertSuccess(await invoke('--uninstall', tempRoot));
    assert.deepEqual(await fs.readFile(archive), original);
    assert.equal(await fileExists(mod), false);
    assert.equal(await fileExists(stage), false);
    assert.equal(await fileExists(path.join(resources, '.lolkamod-transaction.json')), false);
  });
});

test('native normal repatch clears test mode while leaving the explicit separate profile untouched', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, userData }) => {
    const sentinel = path.join(userData, 'settings.json'); await fs.writeFile(sentinel, '{"keep":true}');
    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    assertSuccess(await invoke('--install', tempRoot));
    const config = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'config.json')));
    assert.equal(config.testMode, false); assert.equal(config.userData, undefined);
    assert.equal(await fs.readFile(sentinel, 'utf8'), '{"keep":true}');
  });
});

test('native installer rejects junctions and preserves external user files', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    assertSuccess(await invoke('--install', tempRoot));
    const outside = path.join(tempRoot, 'user-owned'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel.txt'), 'keep');
    const link = path.join(resources, 'lolkamod', 'linked'); await fs.symlink(outside, link, 'junction');
    const current = await fs.readFile(archive);
    try {
      assertFailure(await invoke('--install', tempRoot), /symbolic link\/junction/);
      assert.deepEqual(await fs.readFile(archive), current);
      assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    } finally { await fs.unlink(link); }
  });
});

test('corrupt backup is refused without changing the installed entry or mod files', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, userData, archive }) => {
    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    const installed = await fs.readFile(archive);
    const manifest = await fs.readFile(path.join(resources, 'lolkamod', 'install.json'));
    const corruptBackup = Buffer.concat([await fs.readFile(path.join(resources, '_app.asar')), Buffer.from('corrupt')]);
    await fs.writeFile(path.join(resources, '_app.asar'), corruptBackup);

    const result = await invoke('--uninstall', tempRoot);
    assertFailure(result, /повреждена/);
    assert.deepEqual(await fs.readFile(archive), installed);
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), corruptBackup);
    assert.deepEqual(await fs.readFile(path.join(resources, 'lolkamod', 'install.json')), manifest);
  });
});

test('unknown current entry refuses uninstall, then repair preserves it and restores original', { skip: operationSkipReason }, async () => {
  const originalBytes = await fs.readFile(originalArchivePath);

  await withFixture(async ({ tempRoot, resources, userData, archive }) => {
    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    const unknownEntry = Buffer.concat([await fs.readFile(archive), Buffer.from('unrecognized replacement')]);
    await fs.writeFile(archive, unknownEntry);

    const uninstall = await invoke('--uninstall', tempRoot);
    assertFailure(uninstall, /ASAR изменён/);
    assert.deepEqual(await fs.readFile(archive), unknownEntry);

    const repair = await invoke('--repair', tempRoot);
    assertSuccess(repair);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
    assert.equal(await fileExists(path.join(resources, '_app.asar')), false);
    assert.equal(await fileExists(path.join(resources, 'lolkamod')), false);
    const recovered = (await fs.readdir(resources)).filter(name => /^lolkamod-recovered-[\w-]+\.asar$/.test(name));
    assert.equal(recovered.length, 1);
    assert.deepEqual(await fs.readFile(path.join(resources, recovered[0])), unknownEntry);
  });
});

test('structured status cards reflect actual entry and verified backup without mutating files', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    const original = await fs.readFile(archive);
    let result = await invoke('--status', tempRoot); assertSuccess(result);
    assert.equal(result.report.status.ClientFound, true);
    assert.equal(result.report.status.HostVersion, '1.0.120');
    assert.equal(result.report.status.ModInstalled, false);
    assert.equal(result.report.status.BackupVerified, false);
    assert.equal(result.report.status.NeedsRepatch, false);
    assert.equal(result.report.status.RecoveryPending, false);
    assert.deepEqual(await fs.readFile(archive), original);

    assertSuccess(await invoke('--install', tempRoot));
    const installed = await fs.readFile(archive);
    result = await invoke('--status', tempRoot); assertSuccess(result);
    assert.equal(result.report.status.ModInstalled, true);
    assert.equal(result.report.status.BackupVerified, true);
    assert.equal(result.report.status.InstalledModVersion, modVersion);
    assert.deepEqual(await fs.readFile(archive), installed);

    // A vendor update replaces the entry while stale mod/backup remain.
    await fs.writeFile(archive, original);
    result = await invoke('--status', tempRoot); assertSuccess(result);
    assert.equal(result.report.status.ModInstalled, false);
    assert.equal(result.report.status.BackupVerified, false);
    assert.equal(result.report.status.InstalledModVersion, null);
    assert.equal(result.report.status.NeedsRepatch, true);
    assert.deepEqual(await fs.readFile(archive), original);

    const journal = path.join(resources, '.lolkamod-transaction.json');
    await fs.writeFile(journal, '{"test":"inspection only"}');
    result = await invoke('--status', tempRoot); assertSuccess(result);
    assert.equal(result.report.status.RecoveryPending, true);
    assert.equal(result.report.status.ModInstalled, false);
    assert.equal(result.report.status.BackupVerified, false);
    assert.equal(await fs.readFile(journal, 'utf8'), '{"test":"inspection only"}');
    assert.deepEqual(await fs.readFile(archive), original);
  });
});

test('structured status refuses corrupt backup instead of claiming an installed mod', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, resources, archive }) => {
    assertSuccess(await invoke('--install', tempRoot));
    const installed = await fs.readFile(archive);
    await fs.writeFile(path.join(resources, '_app.asar'), 'corrupt');
    const result = await invoke('--status', tempRoot);
    assertFailure(result, /повреждена/);
    assert.equal(result.report.status, null);
    assert.deepEqual(await fs.readFile(archive), installed);
    assert.equal(await fs.readFile(path.join(resources, '_app.asar'), 'utf8'), 'corrupt');
  });
});

test('install and uninstall leave the separate user profile and settings sentinel untouched', { skip: operationSkipReason }, async () => {
  await withFixture(async ({ tempRoot, userData }) => {
    const sentinel = path.join(userData, 'settings.json');
    const content = Buffer.from('{"qualityEnabled":false,"profile":"user-owned"}\r\n');
    await fs.writeFile(sentinel, content);

    assertSuccess(await invoke('--install', tempRoot, ['--test-user-data', userData]));
    assert.deepEqual(await fs.readFile(sentinel), content);
    assertSuccess(await invoke('--uninstall', tempRoot));
    assert.deepEqual(await fs.readFile(sentinel), content);
  });
});
