import type { StreamCapabilities, StreamProfile } from "../shared/streams.js";

export interface StreamControlsOptions {
  profile: StreamProfile;
  qualityEnabled: boolean;
  onChange: (patch: { qualityEnabled?: boolean; profile?: StreamProfile }) => Promise<void>;
  snapshot: () => unknown;
  sample: () => Promise<void>;
  nativeCapabilities: () => StreamCapabilities | undefined;
}

const RESOLUTIONS = ["480p", "720p", "1080p", "1440p"] as const;
const FRAME_RATES = [15, 30, 60] as const;
const CODECS = ["auto", "VP8", "VP9", "H264", "AV1"] as const;
const REFRESH_INTERVAL_MS = 2_000;
const MAX_OUTPUT_CHARS = 12_000;

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function optionList<T extends string | number>(
  document: Document,
  values: readonly T[],
  selected: T,
): HTMLOptionElement[] {
  return values.map((value) => {
    const option = element(document, "option");
    option.value = String(value);
    option.textContent = String(value);
    option.selected = String(value) === String(selected);
    return option;
  });
}

function formatSnapshot(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) return "undefined";
    return json.length > MAX_OUTPUT_CHARS
      ? `${json.slice(0, MAX_OUTPUT_CHARS)}\n… вывод обрезан`
      : json;
  } catch {
    return "Не удалось безопасно показать snapshot (ошибка сериализации).";
  }
}

function describeNativeCapabilities(capabilities: StreamCapabilities | undefined): string {
  if (!capabilities) return "Штатное меню качества пока недоступно.";
  const profiles = capabilities.profiles
    .slice(0, 12)
    .map(({ label, resolution, fps }) => label || `${resolution} · ${fps} FPS`)
    .join(", ");
  const codecs = capabilities.codecs.slice(0, 8).join(", ");
  const details = [profiles && `профили: ${profiles}`, codecs && `кодеки: ${codecs}`]
    .filter(Boolean)
    .join("; ");
  if (!capabilities.available) {
    const reason = capabilities.reason ? ` ${capabilities.reason.slice(0, 240)}` : "";
    return `Штатное меню качества недоступно.${reason}${details ? ` (${details})` : ""}`;
  }
  return `Штатное меню качества доступно${details ? ` — ${details}` : "."}`;
}

