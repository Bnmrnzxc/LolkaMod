const isRenderer = typeof window !== 'undefined' && typeof document !== 'undefined';
const api = isRenderer ? window.installer : null;

const elements = isRenderer ? {
  version: document.querySelector('#installer-version'),
  platform: document.querySelector('#platform-badge'),
  installation: document.querySelector('#installation-path'),
  folderHint: document.querySelector('#folder-hint'),
  browse: document.querySelector('#browse-button'),
  install: document.querySelector('#install-button'),
  uninstall: document.querySelector('#uninstall-button'),
  repair: document.querySelector('#repair-button'),
  check: document.querySelector('#check-button'),
  clientValue: document.querySelector('#client-value'),
  clientDetail: document.querySelector('#client-detail'),
  modStatusValue: document.querySelector('#mod-status-value'),
  modStatusDetail: document.querySelector('#mod-status-detail'),
  modVersionValue: document.querySelector('#mod-version-value'),
  modVersionDetail: document.querySelector('#mod-version-detail'),
  inlineStatus: document.querySelector('#inline-status'),
  statusMessage: document.querySelector('#status-message'),
  details: document.querySelector('#details-content'),
  dialog: document.querySelector('#update-dialog'),
  dialogDescription: document.querySelector('#update-description'),
  updateInstalledLabel: document.querySelector('#update-installed-label'),
  updateInstalled: document.querySelector('#update-installed'),
  updateTarget: document.querySelector('#update-target'),
  remoteNote: document.querySelector('#remote-update-note'),
  skipUpdate: document.querySelector('#skip-update-button'),
  applyUpdate: document.querySelector('#apply-update-button'),
} : {};

