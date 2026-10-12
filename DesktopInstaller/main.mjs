import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createUpdateService } from '../src/main/update-service.ts';

const run = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(here, 'renderer.html')).href;
const backend = path.join(process.resourcesPath, 'backend.mjs');
const defaultPaths = process.platform === 'darwin' ? ['/Applications/Lolka.app', path.join(app.getPath('home'), 'Applications/Lolka.app')] : ['/opt/Lolka', path.join(app.getPath('home'), 'Applications/Lolka')];
let installation = defaultPaths[0], window, busy = false, release = null;
const updater = createUpdateService(app.getVersion());
let checking;

function friendly(error) {
  const message = String(error.message ?? error);
  if (/Close this Lolka/.test(message)) return 'Закрой Lolka полностью, включая трей, и повтори действие.';
  if (/Another installer/.test(message)) return 'Другой установщик уже работает. Дождись его завершения.';
  if (/EACCES|EPERM|permission denied/i.test(message) && process.platform === 'darwin') return 'Нет прав на изменение приложения. Перемести Lolka в папку Applications своего пользователя и выбери её здесь.';
  if (/cancel|dismiss|not authorized/i.test(message)) return 'Изменение отменено. Файлы клиента сохранены.';
  return message;
}

function checkTarget(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Выбери папку установленной Lolka.');
  return path.resolve(value);
}

async function trustedRootTree(root) {
  for (let file = root; ; file = path.dirname(file)) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('Для запроса прав установи LolkaMod из DEB или RPM.');
    if (path.dirname(file) === file) break;
  }
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('Файлы установщика имеют небезопасные права. Переустанови пакет LolkaMod.');
      if (stat.isDirectory()) await walk(file);
    }
  }
  await walk(root);
}

async function helper(operation, target, privileged = false) {
  const args = privileged ? ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', 'ELECTRON_NO_ASAR=1', process.execPath, backend, operation, target] : [backend, operation, target];
  let stdout;
  try {
    const result = await run(privileged ? '/usr/bin/pkexec' : process.execPath, args, {
      timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: privileged ? { PATH: '/usr/bin:/bin', LANG: process.env.LANG ?? 'en_US.UTF-8' } : {
        PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
        ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', LANG: process.env.LANG ?? 'en_US.UTF-8',
      },
    }); stdout = result.stdout;
  } catch (error) {
    stdout = error.stdout;
    if (!stdout?.trim()) throw new Error(privileged ? 'Запрос прав отменён или polkit недоступен.' : error.message);
  }
  let response; try { response = JSON.parse(stdout.trim()); } catch { throw new Error('Не удалось получить ответ установщика.'); }
  if (!response.ok) { const error = new Error(response.error); error.code = response.code; throw error; }
  return response.result;
}

async function state(error) {
  let status;
  try { status = await helper('inspect', installation); }
  catch (failure) {
    // A verified recovery may still be possible when the entry was interrupted.
    const resources = path.join(installation, process.platform === 'darwin' ? 'Contents/Resources' : 'resources');
    const recoverable = await fs.access(path.join(resources, 'lolkamod/install.json')).then(() => true, () => false);
    status = { found: recoverable, installed: recoverable, message: friendly(failure) };
    error ??= failure;
  }
  return { version: app.getVersion(), platform: process.platform, installation, status, release, ...(error ? { error: friendly(error) } : {}) };
}

function allowed(event) { return event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === page; }
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!allowed(event)) throw new Error('Forbidden sender');
    try { return await callback(...args); } catch (error) { return state(error); }
  });
}

handle('installer:get-state', async () => { await checking; return state(); });
handle('installer:inspect', async value => { if (busy) throw new Error('Дождись завершения операции.'); installation = checkTarget(value); return state(); });
handle('installer:choose-folder', async () => {
  if (busy) throw new Error('Дождись завершения операции.');
  const choice = await dialog.showOpenDialog(window, { title: process.platform === 'darwin' ? 'Выбери Lolka.app' : 'Выбери папку Lolka', defaultPath: installation, properties: ['openDirectory'], ...(process.platform === 'darwin' ? { filters: [{ name: 'Applications', extensions: ['app'] }] } : {}) });
  if (!choice.canceled && choice.filePaths[0]) installation = checkTarget(choice.filePaths[0]);
  return state();
});
handle('installer:action', async request => {
  if (busy) throw new Error('Дождись завершения операции.');
  if (!request || !['install', 'uninstall', 'repair'].includes(request.operation)) throw new Error('Unknown operation');
  const target = checkTarget(request.installation);
  if (target !== installation) throw new Error('Папка клиента изменилась. Повтори проверку.');
  busy = true;
  window.webContents.send('installer:progress', { message: 'Проверка и изменение файлов…' });
  try {
    try { await helper(request.operation, target); }
    catch (error) {
      if (process.platform !== 'linux' || !['EACCES', 'EPERM'].includes(error.code)) throw error;
      await trustedRootTree(path.dirname(process.execPath));
      window.webContents.send('installer:progress', { message: 'Подтверди системный запрос прав.' });
      await helper(request.operation, target, true);
    }
    const result = await state();
    result.status.message = request.operation === 'install' ? 'LolkaMod установлен. Можно запускать Lolka.' : 'Lolka восстановлена. Можно запускать клиент.';
    return result;
  } finally { busy = false; }
});
handle('installer:open-release', async () => {
  await shell.openExternal(release?.url ?? 'https://github.com/Bnmrnzxc/LolkaMod/releases/latest');
});

app.on('before-quit', event => { if (busy) event.preventDefault(); else updater.stop(); });
app.on('window-all-closed', () => { if (!busy) app.quit(); });
app.whenReady().then(async () => {
for (const candidate of defaultPaths) if (await fs.access(candidate).then(() => true, () => false)) { installation = candidate; break; }
checking = updater.check().then(result => { if (result.state === 'available') release = { version: result.latest, url: result.url }; }).catch(() => {});
window = new BrowserWindow({ show: !process.argv.includes('--installer-qa-hidden'), width: 800, height: 660, minWidth: 720, minHeight: 620, backgroundColor: '#202122', title: 'LolkaMod', icon: path.join(here, 'logo.png'),
  webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
window.setMenuBarVisibility(false);
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
window.on('close', event => { if (busy) event.preventDefault(); });
await window.loadFile(path.join(here, 'renderer.html'));
}).catch(error => {
  console.error('Installer startup failed:', error);
  if (!process.argv.includes('--installer-qa-hidden')) dialog.showErrorBox('LolkaMod', friendly(error));
  app.exit(1);
});
