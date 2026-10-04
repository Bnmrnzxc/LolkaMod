import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodeTest from 'node:test';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPackage, extractFile } from '@electron/asar';
import { hash, install, inspectHost, repair, SUPPORTED_HASH, uninstall } from '../scripts/install.mjs';

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

async function directoryDigest(folder, prefix = '') {
  const items = [];
  async function walk(current, parent) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name), relative = parent + name;
      if ((await fs.stat(file)).isDirectory()) { items.push(`d:${relative}\n`); await walk(file, `${relative}/`); }
      else items.push(`f:${relative}:${hash(await fs.readFile(file))}\n`);
    }
  }
  await walk(folder, prefix); return hash(Buffer.from(items.join('')));
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

test('repeated install updates the payload while preserving the exact original backup', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const installedBytes = await fs.readFile(archive);
    const backupBytes = await fs.readFile(path.join(resources, '_app.asar'));

    const updated = await install(root);
    assert.equal(updated.installed, true);
    assert.equal(hash(await fs.readFile(archive)), updated.shimHash);
    assert.equal(hash(installedBytes), updated.shimHash);
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
    const altered = Buffer.from('not an Electron ASAR');
    await fs.writeFile(archive, altered);

    await assert.rejects(install(root), /unsupported/);
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

async function changedHost(root, { version = '1.0.121', minor = '', removeBridge = false, formatted = false } = {}) {
  const folder = path.join(root, `host-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(folder, 'dist-js'), { recursive: true });
  const pkg = JSON.parse(extractFile(originalArchive, 'package.json').toString());
  pkg.version = version;
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify(pkg));
  let main = extractFile(originalArchive, 'dist-js/main.js').toString();
  let preload = extractFile(originalArchive, 'dist-js/preload.js').toString();
  if (formatted) {
    main = main.replaceAll('require("electron")', 'require ( "electron" )');
    preload = preload.replaceAll('require("electron")', 'require ( "electron" )').replace('exposeInMainWorld("electronAPI",', 'exposeInMainWorld ( "electronAPI" ,');
  }
  if (removeBridge) main = main.replaceAll('set-display-media-selected-source', 'renamed-bridge');
  await fs.writeFile(path.join(folder, 'dist-js', 'main.js'), `${main}\n// ${minor}\n`);
  await fs.writeFile(path.join(folder, 'dist-js', 'preload.js'), preload);
  const output = path.join(root, `host-${crypto.randomUUID()}.asar`);
  await createPackage(folder, output); return fs.readFile(output);
}

test('structurally compatible new versions and minor byte changes receive schema 2 dynamic hashes', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    const next = await changedHost(root, { version: '1.2.8', minor: 'compatible update' });
    await fs.writeFile(archive, next);
    const installed = await install(root);
    assert.equal(installed.schemaVersion, 2);
    assert.equal(installed.hostVersion, '1.2.8');
    assert.equal(installed.originalHash, hash(next));
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), next);
    const config = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'config.json'), 'utf8'));
    assert.equal(config.hostMain, 'dist-js/main.js');
    assert.equal(config.hostPreload, 'dist-js/preload.js');
    assert.equal(config.testMode, false);
    // Exercise only our loader, with a mocked module boundary: no vendor code runs.
    const electron = { app: { getVersion: () => installed.modVersion, setAppPath: value => { electron.app.appPath = value; } } };
    let requiredHost;
    vm.runInNewContext(extractFile(archive, 'index.js').toString(), {
      process: { resourcesPath: resources, argv: ['--lolkamod-disable'] },
      require: name => {
        if (name === 'path') return path;
        if (name === 'electron') return electron;
        if (name === 'fs') return { readFileSync: file => JSON.stringify(file.endsWith('config.json') ? config : { version: '1.2.8' }) };
        requiredHost = name; return {};
      },
    });
    assert.equal(electron.app.getVersion(), '1.2.8');
    assert.equal(electron.app.appPath, path.join(resources, '_app.asar'));
    assert.equal(requiredHost, path.join(resources, '_app.asar', 'dist-js/main.js'));
    await uninstall(root);
    assert.deepEqual(await fs.readFile(archive), next);
    const minor = await changedHost(root, { version: '1.2.8', minor: 'same version with rebuilt main' });
    await fs.writeFile(archive, minor);
    assert.equal((await install(root)).originalHash, hash(minor));
    await uninstall(root);
    assert.deepEqual(await fs.readFile(archive), minor);
  });
});

