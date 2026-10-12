import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';
import { applyOperation, inspectInstallation } from './portable-platform.mjs';

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--executable', '--root', '--report', '--screenshot'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (values[argument]) throw new Error(`${argument} may be specified only once`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    values[argument] = value;
  }
  if (!values['--executable'] || !values['--root']) {
    throw new Error('Usage: node scripts/verify-installer-ui.mjs --executable <absolute packaged executable> --root <isolated Lolka fixture> [--report <json path>] [--screenshot <png path>]');
  }
  if (!path.isAbsolute(values['--executable'])) throw new Error('--executable must be an absolute path');
  return {
    executable: path.resolve(values['--executable']),
    root: path.resolve(values['--root']),
    report: values['--report'] ? path.resolve(values['--report']) : null,
    screenshot: values['--screenshot'] ? path.resolve(values['--screenshot']) : null,
  };
}

function assertContained(candidate, parents, label) {
  if (!parents.some(parent => within(candidate, parent))) throw new Error(`Refusing ${label} outside approved QA directories: ${candidate}`);
  if (parents.some(parent => path.resolve(candidate) === path.resolve(parent))) throw new Error(`Refusing an approved directory itself as ${label}: ${candidate}`);
}

async function validatePaths(options) {
  const output = path.join(workspace, 'release', 'portable');
  const linuxInstalledDirectory = path.resolve('/opt/LolkaMod Installer');
  const permittedRoots = [path.join(workspace, '.runtime'), path.join(workspace, 'research')];
  if (process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP)) permittedRoots.push(path.resolve(process.env.RUNNER_TEMP));
  assertContained(options.root, permittedRoots, 'vendor root');
  const linuxSystemExecutable = process.platform === 'linux'
    && within(options.executable, linuxInstalledDirectory)
    && path.dirname(path.resolve(options.executable)) === linuxInstalledDirectory;
  if (!linuxSystemExecutable) assertContained(options.executable, [output], 'installer executable');

  const rootStat = await fs.lstat(options.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('--root must be a real, isolated vendor installation directory');
  const root = await fs.realpath(options.root);
  assertContained(root, permittedRoots, 'canonical vendor root');

  const executableStat = await fs.stat(options.executable);
  if (!executableStat.isFile()) throw new Error('--executable must identify a packaged executable file');
  const executable = await fs.realpath(options.executable);
  if (linuxSystemExecutable) {
    if (path.dirname(executable) !== linuxInstalledDirectory) throw new Error('The system-installed Linux executable must resolve inside /opt/LolkaMod Installer');
    for (let current = executable; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        throw new Error(`Unsafe system-installed Linux executable path: ${current}`);
      }
      if (path.dirname(current) === current) break;
    }
  } else assertContained(executable, [output], 'canonical installer executable');
  if (process.platform !== 'win32') await fs.access(executable, fs.constants.X_OK);

  if (options.report && (within(options.report, root) || within(options.report, output))) throw new Error('Report path must stay outside the vendor root and packaged installer directory');
  if (options.screenshot && (within(options.screenshot, root) || within(options.screenshot, output))) throw new Error('Screenshot path must stay outside the vendor root and packaged installer directory');
  if (options.report && options.screenshot && path.resolve(options.report) === path.resolve(options.screenshot)) throw new Error('Report and screenshot paths must be different');
  return { root, executable, permittedRoots };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function getPageUrl(target) {
  try {
    const url = new URL(target.url);
    return url.protocol === 'file:' && decodeURIComponent(url.pathname).endsWith('/renderer.html');
  } catch { return false; }
}

