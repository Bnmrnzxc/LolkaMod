import { mountStreamControls, type StreamControlsOptions } from "./stream-panel";
import { mountFeatureSettings, type FeatureSettingsOptions } from "./feature-settings";
import { createBrandMark } from "../shared/brand";
export type PanelSettings = {
  enabled: boolean;
  customCss: string;
};

export type PanelOptions = {
  version: string;
  settings: PanelSettings;
  onChange: (patch: { enabled?: boolean; customCss?: string }) => void | Promise<void>;
  diagnostics: () => unknown;
  onClose?: () => void;
  streams?: StreamControlsOptions;
  showLauncher?: boolean;
  container?: HTMLElement;
  features?: FeatureSettingsOptions;
};

const HOST_ID = "lolkamod-panel";
const OWNER_ATTRIBUTE = "data-lolkamod-panel-owner";
let activeDisposer: (() => void) | undefined;

const PANEL_STYLES = `
  :host {
    all: initial;
    color-scheme: var(--lolkamod-color-scheme, dark);
    font-family: Inter, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.45;
  }
  *, *::before, *::after { box-sizing: border-box; }
  .layer {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    pointer-events: none;
  }
  button, textarea, input { font: inherit; }
  button { color: inherit; }
  button:focus-visible, textarea:focus-visible, input:focus-visible + .switch-track {
    outline: 2px solid var(--color-brand-primary, #65b9dc);
    outline-offset: 3px;
  }
  .launcher {
    position: fixed;
    right: 18px;
    bottom: 18px;
    width: 46px;
    height: 46px;
    border: 1px solid var(--color-border-primary, #46464e);
    border-radius: 15px;
    background: var(--color-bg-tertiary, #2c2c30);
    box-shadow: 0 8px 26px #0008;
    color: var(--color-text-primary, #fff);
    font-weight: 800;
    letter-spacing: .03em;
    cursor: pointer;
    pointer-events: auto;
  }
  .panel {
    position: fixed;
    right: 18px;
    bottom: 76px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(420px, calc(100vw - 28px));
    max-height: calc(100vh - 104px);
    overflow: auto;
    padding: 20px;
    border: 1px solid var(--color-border-primary, #343247);
    border-radius: 18px;
    background: var(--color-bg-primary, #171622);
    box-shadow: 0 18px 60px #000b;
    color: var(--color-text-primary, #f4f1ff);
    pointer-events: auto;
  }
  .panel[hidden], .diagnostics[hidden] { display: none; }
  .header, .title-row, .actions { display: flex; align-items: center; }
  .header { justify-content: space-between; gap: 12px; }
  .title-row { gap: 11px; }
  .brand {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    color: var(--color-text-primary, #f5f0ff);
    flex: 0 0 auto;
  }
  .brand svg, .launcher svg { display: block; }
  .launcher { display: grid; place-items: center; }
  .launcher[hidden] { display: none; }
  h1 { margin: 0; font-size: 16px; font-weight: 700; }
  .version { margin-top: 2px; color: var(--color-text-secondary, #9d99ae); font-size: 12px; }
  .close, .secondary, .primary {
    min-height: 36px;
    border: 1px solid var(--color-border-button, #3b394c);
    border-radius: 10px;
    background: var(--color-bg-button-secondary, #211f2d);
    cursor: pointer;
  }
  .close { width: 36px; font-size: 20px; color: var(--color-text-secondary, #c8c4d5); }
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 13px 14px;
    border: 1px solid var(--color-border-primary, #302e40);
    border-radius: 12px;
    background: var(--color-bg-secondary, #1d1b29);
  }
  .setting-copy strong { display: block; font-size: 13px; }
  .setting-copy span { display: block; margin-top: 3px; color: var(--color-text-secondary, #a09caf); font-size: 12px; }
  .switch { position: relative; display: inline-flex; flex: 0 0 auto; cursor: pointer; }
  .switch input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    opacity: 0;
  }
  .switch-track {
    width: 42px;
    height: 24px;
    padding: 3px;
    border-radius: 99px;
    background: var(--color-border-secondary, #484554);
    transition: background .15s ease;
  }
  .switch-track::after {
    display: block;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--color-text-primary, #f7f5ff);
    content: "";
    transition: transform .15s ease;
  }
  .switch input:checked + .switch-track { background: var(--color-brand-primary, #65b9dc); }
  .switch input:checked + .switch-track::after { transform: translateX(18px); background: var(--color-text-on-brand, #f7f5ff); }
  .editor-label { display: block; margin-bottom: 7px; font-weight: 600; }
  textarea {
    display: block;
    width: 100%;
    min-height: 164px;
    resize: vertical;
    padding: 12px;
    border: 1px solid var(--color-border-primary, #38364b);
    border-radius: 12px;
    background: var(--color-bg-input, #100f18);
    color: var(--color-text-primary, #e8e3f4);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    tab-size: 2;
  }
  .hint { margin: 7px 0 0; color: var(--color-text-secondary, #918da1); font-size: 11px; }
  .actions { gap: 9px; flex-wrap: wrap; }
  .primary, .secondary { padding: 0 13px; }
  .primary { border-color: var(--color-brand-primary, #65b9dc); background: var(--color-brand-primary, #65b9dc); color: var(--color-text-on-brand, #172027); font-weight: 650; }
  .secondary { color: var(--color-text-normal, #ded9eb); }
  .primary:hover { background: var(--color-brand-primary-hover, #82c9e7); }
  .secondary:hover, .close:hover { background: var(--color-bg-hover, #2c293a); }
  .diagnostics {
    max-height: 200px;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--color-border-primary, #302e40);
    border-radius: 10px;
    background: var(--color-bg-input, #100f18);
    color: var(--color-text-normal, #c4b5fd);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  @media (max-width: 480px) {
    .launcher { right: 14px; bottom: 14px; }
    .panel { right: 14px; bottom: 70px; width: calc(100vw - 28px); padding: 16px; }
  }
`;

function makeElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

export function mountPanel(options: PanelOptions): () => void {
  const document = globalThis.document;
  if (!options.container) activeDisposer?.();
  const previous = options.container ? null : document.getElementById(HOST_ID);
  if (previous?.getAttribute(OWNER_ATTRIBUTE) === "true") previous.remove();

  const host = makeElement(document, "div");
  host.id = options.container ? "lolkamod-embedded-settings" : HOST_ID;
  host.setAttribute(OWNER_ATTRIBUTE, "true");
  const shadow = host.attachShadow({ mode: "open" });

  const style = makeElement(document, "style");
  style.textContent = PANEL_STYLES;
  if(options.container) style.textContent += `.layer,.panel{position:static;width:100%;max-height:none;pointer-events:auto}.layer{display:block}.panel{box-shadow:none;background:transparent;padding:8px;border:0}.close,.launcher{display:none}`;
  const layer = makeElement(document, "div", "layer");

  const launcher = makeElement(document, "button", "launcher");
  launcher.type = "button";
  launcher.append(createBrandMark(document, "regular", 34));
  launcher.title = "Открыть панель LolkaMod (Ctrl+Shift+M)";
  launcher.setAttribute("aria-label", "Открыть панель LolkaMod");
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "lolkamod-settings");
  launcher.hidden = options.showLauncher === false;

  const panel = makeElement(document, "section", "panel");
  panel.id = "lolkamod-settings";
  panel.setAttribute("aria-label", "Настройки LolkaMod");
  panel.hidden = !options.container;

  const header = makeElement(document, "header", "header");
  const titleRow = makeElement(document, "div", "title-row");
  const brand = makeElement(document, "div", "brand");
  brand.setAttribute("aria-hidden", "true");
  brand.append(createBrandMark(document));
  const headingGroup = makeElement(document, "div");
  const heading = makeElement(document, "h1");
  heading.textContent = "LolkaMod";
  const version = makeElement(document, "div", "version");
  version.textContent = `Версия ${options.version}`;
  headingGroup.append(heading, version);
  titleRow.append(brand, headingGroup);

  const closeButton = makeElement(document, "button", "close");
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Закрыть панель (Ctrl+Shift+M или Escape)";
  closeButton.setAttribute("aria-label", "Закрыть панель LolkaMod");
  header.append(titleRow, closeButton);

  const settingRow = makeElement(document, "div", "setting-row");
  const settingCopy = makeElement(document, "div", "setting-copy");
  const settingTitle = makeElement(document, "strong");
  settingTitle.textContent = "Пользовательский CSS";
  const settingDescription = makeElement(document, "span");
  settingDescription.textContent = "Применять ваши стили в клиенте";
  settingCopy.append(settingTitle, settingDescription);
  const switchLabel = makeElement(document, "label", "switch");
  const enabledInput = makeElement(document, "input");
  enabledInput.type = "checkbox";
  enabledInput.checked = options.settings.enabled;
  enabledInput.setAttribute("aria-label", "Включить пользовательский CSS");
  const switchTrack = makeElement(document, "span", "switch-track");
  switchTrack.setAttribute("aria-hidden", "true");
  switchLabel.append(enabledInput, switchTrack);
  settingRow.append(settingCopy, switchLabel);

  const editorGroup = makeElement(document, "div");
  const editorLabel = makeElement(document, "label", "editor-label");
  editorLabel.htmlFor = "lolkamod-css-editor";
  editorLabel.textContent = "Редактор CSS";
  const editor = makeElement(document, "textarea");
  editor.id = "lolkamod-css-editor";
  editor.spellcheck = false;
  editor.value = options.settings.customCss;
  editor.setAttribute("aria-describedby", "lolkamod-css-hint");
  const hint = makeElement(document, "p", "hint");
  hint.id = "lolkamod-css-hint";
  hint.textContent = "CSS применяется после сохранения. Темы сохраняются автоматически. Обновление мода устанавливается при закрытой Lolka.";
  editorGroup.append(editorLabel, editor, hint);

  const actions = makeElement(document, "div", "actions");
  const saveStatus = makeElement(document, "p", "hint");
  saveStatus.setAttribute("role", "status");
  const saveButton = makeElement(document, "button", "primary");
  saveButton.type = "button";
  saveButton.textContent = "Сохранить CSS";
  saveButton.title = "Сохранить пользовательский CSS";
  saveButton.setAttribute("aria-label", "Сохранить пользовательский CSS");
  const diagnosticsButton = makeElement(document, "button", "secondary");
  diagnosticsButton.type = "button";
  diagnosticsButton.textContent = "Диагностика";
  diagnosticsButton.title = "Показать техническую диагностику";
  diagnosticsButton.setAttribute("aria-label", "Показать техническую диагностику");
  actions.append(saveButton, diagnosticsButton);

  const diagnosticsOutput = makeElement(document, "pre", "diagnostics");
  diagnosticsOutput.hidden = true;
  diagnosticsOutput.setAttribute("aria-label", "Результат диагностики");
  diagnosticsOutput.setAttribute("aria-live", "polite");

  panel.append(header, settingRow, editorGroup, actions, saveStatus, diagnosticsOutput);
  const featureContainer=makeElement(document,"div");
  settingRow.before(featureContainer);
  const featureDispose=options.features?mountFeatureSettings(featureContainer,options.features):undefined;
  const streamContainer = makeElement(document, "div");
  panel.append(streamContainer);
  const streamDispose = options.streams ? mountStreamControls(streamContainer, options.streams) : undefined;
  layer.append(panel, launcher);
  shadow.append(style, layer);

  const events = new AbortController();
  const eventOptions = { signal: events.signal };
  let disposed = false;
  const settingsUnsubscribe=options.features?.subscribe(()=>{
    const next=options.features!.settings();
    enabledInput.checked=next.enabled;
    if(shadow.activeElement!==editor) editor.value=next.customCss;
  });

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
  };
  const close = () => {
    if (panel.hidden) return;
    setOpen(false);
    options.onClose?.();
  };

  launcher.addEventListener("click", () => {
    if (panel.hidden) setOpen(true);
    else close();
  }, eventOptions);
  closeButton.addEventListener("click", close, eventOptions);
  const persist = async (patch: { enabled?: boolean; customCss?: string }) => {
    saveStatus.textContent = "Сохранение…";
    try { await options.onChange(patch); saveStatus.textContent = "Сохранено"; }
    catch { saveStatus.textContent = "Не удалось сохранить. Изменения не применены."; }
  };
  enabledInput.addEventListener(
    "change",
    () => { void persist({ enabled: enabledInput.checked }); },
    eventOptions,
  );
  saveButton.addEventListener(
    "click",
    () => { void persist({ customCss: editor.value }); },
    eventOptions,
  );
  diagnosticsButton.addEventListener("click", () => {
    try {
      const result = JSON.stringify(options.diagnostics(), null, 2);
      diagnosticsOutput.textContent = result === undefined ? "undefined" : result;
    } catch (error) {
      diagnosticsOutput.textContent = `Не удалось получить диагностику: ${
        error instanceof Error ? error.message : "неизвестная ошибка"
      }`;
    }
    diagnosticsOutput.hidden = false;
  }, eventOptions);
  document.addEventListener("keydown", (event) => {
    if(options.container)return;
    if (event.key === "Escape") {
      close();
      return;
    }
    const isPanelShortcut = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "m";
    if (!isPanelShortcut) return;
    event.preventDefault();
    if (panel.hidden) setOpen(true);
    else close();
  }, eventOptions);

  (options.container ?? document.body).append(host);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    streamDispose?.();
    featureDispose?.();
    settingsUnsubscribe?.();
    host.remove();
    if (activeDisposer === dispose) activeDisposer = undefined;
  };
  if(!options.container) activeDisposer = dispose;
  return dispose;
}