test('desktop compatibility tolerates whitespace-only main and preload reformatting', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    const formatted = await changedHost(root, { formatted: true }); await fs.writeFile(archive, formatted);
    assert.equal(inspectHost(formatted).version, '1.0.121');
    assert.equal((await install(root)).originalHash, hash(formatted));
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), formatted);
    await uninstall(root); assert.deepEqual(await fs.readFile(archive), formatted);
  });
});

test('vendor replacement repatches the current host, rotates old backup and never downgrades on uninstall', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const next = await changedHost(root);
    await fs.writeFile(archive, next);
    // Even an orphaned invalid old manifest must not block a verified live host.
    await fs.writeFile(path.join(resources, 'lolkamod', 'install.json'), '{broken');
    await fs.writeFile(path.join(resources, 'lolkamod', 'compatibility.json'), '{"status":"transformed","hash":"stale"}');
    assert.equal((await install(root)).originalHash, hash(next));
    assert.equal(await exists(path.join(resources, 'lolkamod', 'compatibility.json')), false);
    const rotations = (await fs.readdir(resources)).filter(name => name.startsWith('lolkamod-backup-'));
    assert.equal(rotations.length, 1);
    assert.deepEqual(await fs.readFile(path.join(resources, rotations[0])), await fs.readFile(originalArchive));
    await install(root);
    assert.deepEqual(await fs.readFile(path.join(resources, '_app.asar')), next);
    await uninstall(root);
    assert.deepEqual(await fs.readFile(archive), next);
    assert.equal(await exists(path.join(resources, rotations[0])), true);
  });
});

test('uninstall and repair preserve valid vendor replacements with stale or damaged old artifacts', async () => {
  for (const operation of [uninstall, repair]) await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const next = await changedHost(root, { version: '2.0.0' });
    await fs.writeFile(archive, next);
    await fs.writeFile(path.join(resources, '_app.asar'), 'damaged obsolete backup');
    await fs.writeFile(path.join(resources, 'lolkamod', 'install.json'), '{}');
    const sentinel = path.join(root, 'settings-sentinel.json');
    await fs.writeFile(sentinel, '{"user":"untouched"}');
    assert.equal((await operation(root)).preservedUpdatedHost, true);
    assert.deepEqual(await fs.readFile(archive), next);
    assert.equal(await fs.readFile(sentinel, 'utf8'), '{"user":"untouched"}');
    assert.equal(await exists(path.join(resources, 'lolkamod')), false);
  });
});

test('own shim with missing backup or malformed manifest is refused without mutation', async () => {
  for (const damage of ['backup', 'manifest']) await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    if (damage === 'backup') await fs.unlink(path.join(resources, '_app.asar'));
    else await fs.writeFile(path.join(resources, 'lolkamod', 'install.json'), 'invalid');
    const entry = await fs.readFile(archive);
    for (const operation of [install, uninstall, repair]) await assert.rejects(operation(root));
    assert.deepEqual(await fs.readFile(archive), entry);
  });
});

test('changed desktop bridge is unsupported and its bytes and profile remain untouched', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    const next = await changedHost(root, { removeBridge: true });
    await fs.writeFile(archive, next);
    assert.throws(() => inspectHost(next), /main bridge/);
    await assert.rejects(install(root), /unsupported/);
    assert.deepEqual(await fs.readFile(archive), next);
    assert.equal(await exists(path.join(resources, '_app.asar')), false);
  });
});

