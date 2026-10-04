import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodeTest from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractFile } from '@electron/asar';
import { hash, install, repair, SUPPORTED_HASH, uninstall } from '../scripts/install.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(workspace, '.runtime', 'tests');
const originalArchive = path.join(workspace, 'research', 'original', 'app.asar');
const test = (name, run) => nodeTest(name, { skip: !existsSync(originalArchive) && 'Local original Lolka ASAR fixture is not distributed' }, run);

async function makeInstallation(run) {
  await fs.mkdir(testsRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testsRoot, 'installer-'));
  const resources = path.join(root, 'resources');
  await fs.mkdir(resources);
  await fs.copyFile(originalArchive, path.join(resources, 'app.asar'));

  try {
    return await run({ root, resources, archive: path.join(resources, 'app.asar') });
  } finally {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(path.resolve(testsRoot), resolvedRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to remove path outside .runtime/tests: ${resolvedRoot}`);
    }
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('install preserves exact original, writes a shim and matching manifest', async () => {
  const originalBytes = await fs.readFile(originalArchive);
  assert.equal(hash(originalBytes), SUPPORTED_HASH);

  await makeInstallation(async ({ root, resources, archive }) => {
    const result = await install(root);
    const backup = await fs.readFile(path.join(resources, '_app.asar'));
    const installedBytes = await fs.readFile(archive);
    const manifest = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'install.json'), 'utf8'));
    const shimPackage = JSON.parse(extractFile(archive, 'package.json').toString());

    assert.deepEqual(backup, originalBytes);
    assert.equal(digest(backup), SUPPORTED_HASH);
    assert.equal(digest(installedBytes), result.shimHash);
    assert.equal(shimPackage.main, 'index.js');
    assert.equal(manifest.originalHash, SUPPORTED_HASH);
    assert.equal(manifest.shimHash, result.shimHash);
    assert.equal(manifest.hostVersion, result.hostVersion);
  });
});

test('repeated install refuses to overwrite backup or installed files', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const installedBytes = await fs.readFile(archive);
    const backupBytes = await fs.readFile(path.join(resources, '_app.asar'));

    await assert.rejects(install(root));
    assert.deepEqual(await fs.readFile(archive), installedBytes);
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), backupBytes);
  });
});

test('uninstall restores exact bytes and is idempotent', async () => {
  const originalBytes = await fs.readFile(originalArchive);

  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const result = await uninstall(root);
    assert.equal(result.restored, true);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
    assert.equal(await exists(path.join(resources, '_app.asar')), false);
    assert.equal(await exists(path.join(resources, 'lolkamod')), false);

    const repeated = await uninstall(root);
    assert.equal(repeated.alreadyRestored, true);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
  });
});

test('unsupported original archive is refused without creating install artifacts', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    const altered = Buffer.concat([await fs.readFile(archive), Buffer.from('changed')]);
    await fs.writeFile(archive, altered);

    await assert.rejects(install(root), /Unsupported or already modified/);
    assert.deepEqual(await fs.readFile(archive), altered);
    assert.equal(await exists(path.join(resources, '_app.asar')), false);
    assert.equal(await exists(path.join(resources, 'lolkamod')), false);
  });
});

test('uninstall rejects and preserves a corrupt original backup', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const currentBytes = await fs.readFile(archive);
    const corruptBackup = Buffer.concat([await fs.readFile(path.join(resources, '_app.asar')), Buffer.from('corrupt')]);
    await fs.writeFile(path.join(resources, '_app.asar'), corruptBackup);

    await assert.rejects(uninstall(root), /integrity mismatch/);
    assert.deepEqual(await fs.readFile(archive), currentBytes);
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), corruptBackup);
    assert.equal(await exists(path.join(resources, 'lolkamod')), true);
  });
});

test('unexpected host archive is preserved through repair and uninstall cleanup', async () => {
  const originalBytes = await fs.readFile(originalArchive);

  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const unexpectedBytes = Buffer.concat([await fs.readFile(archive), Buffer.from('unexpected entry')]);
    await fs.writeFile(archive, unexpectedBytes);

    await assert.rejects(uninstall(root), /Host entry changed since installation/);
    assert.deepEqual(await fs.readFile(archive), unexpectedBytes);

    const result = await repair(root);
    assert.equal(result.repaired, true);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
    const recoveredFiles = (await fs.readdir(resources)).filter(name => name.startsWith('lolkamod-recovered-'));
    assert.equal(recoveredFiles.length, 1);
    assert.deepEqual(await fs.readFile(path.join(resources, recoveredFiles[0])), unexpectedBytes);

    const cleanup = await uninstall(root);
    assert.equal(cleanup.restored, true);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
    assert.deepEqual((await fs.readdir(resources)).filter(name => name.startsWith('lolkamod-recovered-')), recoveredFiles);
    assert.equal(await exists(path.join(resources, '_app.asar')), false);
    assert.equal(await exists(path.join(resources, 'lolkamod')), false);
  });
});

test('uninstall cleans artifacts when the original archive was restored before cleanup', async () => {
  const originalBytes = await fs.readFile(originalArchive);

  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    await fs.copyFile(originalArchive, archive);

    const result = await uninstall(root);
    assert.equal(result.restored, true);
    assert.deepEqual(await fs.readFile(archive), originalBytes);
    assert.equal(await exists(path.join(resources, '_app.asar')), false);
    assert.equal(await exists(path.join(resources, 'lolkamod')), false);
  });
});
