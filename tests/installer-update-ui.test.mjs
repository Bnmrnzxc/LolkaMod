import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const source = path.join(workspace, 'Installer', 'MainForm.cs');
const harness = path.join(workspace, 'tests', 'fixtures', 'InstallerUpdateUIHarness.cs');
const uiSkip = process.platform === 'win32' ? false : 'MainForm lifecycle harness requires Windows WinForms';

async function withTempRoot(callback) {
  const parent = path.resolve(os.tmpdir());
  const root = path.resolve(await fs.mkdtemp(path.join(parent, 'lolkamod-update-ui-')));
  const relative = path.relative(parent, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to use path outside OS temp: ${root}`);
  }
  try { return await callback(root); }
  finally {
    const resolved = path.resolve(root), cleanupRelative = path.relative(parent, resolved);
    if (!cleanupRelative || cleanupRelative.startsWith('..') || path.isAbsolute(cleanupRelative)) {
      throw new Error(`Refusing to remove path outside OS temp: ${resolved}`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function buildHarness(output) {
  await execFileAsync(compiler, [
    '/nologo', '/target:exe', '/platform:x64', `/out:${output}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    source, harness,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
}

async function runScenario(executable, scenario) {
  const result = await execFileAsync(executable, [scenario], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return JSON.parse(result.stdout.trim());
}

test('MainForm prompts every launch and hands update choices to the updater', { skip: uiSkip }, async () => {
  await fs.access(compiler);
  await withTempRoot(async tempRoot => {
    const executable = path.join(tempRoot, 'InstallerUpdateUIHarness.exe');
    await buildHarness(executable);

    const skippedTwice = await runScenario(executable, 'twice');
    assert.deepEqual(skippedTwice, { checks: 2, prompts: 2, bundledPrompts: 0, remotePrompts: 2,
      lastCurrent: '', lastLatest: '0.6.0', downloads: 0, opens: 0, installs: 0, launches: 2, buttonsEnabled: true });

    const accepted = await runScenario(executable, 'update');
    assert.deepEqual(accepted, { checks: 1, prompts: 1, bundledPrompts: 0, remotePrompts: 1,
      lastCurrent: '', lastLatest: '0.6.0', downloads: 1, opens: 1, installs: 0, launches: 1, buttonsEnabled: false });

    for (const scenario of ['equal', 'older']) {
      const current = await runScenario(executable, scenario);
      assert.deepEqual(current, { checks: 1, prompts: 0, bundledPrompts: 0, remotePrompts: 0,
        lastCurrent: '', lastLatest: '', downloads: 0, opens: 0, installs: 0, launches: 1, buttonsEnabled: true });
    }

    const offline = await runScenario(executable, 'offline');
    assert.deepEqual(offline, { checks: 1, prompts: 0, bundledPrompts: 0, remotePrompts: 0,
      lastCurrent: '', lastLatest: '', downloads: 0, opens: 0, installs: 0, launches: 1, buttonsEnabled: true });

    const bundledUpdate = await runScenario(executable, 'local-update');
    assert.deepEqual(bundledUpdate, { checks: 1, prompts: 1, bundledPrompts: 1, remotePrompts: 0,
      lastCurrent: '0.5.4-preview.3', lastLatest: '0.5.5-preview.2', downloads: 0, opens: 0, installs: 1,
      launches: 1, buttonsEnabled: true });

    const bundledSkippedTwice = await runScenario(executable, 'local-twice');
    assert.deepEqual(bundledSkippedTwice, { checks: 2, prompts: 2, bundledPrompts: 2, remotePrompts: 0,
      lastCurrent: '0.5.4-preview.3', lastLatest: '0.5.5-preview.2', downloads: 0, opens: 0, installs: 0,
      launches: 2, buttonsEnabled: true });

    const bundledOffline = await runScenario(executable, 'local-offline');
    assert.deepEqual(bundledOffline, { checks: 1, prompts: 1, bundledPrompts: 1, remotePrompts: 0,
      lastCurrent: '0.5.4-preview.3', lastLatest: '0.5.5-preview.2', downloads: 0, opens: 0, installs: 0,
      launches: 1, buttonsEnabled: true });

    for (const scenario of ['local-current', 'installed-ahead']) {
      const current = await runScenario(executable, scenario);
      assert.deepEqual(current, { checks: 1, prompts: 0, bundledPrompts: 0, remotePrompts: 0,
        lastCurrent: '', lastLatest: '', downloads: 0, opens: 0, installs: 0, launches: 1, buttonsEnabled: true });
    }

    const closedDuringCheck = await runScenario(executable, 'close-cancel');
    assert.equal(closedDuringCheck.checks, 1);
    assert.equal(closedDuringCheck.prompts, 0);
    assert.equal(closedDuringCheck.downloads, 0);
    assert.equal(closedDuringCheck.opens, 0);
    assert.equal(closedDuringCheck.installs, 0);
    assert.equal(closedDuringCheck.launches, 1);
  });
});
