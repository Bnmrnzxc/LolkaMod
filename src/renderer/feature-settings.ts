import { THEMES } from "./theme-manager";
import { DEFAULT_CUSTOM_THEME, normalizeCustomTheme, type CustomTheme } from "../shared/themes";
import { mountCustomThemeEditor } from "./custom-theme-editor";
import type { Settings } from "../shared/settings";
import type { UpdateStatus } from "../shared/updates";
import { SOUND_ACTIONS, type SoundActionId, type SoundThemeStatus } from "../shared/sounds";

export interface FeatureSettingsOptions {
  settings(): Settings;
  save(patch: Partial<Settings>): Promise<void>;
  subscribe(callback: () => void): () => void;
  reset(): Promise<void>;
  checkUpdates(): Promise<UpdateStatus>;
  updateStatus(): UpdateStatus;
  openRelease(): Promise<void>;
  capabilities(): { settings: boolean; controls: boolean };
  soundStatus?(): SoundThemeStatus;
  previewSound?(id: SoundActionId): void;
}

const FEATURE_STYLES = `
  .feature-settings{display:grid;gap:12px;color:var(--color-text-primary,#f4f1ff)}
  .feature-settings label{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px;border:1px solid var(--color-border-primary,#3b394c);border-radius:10px}
  .feature-settings .feature-actions button{font:inherit;color:inherit;background:var(--color-bg-input,#252332);border:1px solid var(--color-border-secondary,#555066);border-radius:8px;padding:8px;cursor:pointer}
  .feature-settings button:disabled{opacity:.55;cursor:wait}
  .feature-settings button:focus-visible{outline:2px solid var(--color-brand-primary,#65b9dc);outline-offset:3px}
  .feature-settings input{accent-color:var(--color-brand-primary,#65b9dc)}
  .feature-settings .feature-actions{display:flex;gap:8px;flex-wrap:wrap}
  .feature-settings .sound-preview select{font:inherit;color:inherit;background:var(--color-bg-input,#252332);border:1px solid var(--color-border-secondary,#555066);border-radius:8px;padding:8px;max-width:100%}
  .feature-settings p{margin:0;color:var(--color-text-secondary,#bdb6cd);font-size:12px}
  .feature-settings .theme-picker{display:grid;gap:10px;min-width:0;padding:12px;border:1px solid var(--color-border-primary,#3b394c);border-radius:10px}
  .feature-settings .theme-heading{margin:0;font:inherit;font-weight:650}
  .feature-settings .theme-swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:10px;padding:4px}
  .feature-settings .theme-swatch{position:relative;display:grid;place-items:center;aspect-ratio:1;min-width:0;min-height:48px;margin:0;padding:0;border:1px solid var(--color-border-secondary,#555066);border-radius:11px;color:var(--color-text-primary,#f4f1ff);font:inherit;cursor:pointer;box-shadow:inset 0 0 0 1px #0000000c}
  .feature-settings .theme-swatch:hover{box-shadow:inset 0 0 0 2px var(--color-text-primary,#f4f1ff)}
  .feature-settings .theme-swatch[aria-checked="true"]{border-color:var(--color-brand-primary,#65b9dc);box-shadow:0 0 0 3px var(--color-brand-primary,#65b9dc)}
  .feature-settings .theme-swatch[data-pending="true"]{outline:2px dashed var(--color-brand-primary,#65b9dc);outline-offset:3px}
  .feature-settings .theme-custom-mark{width:26px;height:26px}
  .feature-settings .theme-native-action{justify-self:start;font:inherit;color:inherit;background:var(--color-bg-input,#252332);border:1px solid var(--color-border-secondary,#555066);border-radius:8px;padding:8px 10px;cursor:pointer}
  .feature-settings .theme-native-action[aria-pressed="true"]{border-color:var(--color-brand-primary,#65b9dc)}
  .feature-settings .theme-check{position:absolute;top:-6px;right:-6px;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--color-brand-primary,#65b9dc);color:var(--color-text-on-brand,#101920);pointer-events:none}
  .feature-settings .theme-check svg{width:15px;height:15px}
  .feature-settings .theme-choice{display:grid;gap:3px;min-height:36px}
  .feature-settings .theme-choice strong{font-size:13px;font-weight:600}
  .feature-settings [hidden]{display:none}
  @media(forced-colors:active){.feature-settings .theme-swatch[aria-checked="true"]{outline:3px solid Highlight}.feature-settings .theme-check{background:Highlight;color:HighlightText}}
`;