test('schema 1 installation upgrades to schema 2 without losing its verified original', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const file = path.join(resources, 'lolkamod', 'install.json'), manifest = JSON.parse(await fs.readFile(file));
    delete manifest.schemaVersion; delete manifest.hostMain; delete manifest.hostPreload;
    await fs.writeFile(file, JSON.stringify(manifest));
    assert.equal((await install(root)).schemaVersion, 2);
    await uninstall(root);
    assert.deepEqual(await fs.readFile(archive), await fs.readFile(originalArchive));
  });
});

test('interrupted entry/backup transaction is rolled back before repeat install', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    const original = await fs.readFile(archive), interrupted = Buffer.from('interrupted staged shim');
    const stageName = `.lolkamod-stage-${crypto.randomUUID()}`, stage = path.join(resources, stageName);
    await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'entry.before'), original);
    await fs.writeFile(path.join(resources, '_app.asar'), original); await fs.writeFile(archive, interrupted);
    await fs.writeFile(path.join(resources, '.lolkamod-transaction.json'), JSON.stringify({ schemaVersion: 1, stage: stageName, archiveBeforeHash: hash(original), archiveAfterHash: hash(interrupted), backupBeforeHash: null, backupAfterHash: hash(original), beforeModHash: null, afterModHash: null }));
    assert.equal((await install(root)).installed, true);
    assert.equal(await exists(path.join(resources, '.lolkamod-transaction.json')), false);
    assert.equal(await exists(stage), false);
    await uninstall(root); assert.deepEqual(await fs.readFile(archive), original);
  });
});

test('invalid recovery path is refused without touching live host bytes', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    const original = await fs.readFile(archive);
    await fs.writeFile(path.join(resources, '.lolkamod-transaction.json'), JSON.stringify({ schemaVersion: 1, stage: '..', archiveBeforeHash: hash(original), archiveAfterHash: hash(original) }));
    await assert.rejects(install(root), /Invalid recovery journal/);
    assert.deepEqual(await fs.readFile(archive), original);
  });
});

test('interrupted payload update restores the prior mod tree and verified backup before uninstall', async () => {
  await makeInstallation(async ({ root, archive, resources }) => {
    await install(root);
    const mod = path.join(resources, 'lolkamod'), original = await fs.readFile(path.join(resources, '_app.asar'));
    const entryBefore = await fs.readFile(archive), entryAfter = Buffer.from('staged new shim before a simulated crash');
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
    await uninstall(root);
    assert.deepEqual(await fs.readFile(archive), original);
    assert.equal(await exists(mod), false);
    assert.equal(await exists(stage), false);
    assert.equal(await exists(path.join(resources, '.lolkamod-transaction.json')), false);
  });
});

test('repatch resets test mode unless explicitly requested and preserves the separate profile', async () => {
  await makeInstallation(async ({ root, resources }) => {
    const profile = path.join(root, 'separate-profile'); await fs.mkdir(profile);
    const sentinel = path.join(profile, 'settings.json'); await fs.writeFile(sentinel, '{"keep":true}');
    await install(root, { testMode: true, userData: profile });
    await install(root);
    const config = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'config.json')));
    assert.equal(config.testMode, false); assert.equal(config.userData, undefined);
    assert.equal(await fs.readFile(sentinel, 'utf8'), '{"keep":true}');
  });
});

test('junction within the mod tree is refused before files or external target are changed', async () => {
  await makeInstallation(async ({ root, resources, archive }) => {
    await install(root);
    const outside = path.join(root, 'user-owned'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel.txt'), 'keep');
    const link = path.join(resources, 'lolkamod', 'linked'); await fs.symlink(outside, link, 'junction');
    const current = await fs.readFile(archive);
    try {
      await assert.rejects(install(root), /Symbolic links/);
      assert.deepEqual(await fs.readFile(archive), current);
      assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    } finally { await fs.unlink(link); }
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
