import { THEMES } from "./theme-manager";
import type { Settings } from "../shared/settings";
import type { UpdateStatus } from "../shared/updates";

export interface FeatureSettingsOptions {
  settings(): Settings;
  save(patch: Partial<Settings>): Promise<void>;
  subscribe(callback: () => void): () => void;
  reset(): Promise<void>;
  checkUpdates(): Promise<UpdateStatus>;
  updateStatus(): UpdateStatus;
  openRelease(): Promise<void>;
  capabilities(): { settings: boolean; controls: boolean };
}

export function mountFeatureSettings(container: HTMLElement, options: FeatureSettingsOptions): () => void {
  const doc = container.ownerDocument;
  const events = new AbortController();
  const signal = events.signal;
  const root = doc.createElement("div"); root.className = "feature-settings";
  const style = doc.createElement("style");
  style.textContent = `.feature-settings{display:grid;gap:12px}.feature-settings label{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px;border:1px solid var(--color-border-primary,#3b394c);border-radius:10px}.feature-settings select,.feature-settings button{font:inherit;color:inherit;background:var(--color-bg-input,#252332);border:1px solid var(--color-border-secondary,#555066);border-radius:8px;padding:8px;cursor:pointer}.feature-settings input{accent-color:var(--color-brand-primary,#65b9dc)}.feature-settings .feature-actions{display:flex;gap:8px;flex-wrap:wrap}.feature-settings p{margin:0;color:var(--color-text-secondary,#bdb6cd);font-size:12px}.feature-settings [hidden]{display:none}`;
  root.append(style);
  const status = doc.createElement("p"); status.setAttribute("role", "status");
  const checks = new Map<keyof Settings, HTMLInputElement>();
  let stopped = false;
  async function save(patch: Partial<Settings>) {
    status.textContent = "Сохранение…";
    try { await options.save(patch); if (!stopped) status.textContent = "Сохранено"; }
    catch { if (!stopped) status.textContent = "Не удалось сохранить. Проверь диагностику; при повреждённых настройках доступен сброс."; }
    if (!stopped) refresh();
  }
  function toggle(key: "indicatorEnabled"|"indicatorDetailed"|"streamMenuEnabled", text: string) {
    const label = doc.createElement("label"); label.textContent = text;
    const input = doc.createElement("input"); input.type = "checkbox"; input.dataset.setting = key;
    input.addEventListener("change", () => void save({[key]:input.checked}), {signal});
    checks.set(key,input); label.append(input); root.append(label);
  }
  const themeLabel = doc.createElement("label"); themeLabel.textContent = "Тема";
  const theme = doc.createElement("select"); theme.dataset.setting = "themeId"; theme.setAttribute("aria-label","Тема LolkaMod");
  for (const item of THEMES) { const option=doc.createElement("option"); option.value=item.id; option.textContent=item.title; theme.append(option); }
  theme.addEventListener("change",()=>void save({themeId:theme.value as Settings["themeId"]}),{signal});
  themeLabel.append(theme); root.append(themeLabel);
  toggle("indicatorEnabled","Индикатор качества видео");
  toggle("indicatorDetailed","Подробные метрики");
  toggle("streamMenuEnabled","Меню кнопки стрима");
  const support = doc.createElement("p"); root.append(support);
  const actions = doc.createElement("div"); actions.className="feature-actions";
  function button(text:string, action:()=>void) { const b=doc.createElement("button"); b.type="button"; b.textContent=text; b.addEventListener("click",action,{signal});actions.append(b); return b; }
  const update = button("Проверить обновления",()=>{
    update.disabled=true; status.textContent="Проверка…";
    void options.checkUpdates().then(showUpdate,()=>{status.textContent="Не удалось проверить обновления. Попробуй позже.";}).finally(()=>{if(!stopped)update.disabled=false;});
  });
  button("Открыть релиз",()=>{void options.openRelease().catch(()=>{status.textContent="Не удалось открыть ссылку на релиз.";});});
  const resetConfirm = doc.createElement("div"); resetConfirm.className="feature-actions"; resetConfirm.hidden=true;
  const warning = doc.createElement("p"); warning.textContent="Сбросить настройки мода? Текущий файл будет сохранён в резервной копии.";
  const confirm=doc.createElement("button");confirm.type="button";confirm.textContent="Сбросить";
  const cancel=doc.createElement("button");cancel.type="button";cancel.textContent="Отмена";
  confirm.addEventListener("click",()=>{
    confirm.disabled=true;
    void options.reset().then(()=>{if(!stopped){resetConfirm.hidden=true;status.textContent="Настройки сброшены; резервная копия сохранена.";refresh();}},()=>{status.textContent="Не удалось сбросить настройки.";}).finally(()=>{confirm.disabled=false;});
  },{signal});
  cancel.addEventListener("click",()=>{resetConfirm.hidden=true;},{signal});
  resetConfirm.append(warning,confirm,cancel);
  button("Сбросить настройки",()=>{resetConfirm.hidden=false;});
  root.append(actions,resetConfirm,status);
  function showUpdate(value:UpdateStatus) {
    if(stopped)return;
    status.textContent = value.state === "available" ? `Доступна версия ${value.latest}. Открой релиз и установи обновление при закрытой Lolka.`
      :value.state === "current" ? `Установлена актуальная версия ${value.installed}.`
      :value.state === "ahead" ? `Установленная версия ${value.installed} новее публичного релиза.`
      :value.state === "checking" ? "Проверка…" :value.message ?? "Нажми «Проверить обновления».";
  }
  function refresh() {
    const settings=options.settings();theme.value=settings.themeId;
    for(const [key,input] of checks) input.checked=Boolean(settings[key]);
    const capability=options.capabilities();
    support.textContent = `Встроенные настройки: ${capability.settings?"доступны":"резервная панель"}. Меню стрима: ${capability.controls?"доступно":"не поддержано этой сборкой"}.`;
  }
  container.append(root);refresh();showUpdate(options.updateStatus());
  const unsubscribe=options.subscribe(refresh);
  return ()=>{stopped=true;events.abort();unsubscribe();root.remove();};
}
