import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
    assert.equal(manifest.hostVersion, '1.0.120');
    assert.equal(manifest.originalHash, originalArchiveHash);
    assert.equal(manifest.shimHash, hash(installedBytes));
    assert.equal(manifest.testMode, true);
    assert.equal(config.testMode, true);
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
    const unknown = Buffer.concat([await fs.readFile(archive), Buffer.from('unknown archive bytes')]);
    await fs.writeFile(archive, unknown);

    const result = await invoke('--install', tempRoot);
    assertFailure(result, /Поддерживается только original/);
    assert.deepEqual(await fs.readFile(archive), unknown);
    assert.equal(await fileExists(path.join(resources, '_app.asar')), false);
    assert.equal(await fileExists(path.join(resources, 'lolkamod')), false);
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
