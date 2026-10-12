import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { CDP } from './cdp.mjs';
import { applyOperation, inspectInstallation } from './portable-platform.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function parseArgs(argv) {
  const result = { runtime: false };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--runtime') result.runtime = true;
    else if (['--root', '--report'].includes(item)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${item} requires a value`);
      result[item.slice(2)] = path.resolve(value);
    } else throw new Error(`Unknown argument: ${item}`);
  }
  if (!result.root || !result.report) throw new Error('Usage: node scripts/verify-platform.mjs --root <isolated Lolka directory or .app> --report <json path> [--runtime]');
  return result;
}

function assertIsolatedRoot(root) {
  const permitted = [path.join(workspace, 'research'), path.join(workspace, '.runtime')];
  const runnerTemp = process.env.RUNNER_TEMP;
  if (runnerTemp && path.isAbsolute(runnerTemp)) permitted.push(path.resolve(runnerTemp));
  if (!permitted.some(parent => within(root, parent))) {
    throw new Error(`Refusing vendor installation outside research/, .runtime/, or RUNNER_TEMP: ${root}`);
  }
  if (path.resolve(root) === workspace || path.resolve(root) === path.parse(root).root) throw new Error('Refusing an ambiguous installation root');
}

async function findExecutable(root) {
  const candidates = process.platform === 'darwin'
    ? [path.join(root, 'Contents', 'MacOS', 'Lolka')]
    : process.platform === 'linux'
      ? [path.join(root, 'lolka'), path.join(root, 'Lolka')]
      : [path.join(root, 'Lolka.exe'), path.join(root, 'lolka'), path.join(root, 'Lolka')];
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* try next layout */ }
  }
  throw new Error(`Could not find the vendor executable under ${root}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForPage(port, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(target => target.type === 'page' && new URL(target.url).origin === 'https://lolka.app');
        if (page) return page;
      }
    } catch { /* Electron's local debugging endpoint is not ready yet. */ }
    await delay(300);
  }
  throw new Error('The vendor window did not load https://lolka.app before the runtime timeout');
}

async function waitForRuntimeReady(cdp, timeoutMs = 60_000) {
  const expression = `(()=>{
    const api=window.electronAPI, native=window.LolkaModNative, mod=window.LolkaMod;
    const diagnostics=native?.diagnostics?.(), modDiagnostics=mod?.diagnostics?.();
    const modules=(modDiagnostics?.modules??[]).map(entry=>entry.name);
    return {
      origin:location.origin,
      hostBridge:!!api && typeof api.getAppVersion==='function' && typeof api.desktopCapturer?.getSources==='function' && typeof api.desktopCapturer?.setSelectedSource==='function',
      modBridge:!!native && diagnostics?.testMode===true,
      modReady:mod?.ready===true,
      modVersion:mod?.version??null,
      diagnosticsTestMode:diagnostics?.testMode===true,
      structuralPatches:{modules,nativeQuality:modDiagnostics?.nativeQuality===true,
        settings:modDiagnostics?.features?.settings===true,controls:modDiagnostics?.features?.controls===true},
    };
  })()`;
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try {
      const state = await cdp.evaluate(expression);
      if (state.origin === 'https://lolka.app' && state.hostBridge && state.modBridge && state.modReady &&
          state.structuralPatches.nativeQuality && state.structuralPatches.settings && state.structuralPatches.controls &&
          ['HostSettings', 'StreamControls', 'ScreenShareSettings'].every(name => state.structuralPatches.modules.includes(name))) return state;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`The vendor renderer did not finish loading its host and LolkaMod bridges within ${timeoutMs / 1000}s${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopOwnedProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  const signalOwned = signal => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signalOwned('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    delay(8_000).then(() => false),
  ]);
  if (!exited) {
    signalOwned('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3_000)]);
  }
}

async function runRuntime(root, userData, report) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('--runtime supports the CI targets Linux and macOS only');
  if (process.platform === 'linux' && process.arch !== 'x64') throw new Error(`Runtime QA target is Linux x64; got ${process.arch}`);
  if (process.platform === 'darwin' && process.arch !== 'arm64') throw new Error(`Runtime QA target is macOS arm64; got ${process.arch}`);
  const executable = await findExecutable(root), port = await freePort();
  const args = [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`];
  if (process.platform === 'linux' && process.getuid?.() === 0 && process.env.CI === 'true') args.push('--no-sandbox');
  const child = spawn(executable, args, { cwd: root, detached: process.platform !== 'win32', stdio: 'ignore', env: process.env });
  let cdp;
  try {
    const page = await waitForPage(port);
    cdp = await CDP.connect(port);
    const state = await waitForRuntimeReady(cdp);
    state.hostVersion = await cdp.evaluate('window.electronAPI.getAppVersion()');
    assert.equal(state.origin, 'https://lolka.app', 'Expected the vendor application page');
    assert.equal(state.hostBridge, true, 'Original electronAPI.desktopCapturer contract is missing');
    assert.equal(state.modBridge, true, 'LolkaModNative test bridge is missing');
    assert.equal(state.modReady, true, 'LolkaMod did not initialize');
    assert.equal(state.diagnosticsTestMode, true, 'Main process did not enter isolated testMode');
    assert.equal(state.structuralPatches.nativeQuality, true, 'ScreenShareSettings structural patch was not initialized');
    assert.ok(state.structuralPatches.modules.includes('HostSettings'), 'Host settings patch is missing');
    assert.ok(state.structuralPatches.modules.includes('StreamControls'), 'Stream controls patch is missing');
    assert.ok(state.structuralPatches.modules.includes('ScreenShareSettings'), 'Screen share settings patch is missing');
    assert.equal(state.structuralPatches.settings, true, 'Host settings capability is missing');
    assert.equal(state.structuralPatches.controls, true, 'Stream controls capability is missing');
    assert.ok(state.hostVersion, 'Original host getAppVersion did not return a version');
    const resources = process.platform === 'darwin' ? path.join(root, 'Contents', 'Resources') : path.join(root, 'resources');
    const adapter = JSON.parse(await fs.readFile(path.join(resources, 'lolkamod', 'compatibility.json'), 'utf8'));
    assert.equal(adapter.status, 'transformed', 'Current vendor entry was not structurally transformed');
    assert.ok(Array.isArray(adapter.patches) && adapter.patches.length > 0, 'Source adapter reported no active structural patches');
    report.runtime = {
      status: 'PASS', executable, pageUrl: page.url, hostVersion: state.hostVersion,
      modVersion: state.modVersion, hostDesktopCapturerBridge: true, modNativeBridge: true,
      modReady: true, structuralPatches: state.structuralPatches,
      sourceAdapter: { status: adapter.status, compatibility: adapter.compatibility, hash: adapter.hash, patches: adapter.patches },
      scope: 'Vendor window and bridge initialization only; no login, screen capture, stream start, media quality, or 1440p claim.',
    };
  } finally {
    cdp?.close();
    await stopOwnedProcess(child);
  }
}

