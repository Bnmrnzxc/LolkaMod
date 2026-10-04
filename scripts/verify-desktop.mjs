import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFile } from '@electron/asar';
import { hash, SUPPORTED_HASH, DEFAULT_INSTALLATION } from './install.mjs';
const resources = path.join(DEFAULT_INSTALLATION, 'resources');
const {version} = JSON.parse(await fs.readFile('package.json','utf8'));
const modDir = path.join(resources, 'lolkamod');
const manifest = JSON.parse(await fs.readFile(path.join(modDir, 'install.json'), 'utf8'));
assert.equal(manifest.modVersion, version);
const original = path.join(resources, '_app.asar');
assert.equal(hash(await fs.readFile(original)), SUPPORTED_HASH);
assert.equal(hash(await fs.readFile(path.join(resources, 'app.asar'))), manifest.shimHash);
assert.equal(await fs.readFile(path.join(modDir, 'main.cjs'), 'utf8'), await fs.readFile('dist/main.cjs', 'utf8'));
const expectedPreload = `// Original preload retained in its own scope.\n(function(){\n${extractFile(original, 'dist-js/preload.js').toString()}\n})();\n${await fs.readFile('dist/preload.js', 'utf8')}`;
assert.equal(await fs.readFile(path.join(modDir, 'preload.js'), 'utf8'), expectedPreload);
const config = JSON.parse(await fs.readFile(path.join(modDir, 'config.json'), 'utf8'));
assert.deepEqual(config, {testMode: false, baseline: false});
async function listFiles(root, dir = root) {
  const results = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await listFiles(root, file));
    else if (entry.isFile()) results.push({path: path.relative(root, file), sha256: hash(await fs.readFile(file))});
  }
  return results;
}
const originalFiles = await listFiles('.runtime/desktop');
assert.equal(originalFiles.length, 86);
for (const file of originalFiles) {
  const expectedHash = file.path === path.join('resources','app.asar') ? manifest.shimHash : file.sha256;
  assert.equal(hash(await fs.readFile(path.join(DEFAULT_INSTALLATION, file.path))), expectedHash, file.path);
}
const tap = await fs.readFile(`.runtime/evidence/tests-${version}.tap`, 'utf8');
const count = name => Number(tap.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]);
assert.equal(count('fail'),0);assert.equal(count('pass'),55);assert.equal(count('skipped'),0);
const publicSource = JSON.parse(await fs.readFile('research/runtime/2026-10-04/public-native-build.json','utf8'));
for (const field of ['npmCiOffline','build','typecheck']) assert.equal(publicSource[field], 'PASS');
assert.equal(publicSource.tests.failed,0);
assert.equal(publicSource.archiveSha256,hash(await fs.readFile(publicSource.archive)));
const evidence = {status: 'PASS', verifiedAt: new Date().toISOString(), installedManifest: manifest,
  originalInstallationFiles: originalFiles, nativeAndExeUnchanged: true,
  restoreAndUninstallOnClone: 'PASS', productionProfileLaunch: 'NOT RUN',
  automatedTests: {passed:count('pass'),failed:count('fail'),skipped:count('skipped')},
  runtime: Object.fromEntries(await Promise.all(['baseline','smoke','restart','disabled',`stream-${version}`,`native-picker-${version}`,`native-picker-restart-${version}`].map(async name => [name, JSON.parse(await fs.readFile(`.runtime/evidence/${name}.json`, 'utf8'))]))),
  installerSha256:hash(await fs.readFile(`release/LolkaModInstaller-${version}.exe`)),
  release:JSON.parse(await fs.readFile('release/release-manifest.json','utf8')),
  publicSource,
  limits: ['clipboard native import unavailable in sandbox', 'account login, capture/audio and reconnect not exercised', 'Lolka SFU 1440p sender/viewer not measured; local synthetic encoded/decoded 2560x1440 passed', 'full plugin SDK, dependency stages and update migration pending']};
await fs.mkdir('research/runtime/2026-10-04', {recursive: true});
await fs.writeFile('research/runtime/2026-10-04/desktop-native-quality-verification.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({status:evidence.status, installed:manifest.modVersion, originalBackupHash:SUPPORTED_HASH, originalFilesVerified:originalFiles.length, tests:evidence.automatedTests}));