export function mountFeatureSettings(container: HTMLElement, options: FeatureSettingsOptions): () => void {
  const doc = container.ownerDocument;
  const events = new AbortController();
  const signal = events.signal;
  const root = doc.createElement("div"); root.className = "feature-settings";
  const style = doc.createElement("style"); style.textContent = FEATURE_STYLES; root.append(style);
  const status = doc.createElement("p"); status.setAttribute("role", "status");
  const checks = new Map<keyof Settings, HTMLInputElement>();
  let stopped = false, resetting = false;
  const saveError = "Не удалось сохранить. Проверь диагностику; при повреждённых настройках доступен сброс.";

  async function save(patch: Partial<Settings>) {
    if (stopped) return;
    status.textContent = "Сохранение…";
    try { await options.save(patch); if (!stopped) status.textContent = "Сохранено"; }
    catch { if (!stopped) status.textContent = saveError; }
    if (!stopped) refresh();
  }
  function toggle(key: "indicatorEnabled" | "indicatorDetailed" | "streamMenuEnabled" | "soundThemeEnabled", text: string) {
    const label = doc.createElement("label"); label.textContent = text;
    const input = doc.createElement("input"); input.type = "checkbox"; input.dataset.setting = key;
    input.addEventListener("change", () => void save({ [key]: input.checked }), { signal });
    checks.set(key, input); label.append(input); root.append(label);
  }
  function svg(className: string, path: string): SVGSVGElement {
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("class", className);
    icon.setAttribute("aria-hidden", "true"); icon.setAttribute("focusable", "false");
    const shape = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path); shape.setAttribute("fill", "currentColor"); shape.setAttribute("fill-rule", "evenodd"); icon.append(shape); return icon;
  }

  const themeSection = doc.createElement("section"); themeSection.className = "theme-picker";
  const heading = doc.createElement("h3"); heading.className = "theme-heading"; heading.textContent = "Цветовые темы";
  const intro = doc.createElement("p"); intro.textContent = "Выбери оформление — оно применится сразу и сохранится после перезапуска.";
  const grid = doc.createElement("div"); grid.className = "theme-swatches";
  grid.setAttribute("role", "radiogroup"); grid.setAttribute("aria-label", "Тема LolkaMod");
  const choice = doc.createElement("div"); choice.className = "theme-choice";
  const choiceTitle = doc.createElement("strong"); const choiceDescription = doc.createElement("p");
  choice.append(choiceTitle, choiceDescription);
  const swatches = new Map<Settings["themeId"], { button: HTMLButtonElement; check: HTMLElement }>();
  const customChoice = { id: "custom" as const, title: "Своя тема", description: "Настрой цвета и насыщенность", group: "base", swatch: "var(--color-bg-tertiary,#252332)" };
  const pickerThemes = [customChoice, ...THEMES.filter(item => item.id !== "native")];
  let focusTheme = options.settings().themeId === "native" ? "custom" as const : options.settings().themeId;
  type ThemeChoice = { themeId: Settings["themeId"]; customTheme?: CustomTheme };
  let queuedTheme: ThemeChoice | undefined;
  let requestedTheme: ThemeChoice | undefined;
  let themeSaving = false;
  let customDraft = normalizeCustomTheme(options.settings().customTheme ?? DEFAULT_CUSTOM_THEME), customDirty = false;
  const sameCustom = (left: CustomTheme, right: CustomTheme) => JSON.stringify(left) === JSON.stringify(right);

  // One request is in flight. Repeated choices replace the next request, rather than
  // allowing an older asynchronous write to finish after the latest choice.
  async function drainThemeChoices() {
    if (themeSaving || stopped) return;
    let attempted = false;
    themeSaving = true;
    refresh();
    while (!stopped && queuedTheme !== undefined) {
      const next = queuedTheme; queuedTheme = undefined;
      const current = options.settings();
      if (next.themeId !== current.themeId || (next.customTheme !== undefined && !sameCustom(next.customTheme, current.customTheme ?? DEFAULT_CUSTOM_THEME))) {
        attempted = true;
        status.textContent = "Сохранение темы…";
        try {
          await options.save(next);
          if (sameCustom(customDraft, options.settings().customTheme ?? DEFAULT_CUSTOM_THEME)) customDirty = false;
          if (!stopped && queuedTheme === undefined) status.textContent = "Тема сохранена";
        } catch {
          if (!stopped && queuedTheme === undefined) status.textContent = saveError;
        }
      } else if (!stopped && queuedTheme === undefined && attempted) status.textContent = "Тема сохранена";
      if (!stopped) refresh();
    }
    themeSaving = false;
    if (!stopped) {
      requestedTheme = undefined; customDirty = false;
      customDraft = normalizeCustomTheme(options.settings().customTheme ?? DEFAULT_CUSTOM_THEME); refresh();
    }
  }
  function chooseTheme(id: Settings["themeId"]) {
    if (stopped || resetting) return;
    focusTheme = id === "native" ? "custom" : id;
    const mutation: ThemeChoice = { themeId: id };
    if (id === "custom" || customDirty) mutation.customTheme = normalizeCustomTheme(customDraft);
    queuedTheme = mutation; requestedTheme = mutation;
    if (id === "custom") editor.open(customDraft); else editor.hide();
    refresh(); void drainThemeChoices();
  }
  for (const item of pickerThemes) {
    const button = doc.createElement("button"); button.type = "button"; button.className = "theme-swatch";
    button.dataset.setting = "themeId"; button.dataset.themeId = item.id; button.dataset.group = item.group;
    button.style.background = item.swatch;
    button.setAttribute("role", "radio"); button.setAttribute("aria-label", item.title);
    button.title = `${item.title} — ${item.description}`;
    if (item.id === "custom") button.append(svg("theme-custom-mark", "M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 1.8-4.23 1.2 1.2 0 0 1 .86-2.02H18a3 3 0 0 0 3-3c0-5-4-8.75-9-8.75ZM7 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5-2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm-12 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"));
    const check = doc.createElement("span"); check.className = "theme-check"; check.setAttribute("aria-hidden", "true");
    check.append(svg("", "m9.1 18-5.6-5.6 1.8-1.8 3.8 3.8 9.6-9.6 1.8 1.8Z")); button.append(check);
    button.addEventListener("click", () => chooseTheme(item.id), { signal });
    button.addEventListener("focus", () => { focusTheme = item.id; refresh(); }, { signal });
    button.addEventListener("keydown", event => {
      const index = pickerThemes.findIndex(theme => theme.id === item.id);
      let target: number;
      switch (event.key) {
        case "ArrowRight": case "ArrowDown": target = (index + 1) % pickerThemes.length; break;
        case "ArrowLeft": case "ArrowUp": target = (index + pickerThemes.length - 1) % pickerThemes.length; break;
        case "Home": target = 0; break;
        case "End": target = pickerThemes.length - 1; break;
        default: return; // Enter and Space retain native button activation.
      }
      event.preventDefault();
      const id = pickerThemes[target]!.id; swatches.get(id)!.button.focus(); chooseTheme(id);
    }, { signal });
    swatches.set(item.id, { button, check }); grid.append(button);
  }
  const nativeTheme = doc.createElement("button"); nativeTheme.type = "button"; nativeTheme.className = "theme-native-action";
  nativeTheme.textContent = "Оформление Lolka"; nativeTheme.title = "Вернуть оформление, выбранное в настройках Lolka";
  nativeTheme.dataset.setting = "themeId"; nativeTheme.dataset.themeId = "native";
  nativeTheme.addEventListener("click", () => chooseTheme("native"), { signal });
  themeSection.append(heading, intro, grid, choice, nativeTheme); root.append(themeSection);
  const editor = mountCustomThemeEditor(themeSection, {
    value: customDraft,
    change(value) {
      if (stopped || resetting) return;
      customDraft = normalizeCustomTheme(value); customDirty = true;
      const mutation: ThemeChoice = { themeId: "custom", customTheme: normalizeCustomTheme(customDraft) };
      focusTheme = "custom"; queuedTheme = mutation; requestedTheme = mutation;
      refresh(); void drainThemeChoices();
    },
    close() { if (!stopped) swatches.get("custom")!.button.focus(); },
  });
  toggle("indicatorEnabled", "Индикатор качества видео");
  toggle("indicatorDetailed", "Подробные метрики");
  toggle("streamMenuEnabled", "Меню кнопки стрима");
  const soundStatus = doc.createElement("p"); soundStatus.dataset.soundStatus = "";
  soundStatus.setAttribute("role", "status"); soundStatus.setAttribute("aria-live", "polite");
  const soundPreview = doc.createElement("div"); soundPreview.className = "feature-actions sound-preview";
  const soundChoice = doc.createElement("select"); soundChoice.setAttribute("aria-label", "Звук для прослушивания");
  for (const action of SOUND_ACTIONS) {
    const option = doc.createElement("option"); option.value = action.id; option.textContent = action.title; soundChoice.append(option);
  }
  soundChoice.value = "messageSound";
  const listen = doc.createElement("button"); listen.type = "button"; listen.textContent = "Прослушать";
  listen.dataset.soundPreview = "";
  listen.addEventListener("click", () => {
    try { options.previewSound?.(soundChoice.value as SoundActionId); }
    catch { soundStatus.textContent = "Не удалось воспроизвести звук."; }
  }, { signal });
  soundPreview.append(soundChoice, listen);
  if (options.soundStatus && options.previewSound) { toggle("soundThemeEnabled", "Звуки Discord"); root.append(soundStatus, soundPreview); }
  const support = doc.createElement("p"); root.append(support);
  const actions = doc.createElement("div"); actions.className = "feature-actions";
  function button(text: string, action: () => void) {
    const element = doc.createElement("button"); element.type = "button"; element.textContent = text;
    element.addEventListener("click", action, { signal }); actions.append(element); return element;
  }
  const update = button("Проверить обновления", () => {
    update.disabled = true; status.textContent = "Проверка…";
    void options.checkUpdates().then(showUpdate, () => {
      if (!stopped) status.textContent = "Не удалось проверить обновления. Попробуй позже.";
    }).finally(() => { if (!stopped) update.disabled = false; });
  });
  button("Открыть релиз", () => { void options.openRelease().catch(() => { if (!stopped) status.textContent = "Не удалось открыть ссылку на релиз."; }); });
  const resetConfirm = doc.createElement("div"); resetConfirm.className = "feature-actions"; resetConfirm.hidden = true;
  const warning = doc.createElement("p"); warning.textContent = "Сбросить настройки мода? Текущий файл будет сохранён в резервной копии.";
  const confirm = doc.createElement("button"); confirm.type = "button"; confirm.textContent = "Сбросить";
  const cancel = doc.createElement("button"); cancel.type = "button"; cancel.textContent = "Отмена";
  confirm.addEventListener("click", () => {
    if (themeSaving || resetting) return;
    resetting = true; refresh();
    void options.reset().then(() => {
      if (!stopped) {
        customDirty = false; customDraft = normalizeCustomTheme(options.settings().customTheme ?? DEFAULT_CUSTOM_THEME); editor.hide();
        resetConfirm.hidden = true; status.textContent = "Настройки сброшены; резервная копия сохранена."; refresh();
      }
    }, () => { if (!stopped) status.textContent = "Не удалось сбросить настройки."; }).finally(() => {
      resetting = false; if (!stopped) refresh();
    });
  }, { signal });
  cancel.addEventListener("click", () => { resetConfirm.hidden = true; }, { signal });
  resetConfirm.append(warning, confirm, cancel);
  button("Сбросить настройки", () => { resetConfirm.hidden = false; });
  root.append(actions, resetConfirm, status);

  function showUpdate(value: UpdateStatus) {
    if (stopped) return;
    status.textContent = value.state === "available" ? `Доступна версия ${value.latest}. Открой релиз и установи обновление при закрытой Lolka.`
      : value.state === "current" ? `Установлена актуальная версия ${value.installed}.`
      : value.state === "ahead" ? `Установленная версия ${value.installed} новее публичного релиза.`
      : value.state === "checking" ? "Проверка…" : value.message ?? "Нажми «Проверить обновления».";
  }
  function refresh() {
    if (stopped) return;
    const settings = options.settings();
    const selected = settings.themeId === "custom" ? customChoice : THEMES.find(item => item.id === settings.themeId) ?? THEMES[0]!;
    if (!themeSaving && requestedTheme === undefined && ![...swatches.values()].some(item => {
      const focusRoot = item.button.getRootNode?.() as Document | ShadowRoot | undefined;
      return item.button === (focusRoot?.activeElement ?? doc.activeElement);
    })) focusTheme = selected.id === "native" ? "custom" : selected.id;
    for (const [id, item] of swatches) {
      const checked = id === selected.id;
      item.button.setAttribute("aria-checked", String(checked)); item.check.hidden = !checked;
      item.button.tabIndex = id === focusTheme ? 0 : -1;
      item.button.setAttribute("data-pending", String(id === requestedTheme?.themeId && !checked));
      item.button.disabled = resetting;
    }
    grid.setAttribute("aria-busy", String(themeSaving || requestedTheme !== undefined));
    nativeTheme.setAttribute("aria-pressed", String(selected.id === "native")); nativeTheme.disabled = resetting;
    nativeTheme.setAttribute("data-pending", String(requestedTheme?.themeId === "native" && selected.id !== "native"));
    if (!customDirty && requestedTheme === undefined && !themeSaving) customDraft = normalizeCustomTheme(settings.customTheme ?? DEFAULT_CUSTOM_THEME);
    editor.update(customDraft); editor.disabled(resetting);
    choiceTitle.textContent = selected.title; choiceDescription.textContent = selected.description;
    confirm.disabled = themeSaving || resetting;
    for (const [key, input] of checks) input.checked = Boolean(settings[key]);
    const soundModel = options.soundStatus?.();
    if (soundModel) {
      soundStatus.textContent = soundModel.message;
      const soundToggle = checks.get("soundThemeEnabled");
      if (soundToggle) soundToggle.disabled = resetting || !soundModel.available;
      soundChoice.disabled = listen.disabled = resetting || soundModel.state !== "active";
    }
    const capability = options.capabilities();
    support.textContent = `Встроенные настройки: ${capability.settings ? "доступны" : "резервная панель"}. Меню стрима: ${capability.controls ? "доступно" : "не поддержано этой сборкой"}.`;
  }
  container.append(root); refresh(); showUpdate(options.updateStatus());
  const unsubscribe = options.subscribe(refresh);
  return () => {
    if (stopped) return;
    stopped = true; queuedTheme = undefined; requestedTheme = undefined;
    events.abort(); editor.dispose(); unsubscribe(); root.remove();
  };
}