async function inspectOriginalContracts(root) {
  const resources = process.platform === 'darwin' || root.toLowerCase().endsWith('.app')
    ? path.join(root, 'Contents', 'Resources')
    : path.join(root, 'resources');
  const archivePath = path.join(resources, 'app.asar');
  const archive = await fs.readFile(archivePath);
  const main = extractFile(archivePath, 'dist-js/main.js').toString('utf8');
  const preload = extractFile(archivePath, 'dist-js/preload.js').toString('utf8');
  assert.match(main, /require\s*\(\s*["']electron["']\s*\)/);
  for (const contract of ['BrowserWindow', 'ipcMain', 'https://lolka.app', 'get-desktop-sources', 'set-display-media-selected-source']) {
    assert.ok(main.includes(contract), `Original main contract is missing: ${contract}`);
  }
  assert.match(preload, /require\s*\(\s*["']electron["']\s*\)/);
  assert.match(preload, /exposeInMainWorld\s*\(\s*["']electronAPI["']\s*,/);
  for (const contract of ['getAppVersion', 'desktopCapturer', 'get-desktop-sources', 'set-display-media-selected-source']) {
    assert.ok(preload.includes(contract), `Original preload contract is missing: ${contract}`);
  }
  return { archivePath, archiveBytes: archive, archiveHash: sha256(archive), main: 'dist-js/main.js', preload: 'dist-js/preload.js', getAppVersion: true, desktopCapturer: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  let initial, contractResult;
  try {
    assertIsolatedRoot(options.root);
    const rootStat = await fs.stat(options.root);
    assert.ok(rootStat.isDirectory(), '--root must be an extracted installation directory or .app bundle');
    const canonicalRoot = await fs.realpath(options.root);
    assertIsolatedRoot(canonicalRoot);
    initial = await inspectInstallation(options.root);
    assert.equal(initial.found, true, 'No supported Lolka installation was found');
    assert.equal(initial.installed, false, 'Expected a clean, unmodified vendor installation at the start');
    assert.match(initial.originalHash ?? '', /^[a-f0-9]{64}$/);
    contractResult = await inspectOriginalContracts(options.root);
    assert.equal(contractResult.archiveHash, initial.originalHash, 'Original contracts must come from the unmodified app.asar');
  } catch (error) {
    const failed = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), status: 'FAIL', platform: process.platform, architecture: process.arch, root: options.root, error: error.stack ?? String(error) };
    await fs.mkdir(path.dirname(options.report), { recursive: true });
    await fs.writeFile(options.report, `${JSON.stringify(failed, null, 2)}\n`);
    throw error;
  }
  const { archiveBytes: originalArchive, ...hostContracts } = contractResult;
  const report = {
    schemaVersion: 1, startedAt, platform: process.platform,
    architecture: process.arch, root: options.root, hostVersion: initial.hostVersion,
    checks: { cleanHostDetected: true, originalHash: initial.originalHash, hostContracts: { status: 'PASS', ...hostContracts } },
  };
  const userData = path.join(workspace, '.runtime', `lolkamod-platform-qa-userdata-${crypto.randomUUID()}`);
  const operationOptions = { payloadDirectory: path.join(workspace, 'dist'), testMode: true, userData };
  let installed = false, error;
  try {
    const installResult = await applyOperation('install', options.root, operationOptions);
    installed = true;
    const afterInstall = await inspectInstallation(options.root);
    assert.equal(afterInstall.installed, true);
    assert.equal(afterInstall.hostVersion, initial.hostVersion);
    assert.equal(afterInstall.originalHash, initial.originalHash);
    assert.match(afterInstall.shimHash ?? '', /^[a-f0-9]{64}$/);
    const modDirectory = path.join(path.dirname(hostContracts.archivePath), 'lolkamod');
    const testConfig = JSON.parse(await fs.readFile(path.join(modDirectory, 'config.json'), 'utf8'));
    assert.equal(testConfig.testMode, true, 'Installer must set isolated testMode before runtime');
    assert.equal(path.resolve(testConfig.userData), path.resolve(userData), 'Installer must use this run\'s unique userData directory');
    report.checks.install = { status: 'PASS', modVersion: afterInstall.modVersion, shimHash: afterInstall.shimHash, result: installResult };

    const reinstallResult = await applyOperation('install', options.root, operationOptions);
    const afterReinstall = await inspectInstallation(options.root);
    assert.equal(afterReinstall.originalHash, initial.originalHash, 'Repeat install must preserve the original archive');
    assert.equal(afterReinstall.shimHash, afterInstall.shimHash, 'Repeat install must be idempotent');
    const reinstalledConfig = JSON.parse(await fs.readFile(path.join(modDirectory, 'config.json'), 'utf8'));
    assert.equal(reinstalledConfig.testMode, true);
    assert.equal(path.resolve(reinstalledConfig.userData), path.resolve(userData));
    report.checks.reinstall = { status: 'PASS', shimHash: afterReinstall.shimHash, isolatedTestMode: true, result: reinstallResult };

    const backupPath = path.join(path.dirname(hostContracts.archivePath), '_app.asar');
    const backupBytes = await fs.readFile(backupPath);
    assert.deepEqual(backupBytes, originalArchive, 'Saved original app.asar changed after install');
    report.checks.originalBackup = { status: 'PASS', sha256: sha256(backupBytes), byteExact: true };
    if (options.runtime) await runRuntime(options.root, userData, report);
    else report.runtime = { status: 'NOT_RUN', reason: '--runtime was not supplied' };
  } catch (failure) { error = failure; }
  finally {
    if (installed) {
      try {
        await applyOperation('uninstall', options.root, operationOptions);
        const restored = await inspectInstallation(options.root);
        assert.equal(restored.installed, false);
        assert.equal(restored.originalHash, initial.originalHash, 'Uninstall did not restore original app.asar byte-for-byte');
        const restoredBytes = await fs.readFile(hostContracts.archivePath);
        assert.deepEqual(restoredBytes, originalArchive, 'Uninstall did not restore the original app.asar bytes');
        report.checks.uninstall = { status: 'PASS', originalHash: restored.originalHash, byteExact: true };
      } catch (cleanupError) { error ??= cleanupError; report.checks.uninstall = { status: 'FAIL', error: cleanupError.message }; }
    }
    await fs.rm(userData, { recursive: true, force: true });
  }
  report.finishedAt = new Date().toISOString();
  report.status = error ? 'FAIL' : 'PASS';
  if (error) report.error = error.stack ?? String(error);
  await fs.mkdir(path.dirname(options.report), { recursive: true });
  await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, report: options.report }));
  if (error) throw error;
}

main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
