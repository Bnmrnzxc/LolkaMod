import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const fixture = path.join(workspace, 'tests', 'fixtures', 'InstallerUpdatesHarness.cs');
const source = path.join(workspace, 'Installer', 'InstallerUpdates.cs');
const canCompile = process.platform === 'win32' && await fs.access(csc).then(() => true, () => false);
const missingApi = !(await fs.access(source).then(() => true, () => false));
const skipReason = !canCompile ? 'Windows .NET Framework csc.exe is unavailable' : missingApi ? 'InstallerUpdates.cs is not present' : undefined;

let tempRoot, executable;
if (!skipReason) {
  tempRoot = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'lolkamod-updates-test-')));
  executable = path.join(tempRoot, 'InstallerUpdatesHarness.exe');
  await execFileAsync(csc, [
    '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${executable}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Web.Extensions.dll',
    source, fixture,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
}

const tag = 'v0.6.0';
const installerBytes = Buffer.concat([Buffer.from('MZ'), Buffer.from('fixture installer payload')]);
const installerSha256 = crypto.createHash('sha256').update(installerBytes).digest('hex');
const installerUrl = `https://github.com/Bnmrnzxc/LolkaMod/releases/download/${tag}/LolkaModInstaller.exe`;
const release = overrides => ({
  tag_name: tag,
  html_url: `https://github.com/Bnmrnzxc/LolkaMod/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [{
    name: 'LolkaModInstaller.exe',
    size: installerBytes.length,
    digest: `sha256:${installerSha256}`,
    browser_download_url: installerUrl,
    state: 'uploaded',
    content_type: 'application/octet-stream',
  }],
  ...overrides,
});

async function invoke(args, input = '') {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Harness timed out')); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
  if (result.code !== 0) return { ok: false };
  try { return JSON.parse(result.stdout); } catch { throw new Error(`Harness returned invalid JSON: ${result.stderr}`); }
}

async function parse(value) {
  return invoke(['parse'], JSON.stringify(value));
}

test('installer update test harness compiles the pure C# service', { skip: skipReason }, () => {
  assert.ok(executable);
});

test('release parser requires one stable, exact public installer asset', { skip: skipReason }, async () => {
  const valid = await parse(release());
  assert.deepEqual(valid, {
    ok: true, Version: '0.6.0', AssetUrl: installerUrl,
    AssetSha256: installerSha256, AssetSize: installerBytes.length,
  });

  const cases = [
    release({ draft: true }),
    release({ prerelease: true }),
    release({ draft: undefined }),
    release({ prerelease: undefined }),
    release({ tag_name: 'v0.6.0-beta.1' }),
    release({ tag_name: 'v01.6.0' }),
    release({ tag_name: 'v0.6.0\n', html_url: 'https://github.com/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0\n',
      assets: [{ ...release().assets[0], browser_download_url: 'https://github.com/Bnmrnzxc/LolkaMod/releases/download/v0.6.0\n/LolkaModInstaller.exe' }] }),
    release({ html_url: 'https://github.com.evil.example/Bnmrnzxc/LolkaMod/releases/tag/v0.6.0' }),
    release({ assets: [] }),
    release({ assets: [release().assets[0], release().assets[0]] }),
    release({ assets: [{ ...release().assets[0], name: 'LolkaModInstaller-0.6.0.exe' }] }),
    release({ assets: [{ ...release().assets[0], browser_download_url: installerUrl + '?download=1' }] }),
    release({ assets: [{ ...release().assets[0], browser_download_url: installerUrl.replace('https://', 'http://') }] }),
    release({ assets: [{ ...release().assets[0], digest: 'md5:' + 'a'.repeat(32) }] }),
    release({ assets: [{ ...release().assets[0], digest: 'sha256:' + 'A'.repeat(64) }] }),
    release({ assets: [{ ...release().assets[0], digest: `sha256:${installerSha256}\n` }] }),
    release({ assets: [{ ...release().assets[0], state: undefined }] }),
    release({ assets: [{ ...release().assets[0], state: 'new' }] }),
    release({ assets: [{ ...release().assets[0], size: '29' }] }),
    release({ assets: [{ ...release().assets[0], size: 29.5 }] }),
    release({ assets: [{ ...release().assets[0], size: 0 }] }),
    release({ assets: [{ ...release().assets[0], size: 64 * 1024 * 1024 + 1 }] }),
  ];
  for (const invalid of cases) assert.equal((await parse(invalid)).ok, false);
  assert.equal((await invoke(['parse'], '{ malformed')).ok, false);
  assert.equal((await invoke(['parse'], 'x'.repeat(512 * 1024 + 1))).ok, false);
});

test('semver comparison handles numeric components and prerelease ordering', { skip: skipReason }, async () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2',
    '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.9', '1.0.10', '1.1.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(Math.sign((await invoke(['compare', ordered[i], ordered[i + 1]])).result), -1);
    assert.equal(Math.sign((await invoke(['compare', ordered[i + 1], ordered[i]])).result), 1);
  }
  for (const invalid of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2', '1.2.3 trailing']) {
    assert.equal((await invoke(['compare', invalid, '1.2.3'])).ok, false, invalid);
  }
});

test('installer verification checks actual size, SHA-256 and MZ signature', { skip: skipReason }, async () => {
  const file = path.join(tempRoot, 'fixture.exe');
  await fs.writeFile(file, installerBytes);
  assert.equal((await invoke(['verify', file], JSON.stringify(release()))).ok, true);
  assert.equal((await invoke(['verify-end', file], JSON.stringify(release()))).ok, true,
    'verification succeeds even when the stream position starts at EOF, as after download');

  const sameSizeWrongHash = Buffer.from(installerBytes);
  sameSizeWrongHash[sameSizeWrongHash.length - 1] ^= 1;
  await fs.writeFile(file, sameSizeWrongHash);
  assert.equal((await invoke(['verify-end', file], JSON.stringify(release())).then(value => value.ok)), false,
    'verification still rejects a corrupted file when the stream position starts at EOF');
  for (const bytes of [Buffer.concat([installerBytes, Buffer.from('extra')]), sameSizeWrongHash, Buffer.from('MZwrong payload')]) {
    await fs.writeFile(file, bytes);
    assert.equal((await invoke(['verify', file], JSON.stringify(release()))).ok, false);
  }
  await fs.writeFile(file, Buffer.from('not a PE'));
  const invalidRelease = release({ assets: [{ ...release().assets[0], size: 8,
    digest: `sha256:${crypto.createHash('sha256').update('not a PE').digest('hex')}` }] });
  assert.equal((await invoke(['verify', file], JSON.stringify(invalidRelease))).ok, false);
});

test('download URI allowlist accepts GitHub asset path and approved CDN redirect only', { skip: skipReason }, async () => {
  const check = (url, redirected) => invoke(['uri'], JSON.stringify({ url, redirected }));
  assert.equal((await check(installerUrl, false)).allowed, true);
  assert.equal((await check(installerUrl, true)).allowed, true);
  assert.equal((await check('https://release-assets.githubusercontent.com/opaque/object', true)).allowed, true);
  for (const url of [
    'http://github.com/Bnmrnzxc/LolkaMod/releases/download/v0.6.0/LolkaModInstaller.exe',
    'https://github.com.evil.example/Bnmrnzxc/LolkaMod/releases/download/v0.6.0/LolkaModInstaller.exe',
    'https://github.com@evil.example/Bnmrnzxc/LolkaMod/releases/download/v0.6.0/LolkaModInstaller.exe',
    installerUrl + '#fragment',
    installerUrl.replace('github.com/', 'github.com:444/'),
    'https://example.com/opaque/object',
  ]) assert.equal((await check(url, false)).allowed, false, url);
  assert.equal((await check('https://release-assets.githubusercontent.com/opaque/object', false)).allowed, false);
  assert.equal((await check('https://example.com/opaque/object', true)).allowed, false);
});

test('Windows argument quoting preserves spaces, embedded quotes and a final slash', { skip: skipReason }, async () => {
  const value = 'C:\\Games\\Lolka "Beta"\\';
  assert.equal((await invoke(['quote'], JSON.stringify(value))).result, '"C:\\Games\\Lolka \\\"Beta\\\"\\\\"');
});

test.after(async () => {
  if (!tempRoot) return;
  const resolved = path.resolve(tempRoot), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('lolkamod-updates-test-'));
  await fs.rm(resolved, { recursive: true, force: true });
});