async function connectInstaller(port, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let target;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged installer exited before its UI was ready (code ${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find(entry => entry.type === 'page' && getPageUrl(entry));
        if (target) break;
      }
    } catch (error) { lastError = error; }
    await delay(200);
  }
  if (!target) throw new Error(`Packaged installer renderer was not exposed over loopback CDP${lastError ? `: ${lastError.message}` : ''}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to the packaged installer renderer')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
  });
  return { target, cdp: new CDP(socket) };
}

async function waitFor(cdp, expression, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression);
      if (predicate(last)) return last;
    } catch (error) { lastError = error; }
    await delay(200);
  }
  const actual = last === undefined ? lastError?.message : JSON.stringify(last);
  throw new Error(`Timed out waiting for ${label}${actual ? `; last value: ${actual}` : ''}`);
}

const uiSnapshot = `(()=>({
  url:location.href,
  readyState:document.readyState,
  title:document.title,
  path:document.querySelector('#installation-path')?.value??null,
  client:document.querySelector('#client-value')?.textContent?.trim()??null,
  status:document.querySelector('#mod-status-value')?.textContent?.trim()??null,
  modVersion:document.querySelector('#mod-version-value')?.textContent?.trim()??null,
  installerVersion:document.querySelector('#installer-version')?.textContent?.trim()??null,
  message:document.querySelector('#status-message')?.textContent?.trim()??null,
  dialogOpen:document.querySelector('#update-dialog')?.open??false,
  installDisabled:document.querySelector('#install-button')?.disabled??true,
  uninstallDisabled:document.querySelector('#uninstall-button')?.disabled??true,
  repairDisabled:document.querySelector('#repair-button')?.disabled??true,
  bridge:!!window.installer&&['getState','chooseFolder','inspect','action','openRelease','onProgress'].every(name=>typeof window.installer[name]==='function'),
  nodeIntegration:{require:typeof window.require,process:typeof window.process,ipcRenderer:typeof window.ipcRenderer},
}))()`;

async function waitUi(cdp, predicate, label, timeoutMs) {
  return waitFor(cdp, uiSnapshot, predicate, label, timeoutMs);
}

function archiveLocation(root) {
  const resources = path.join(root, process.platform === 'darwin' ? 'Contents/Resources' : 'resources');
  return { resources, archive: path.join(resources, 'app.asar'), backup: path.join(resources, '_app.asar') };
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopOwnedProcess(child, cdp) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { await cdp?.send('Browser.close'); } catch { /* fall through to this run's process handle */ }
  if (await waitForChildExit(child, 5_000)) return;
  if (process.platform === 'win32') {
    try {
      // The PID comes only from this script's own spawn call; /T closes its child tree.
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    } catch (error) {
      if (!await waitForChildExit(child, 1_000) && !/not found|no running instance/i.test(error.stderr ?? '')) throw error;
    }
    if (!await waitForChildExit(child, 5_000)) throw new Error(`Could not stop the installer process tree rooted at PID ${child.pid}`);
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (await waitForChildExit(child, 5_000)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (!await waitForChildExit(child, 3_000)) throw new Error(`Could not stop the installer process group ${child.pid}`);
}

async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = crypto.randomUUID();
  const reportPath = options.report ?? path.join(workspace, '.runtime', 'evidence', `installer-ui-${runId}.json`);
  const qaUserData = path.join(workspace, '.runtime', `installer-ui-userdata-${runId}`);
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'FAIL',
    platform: process.platform,
    architecture: process.arch,
    executable: options.executable,
    root: options.root,
    report: reportPath,
    qaUserData,
    screenshot: options.screenshot,
    installerVersion: null,
    checks: {},
  };
  let validated;
  let child;
  let cdp;
  let installed = false;
  let primaryError;

  try {
    validated = await validatePaths(options);
    report.root = validated.root;
    report.executable = validated.executable;
    const initial = await inspectInstallation(validated.root);
    assert.equal(initial.found, true, 'The isolated vendor fixture is not a supported Lolka installation');
    assert.equal(initial.installed, false, 'The isolated vendor fixture must start without LolkaMod');
    assert.match(initial.originalHash ?? '', /^[a-f0-9]{64}$/, 'The vendor fixture must expose its original ASAR hash');
    const files = archiveLocation(validated.root);
    const originalArchive = await fs.readFile(files.archive);
    const originalHash = sha256(originalArchive);
    assert.equal(originalHash, initial.originalHash, 'Initial app.asar bytes do not match the vendor inspection hash');
    report.checks.isolatedVendor = {
      status: 'PASS', found: initial.found, installed: initial.installed,
      hostVersion: initial.hostVersion, originalArchiveSha256: originalHash,
    };

    await fs.mkdir(path.dirname(qaUserData), { recursive: true });
    const userDataStat = await fs.lstat(path.dirname(qaUserData));
    assert.ok(userDataStat.isDirectory(), 'The isolated QA profile parent must exist');
    await fs.mkdir(qaUserData, { mode: 0o700 });
    const port = await freePort();
    const args = [
      '--installer-qa-hidden',
      `--user-data-dir=${qaUserData}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
    ];
    child = spawn(validated.executable, args, {
      cwd: path.dirname(validated.executable),
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    const connected = await connectInstaller(port, child);
    cdp = connected.cdp;
    await cdp.send('Page.enable');
    const initialUi = await waitUi(cdp, value => value.readyState === 'complete' && value.bridge
      && value.installerVersion?.startsWith('v') && value.client !== '—' && value.message !== 'Проверяем установку…', 'initial installer state');
    assert.equal(new URL(initialUi.url).protocol, 'file:', 'Installer UI must remain a local file page');
    assert.equal(initialUi.title, 'LolkaMod — установщик');
    assert.equal(initialUi.bridge, true, 'The preload bridge is incomplete');
    assert.equal(initialUi.nodeIntegration.require, 'undefined', 'Renderer must not expose require');
    assert.equal(initialUi.nodeIntegration.process, 'undefined', 'Renderer must not expose process');
    assert.equal(initialUi.nodeIntegration.ipcRenderer, 'undefined', 'Renderer must not expose ipcRenderer');
    const profileEntries = await fs.readdir(qaUserData);
    assert.ok(profileEntries.length > 0, 'Electron did not initialize the isolated QA user-data directory');
    report.installerVersion = (await cdp.evaluate('window.installer.getState()')).version;
    assert.equal(report.installerVersion, packageInfo.version, 'Packaged installer version differs from package.json');
    report.checks.hiddenWindowAndBridge = {
      status: 'PASS', url: initialUi.url, bridge: initialUi.bridge,
      nodeIntegration: initialUi.nodeIntegration, userData: qaUserData, userDataInitialized: true,
    };

    // Never follow the remote-update action during QA. Dismiss a startup notice without saving a preference.
    if (initialUi.dialogOpen) {
      await cdp.evaluate("document.querySelector('#skip-update-button').click(); true");
      await waitUi(cdp, value => !value.dialogOpen, 'startup update notice dismissal');
    }

    const inspected = await cdp.evaluate(`window.installer.inspect(${JSON.stringify(validated.root)})`);
    assert.equal(inspected.installation, validated.root);
    assert.equal(inspected.status?.found, true, 'Preload inspect did not recognize the isolated Lolka fixture');
    assert.equal(inspected.status?.installed, false, 'Fixture unexpectedly reports an existing mod');
    assert.ok(inspected.status?.hostVersion, 'Preload inspect did not return the host version');
    await cdp.evaluate(`(()=>{const field=document.querySelector('#installation-path');field.value=${JSON.stringify(validated.root)};document.querySelector('#check-button').click();return true})()`);
    const checkedUi = await waitUi(cdp, value => value.path === validated.root && value.client === 'Найден' && !value.installDisabled, 'selected fixture rendering');
    report.checks.fixtureInspection = { status: 'PASS', hostVersion: inspected.status.hostVersion, ui: checkedUi };

    await cdp.evaluate("document.querySelector('#install-button').click(); true");
    const installedUi = await waitUi(cdp, value => value.status === 'Установлен' && value.modVersion === packageInfo.version && !value.uninstallDisabled, 'install action and installed UI');
    installed = true;
    const installedState = await cdp.evaluate('window.installer.getState()');
    assert.equal(installedState.status?.found, true);
    assert.equal(installedState.status?.installed, true);
    assert.equal(installedState.status?.modVersion, packageInfo.version);
    const installedDisk = await inspectInstallation(validated.root);
    assert.equal(installedDisk.installed, true);
    assert.equal(installedDisk.modVersion, packageInfo.version);
    const backupBytes = await fs.readFile(files.backup);
    assert.deepEqual(backupBytes, originalArchive, 'Installer did not preserve an exact original ASAR backup');
    report.checks.installViaUi = {
      status: 'PASS', ui: installedUi, modVersion: installedDisk.modVersion,
      originalBackupSha256: sha256(backupBytes), exactOriginalBackup: true,
    };

    if (options.screenshot) {
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdp.evaluate('document.documentElement.getBoundingClientRect().toJSON()');
      let screenshot;
      let screenshotError;
      for (const parameters of [
        { format: 'png', fromSurface: false },
        { format: 'png', fromSurface: true },
      ]) {
        try { screenshot = await cdp.send('Page.captureScreenshot', parameters); break; }
        catch (error) { screenshotError = error; }
      }
      if (!screenshot) throw screenshotError ?? new Error('CDP did not capture the hidden installer window');
      const screenshotBytes = Buffer.from(screenshot.data, 'base64');
      assert.deepEqual(screenshotBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'CDP did not return a PNG screenshot');
      await fs.mkdir(path.dirname(options.screenshot), { recursive: true });
      await fs.writeFile(options.screenshot, screenshotBytes);
      report.checks.hiddenWindowScreenshot = { status: 'PASS', path: options.screenshot, bytes: screenshotBytes.length, sha256: sha256(screenshotBytes) };
    }

    await cdp.evaluate("document.querySelector('#uninstall-button').click(); true");
    const removedUi = await waitUi(cdp, value => value.status === 'Не установлен' && value.modVersion === '—' && !value.installDisabled, 'uninstall action and restored UI');
    const removedState = await cdp.evaluate('window.installer.getState()');
    assert.equal(removedState.status?.installed, false);
    const restoredDisk = await inspectInstallation(validated.root);
    assert.equal(restoredDisk.found, true);
    assert.equal(restoredDisk.installed, false);
    assert.equal(restoredDisk.originalHash, originalHash);
    const restoredArchive = await fs.readFile(files.archive);
    assert.deepEqual(restoredArchive, originalArchive, 'Uninstall did not restore the original ASAR byte-for-byte');
    installed = false;
    report.checks.uninstallViaUi = {
      status: 'PASS', ui: removedUi, originalArchiveSha256: sha256(restoredArchive), byteExact: true,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (installed && cdp) {
      try {
        await cdp.evaluate(`window.installer.action({operation:'uninstall',installation:${JSON.stringify(validated.root)}})`);
      } catch { /* Disk-level cleanup below handles a closed renderer. */ }
    }
    try { await stopOwnedProcess(child, cdp); }
    catch (error) { primaryError ??= error; report.checks.processCleanup = { status: 'FAIL', error: error.message }; }
    cdp?.close();

    if (validated) {
      try {
        const remaining = await inspectInstallation(validated.root);
        if (remaining.installed) {
          await applyOperation('uninstall', validated.root);
          const restored = await inspectInstallation(validated.root);
          assert.equal(restored.installed, false);
          report.checks.failureRecovery = { status: 'PASS', originalHash: restored.originalHash };
        }
      } catch (error) {
        primaryError ??= error;
        report.checks.failureRecovery = { status: 'FAIL', error: error.message };
      }
    }

    try { await fs.rm(qaUserData, { recursive: true, force: true }); }
    catch (error) { primaryError ??= error; report.checks.profileCleanup = { status: 'FAIL', error: error.message }; }
  }

  report.finishedAt = new Date().toISOString();
  report.status = primaryError ? 'FAIL' : 'PASS';
  if (primaryError) report.error = primaryError.stack ?? String(primaryError);
  await writeJSON(reportPath, report);
  console.log(JSON.stringify({ status: report.status, report: reportPath, screenshot: options.screenshot ?? undefined }));
  if (primaryError) throw primaryError;
}

main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