let currentState = null;
let busy = false;
let lastUpdateOffer = null;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
    label: value.trim(),
  };
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (!left.prerelease.length && !right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

/** Pure update decision for the installer contract: local bundle vs installed mod, stable release vs installer. */
export function getUpdateOffer(state) {
  if (!state || typeof state.version !== 'string') return null;
  const installerVersion = state.version;
  const installedVersion = state.status?.modVersion;
  const localAvailable = typeof installedVersion === 'string'
    && compareVersions(installerVersion, installedVersion) === 1;
  const remoteVersion = state.release?.version;
  const remoteAvailable = typeof remoteVersion === 'string'
    && compareVersions(remoteVersion, installerVersion) === 1;
  if (!localAvailable && !remoteAvailable) return null;
  return {
    installerVersion,
    installedVersion: installedVersion || (state.status?.installed ? 'Версия неизвестна' : 'Не установлен'),
    localAvailable,
    remoteAvailable,
    remoteVersion: remoteAvailable ? remoteVersion : null,
    targetVersion: localAvailable ? installerVersion : remoteVersion,
    primaryOperation: localAvailable ? 'install' : 'release',
  };
}

function setStatus(message, tone = 'normal') {
  elements.statusMessage.textContent = message || 'Готово';
  elements.inlineStatus.dataset.tone = tone;
}

function setCardValue(element, value, tone) {
  element.textContent = value;
  if (tone) element.dataset.tone = tone;
  else delete element.dataset.tone;
}

function formatPlatform(platform) {
  const labels = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return labels[platform] || platform || '';
}

function formatDetails(state) {
  const lines = [
    `Платформа: ${formatPlatform(state.platform) || 'неизвестна'}`,
    `Установщик: ${state.version || 'неизвестно'}`,
    `Папка клиента: ${state.installation || 'не выбрана'}`,
    `Клиент найден: ${state.status?.found ? 'да' : 'нет'}`,
    `Версия клиента: ${state.status?.hostVersion || 'не определена'}`,
    `Версия мода: ${state.status?.modVersion || 'не установлен'}`,
    `Stable release: ${state.release?.version || 'нет данных'}`,
  ];
  if (state.error) lines.push(`Ошибка: ${state.error}`);
  if (state.status?.message) lines.push(`Сообщение: ${state.status.message}`);
  return lines.join('\n');
}

function render(state, { preserveFolder = false } = {}) {
  if (!state || typeof state !== 'object') {
    setStatus('Установщик вернул пустой ответ.', 'error');
    return;
  }
  currentState = state;
  if (typeof state.version === 'string') elements.version.textContent = `v${state.version}`;
  elements.platform.textContent = formatPlatform(state.platform);
  if (!preserveFolder && typeof state.installation === 'string') {
    elements.installation.value = state.installation;
  }
  const selected = Boolean(elements.installation.value.trim());
  const status = state.status || {};
  setCardValue(elements.clientValue, status.found ? 'Найден' : selected ? 'Не найден' : 'Не выбран', status.found ? 'success' : null);
  elements.clientDetail.textContent = status.hostVersion ? `Версия ${status.hostVersion}` : 'Папка приложения';
  setCardValue(elements.modStatusValue, status.installed ? 'Установлен' : 'Не установлен', status.installed ? 'success' : null);
  elements.modStatusDetail.textContent = status.message || (status.found ? 'Готов к установке' : 'Ожидает выбора клиента');
  setCardValue(elements.modVersionValue, status.modVersion || (status.installed ? 'Неизвестна' : '—'));
  elements.modVersionDetail.textContent = status.installed
    ? status.modVersion ? 'Установленная версия' : 'Можно восстановить клиент'
    : `Поставляемая v${state.version || '—'}`;
  elements.folderHint.textContent = status.found ? 'Путь найден' : 'Выберите установленный клиент';
  elements.install.disabled = busy || !status.found;
  elements.uninstall.disabled = busy || !status.installed;
  elements.repair.disabled = busy || !status.found;
  elements.browse.disabled = busy;
  elements.check.disabled = busy;
  elements.details.textContent = formatDetails(state);
  if (state.error) setStatus(state.error, 'error');
  else if (status.message) setStatus(status.message, status.installed ? 'success' : 'normal');
  else setStatus(status.found ? 'Клиент найден. Можно продолжить.' : 'Выберите папку установленного клиента.', status.found ? 'success' : 'normal');
}

function makeUpdateOffer(state) {
  const offer = getUpdateOffer(state);
  if (!offer) return null;
  const remoteIsHigher = offer.remoteAvailable
    && compareVersions(offer.remoteVersion, offer.targetVersion) === 1;
  if (remoteIsHigher) {
    offer.targetVersion = offer.remoteVersion;
    offer.primaryOperation = 'release';
  }
  return offer;
}

function showUpdateDialog(state) {
  const offer = makeUpdateOffer(state);
  if (!offer || elements.dialog.open) return false;
  lastUpdateOffer = offer;
  const remoteUpdate = offer.primaryOperation === 'release';
  elements.updateInstalledLabel.textContent = remoteUpdate ? 'Текущий установщик' : 'Установленная версия';
  elements.updateInstalled.textContent = offer.installedVersion;
  elements.updateTarget.textContent = offer.targetVersion;
  elements.remoteNote.hidden = !remoteUpdate;
  elements.dialogDescription.textContent = remoteUpdate
    ? `Сейчас установлен установщик v${offer.installerVersion}. Доступен новый stable-релиз v${offer.targetVersion}.`
    : 'В комплекте есть версия мода новее установленной. Обновление начнётся только после нажатия кнопки.';
  elements.applyUpdate.textContent = 'Обновить';
  elements.dialog.showModal();
  elements.skipUpdate.focus();
  return true;
}

function setBusy(value) {
  busy = value;
  if (currentState) render(currentState, { preserveFolder: true });
}

async function refresh({ showOffer = false } = {}) {
  if (busy) return;
  setBusy(true);
  setStatus('Проверяем установку…', 'busy');
  try {
    const state = await api.getState();
    render(state);
    if (showOffer || !lastUpdateOffer) showUpdateDialog(state);
  } catch (error) {
    setStatus(`Не удалось проверить установку: ${errorMessage(error)}`, 'error');
    elements.details.textContent = errorMessage(error);
  } finally {
    setBusy(false);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'неизвестная ошибка');
}

async function runAction(operation, installation = elements.installation.value.trim()) {
  if (busy) return;
  if (!installation) {
    setStatus('Сначала выберите папку Lolka.', 'error');
    return;
  }
  setBusy(true);
  setStatus(operation === 'install' ? 'Устанавливаем мод…' : operation === 'uninstall' ? 'Удаляем мод…' : 'Восстанавливаем клиент…', 'busy');
  try {
    render(await api.action({ operation, installation }));
  } catch (error) {
    setStatus(`Операция не выполнена: ${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function browse() {
  if (busy) return;
  setBusy(true);
  try {
    const state = await api.chooseFolder();
    // Native pickers often return the current state when canceled. Keep the visible path unchanged if no new path was selected.
    if (state && typeof state.installation === 'string' && state.installation.trim()) render(state);
    else if (state && state.installation === elements.installation.value) render(state);
  } catch (error) {
    setStatus(`Не удалось выбрать папку: ${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function inspect() {
  if (busy) return;
  const installation = elements.installation.value.trim();
  if (!installation) {
    setStatus('Сначала выберите папку Lolka.', 'error');
    return;
  }
  setBusy(true);
  setStatus('Проверяем выбранную папку…', 'busy');
  try {
    render(await api.inspect(installation));
  } catch (error) {
    setStatus(`Не удалось проверить папку: ${errorMessage(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}

if (isRenderer) {
  elements.browse.addEventListener('click', browse);
  elements.install.addEventListener('click', () => runAction('install'));
  elements.uninstall.addEventListener('click', () => runAction('uninstall'));
  elements.repair.addEventListener('click', () => runAction('repair'));
  elements.check.addEventListener('click', () => refresh({ showOffer: true }));
  elements.installation.addEventListener('change', inspect);
  elements.installation.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') inspect();
  });
  elements.skipUpdate.addEventListener('click', () => elements.dialog.close('skip'));
  elements.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    elements.dialog.close('escape');
  });
  elements.dialog.addEventListener('close', () => elements.check.focus());
  elements.applyUpdate.addEventListener('click', async () => {
    const offer = lastUpdateOffer;
    elements.dialog.close('apply');
    if (!offer) return;
    if (offer.primaryOperation === 'install') await runAction('install');
    else {
      try {
        await api.openRelease();
        setStatus('Страница релиза открыта. Скачивание выполняется только после вашего выбора на GitHub.', 'normal');
      } catch (error) {
        setStatus(`Не удалось открыть страницу релиза: ${errorMessage(error)}`, 'error');
      }
    }
  });

  if (api && typeof api.onProgress === 'function') {
    api.onProgress((progress) => {
      if (typeof progress === 'string') setStatus(progress, 'busy');
      else if (progress && typeof progress.message === 'string') setStatus(progress.message, 'busy');
    });
  }

  if (!api) {
    setStatus('Не подключён безопасный интерфейс установщика.', 'error');
    elements.details.textContent = 'window.installer не предоставлен preload.';
  } else {
    void refresh();
  }
}