function isVisible(container: HTMLElement): boolean {
  if (!container.isConnected || container.ownerDocument.visibilityState === "hidden") return false;
  for (let node: HTMLElement | null = container; node; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return container.getClientRects().length > 0;
}

export function mountStreamControls(
  container: HTMLElement,
  options: {
    profile: StreamProfile;
    qualityEnabled: boolean;
    onChange: (patch: { qualityEnabled?: boolean; profile?: StreamProfile }) => Promise<void>;
    snapshot: () => unknown;
    sample: () => Promise<void>;
    nativeCapabilities: () => StreamCapabilities | undefined;
  },
): () => void {
  const document = container.ownerDocument;
  const root = element(document, "section", "lm-stream-controls");
  root.setAttribute("aria-label", "Настройки стримов");

  const style = element(document, "style");
  style.textContent = `
    .lm-stream-controls { width: 100%; color: inherit; font: inherit; }
    .lm-stream-controls h2 { margin: 0 0 10px; font-size: 15px; }
    .lm-stream-controls .lm-stream-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .lm-stream-controls label { display: grid; gap: 4px; color: var(--color-text-secondary, #c9c5d5); font-size: 12px; }
    .lm-stream-controls input, .lm-stream-controls select, .lm-stream-controls button {
      min-width: 0; min-height: 34px; border: 1px solid var(--color-border-primary, #38364b); border-radius: 8px;
      padding: 5px 8px; background: var(--color-bg-input, #100f18); color: var(--color-text-primary, #eeeaf7); font: inherit;
    }
    .lm-stream-controls button { cursor: pointer; background: var(--color-bg-button-secondary, #211f2d); }
    .lm-stream-controls button:disabled { cursor: wait; opacity: .65; }
    .lm-stream-controls .lm-stream-toggle { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
    .lm-stream-controls .lm-stream-toggle input { min-height: 0; accent-color: var(--color-brand-primary, #8b5cf6); }
    .lm-stream-controls .lm-stream-note, .lm-stream-controls .lm-stream-status {
      margin: 8px 0 0; color: var(--color-text-secondary, #a09caf); font-size: 11px;
    }
    .lm-stream-controls .lm-stream-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .lm-stream-controls .lm-stream-output {
      max-height: 150px; overflow: auto; margin: 8px 0 0; padding: 9px;
      border: 1px solid var(--color-border-primary, #302e40); border-radius: 8px; background: var(--color-bg-input, #100f18);
      color: var(--color-text-normal, #c4b5fd); white-space: pre-wrap; overflow-wrap: anywhere;
      font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
  `;

  const heading = element(document, "h2");
  heading.textContent = "Стримы";

  const toggleLabel = element(document, "label", "lm-stream-toggle");
  const qualityToggle = element(document, "input");
  qualityToggle.type = "checkbox";
  qualityToggle.checked = options.qualityEnabled;
  const toggleText = element(document, "span");
  toggleText.textContent = "Применять профиль мода";
  toggleLabel.append(qualityToggle, toggleText);

  const grid = element(document, "div", "lm-stream-grid");
  const makeSelect = <T extends string | number>(
    labelText: string,
    values: readonly T[],
    selected: T,
  ): HTMLSelectElement => {
    const label = element(document, "label");
    const text = element(document, "span");
    text.textContent = labelText;
    const select = element(document, "select");
    select.append(...optionList(document, values, selected));
    label.append(text, select);
    grid.append(label);
    return select;
  };

  const resolution = makeSelect("Разрешение", RESOLUTIONS, options.profile.resolution as (typeof RESOLUTIONS)[number]);
  const fps = makeSelect("Кадры в секунду", FRAME_RATES, options.profile.fps as (typeof FRAME_RATES)[number]);
  const codec = makeSelect("Кодек", CODECS, options.profile.codec as (typeof CODECS)[number]);

  const bitrateLabel = element(document, "label");
  const bitrateText = element(document, "span");
  bitrateText.textContent = "Битрейт, Mbps";
  const bitrate = element(document, "input");
  bitrate.type = "number";
  bitrate.min = "1";
  bitrate.max = "50";
  bitrate.step = "1";
  bitrate.value = String(Math.min(50, Math.max(1, Number(options.profile.bitrateMbps) || 1)));
  bitrateLabel.append(bitrateText, bitrate);
  grid.append(bitrateLabel);

  const notes = element(document, "p", "lm-stream-note");
  notes.textContent = "Профиль применяется при следующем запуске стрима. 1440p — экспериментальный режим, пока не измерены размеры отправителя и зрителя. Источник выбирается штатным окном Lolka.";

  const nativeInfo = element(document, "p", "lm-stream-note");
  nativeInfo.textContent = describeNativeCapabilities(options.nativeCapabilities());

  const actions = element(document, "div", "lm-stream-actions");
  const saveButton = element(document, "button");
  saveButton.type = "button";
  saveButton.textContent = "Сохранить профиль";
  const sampleButton = element(document, "button");
  sampleButton.type = "button";
  sampleButton.textContent = "Обновить статистику";
  actions.append(saveButton, sampleButton);

  const status = element(document, "p", "lm-stream-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const output = element(document, "pre", "lm-stream-output");
  output.setAttribute("aria-label", "Снимок статистики стрима");
  output.textContent = "Нажмите «Обновить статистику», чтобы получить snapshot.";

  root.append(style, heading, toggleLabel, grid, notes, nativeInfo, actions, status, output);
  container.append(root);

  const events = new AbortController();
  const eventOptions = { signal: events.signal };
  let disposed = false;
  let saving = false;
  let sampling = false;

  const currentProfile = (): StreamProfile => {
    const numericBitrate = Number(bitrate.value);
    return {
      resolution: resolution.value,
      fps: Number(fps.value),
      codec: codec.value,
      bitrateMbps: Math.min(50, Math.max(1, Number.isFinite(numericBitrate) ? numericBitrate : 1)),
    };
  };

  const save = async () => {
    if (saving || disposed) return;
    if (!bitrate.reportValidity()) {
      status.textContent = "Укажите битрейт от 1 до 50 Mbps.";
      return;
    }
    saving = true;
    saveButton.disabled = true;
    status.textContent = "Сохранение…";
    try {
      await options.onChange({ qualityEnabled: qualityToggle.checked, profile: currentProfile() });
      if (!disposed) status.textContent = "Профиль сохранён. Он будет применён при следующем запуске стрима.";
    } catch {
      if (!disposed) status.textContent = "Не удалось сохранить профиль.";
    } finally {
      saving = false;
      if (!disposed) saveButton.disabled = false;
    }
  };

  const refresh = async () => {
    if (sampling || disposed || !isVisible(container)) return;
    sampling = true;
    sampleButton.disabled = true;
    try {
      await options.sample();
      if (!disposed) {
        output.textContent = formatSnapshot(options.snapshot());
        status.textContent = "Статистика обновлена.";
      }
    } catch {
      if (!disposed) status.textContent = "Не удалось обновить статистику стрима.";
    } finally {
      sampling = false;
      if (!disposed) sampleButton.disabled = false;
    }
  };

  saveButton.addEventListener("click", () => { void save(); }, eventOptions);
  sampleButton.addEventListener("click", () => { void refresh(); }, eventOptions);
  qualityToggle.addEventListener("change", () => {
    status.textContent = "Изменение вступит в силу после сохранения.";
  }, eventOptions);

  const timer = globalThis.setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    globalThis.clearInterval(timer);
    events.abort();
    root.remove();
  };
  return dispose;
}
