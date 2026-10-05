import { DEFAULT_CUSTOM_THEME, normalizeCustomTheme, type CustomTheme } from "../shared/themes";

export interface CustomThemeEditorOptions {
  value: CustomTheme;
  change(value: CustomTheme): void;
  close(): void;
}

export interface CustomThemeEditor {
  open(value: CustomTheme): void;
  hide(): void;
  update(value: CustomTheme): void;
  disabled(value: boolean): void;
  dispose(): void;
}

const STYLES = `
  .custom-theme-editor{display:grid;gap:12px;min-width:0;max-width:360px;width:100%;box-sizing:border-box;justify-self:start;padding-top:12px;border-top:1px solid var(--color-border-primary,#3b394c)}
  .custom-theme-editor .custom-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .custom-theme-editor h4{margin:0;font:inherit;font-weight:650}
  .custom-theme-editor button{font:inherit;color:inherit;border:1px solid var(--color-border-secondary,#555066);border-radius:8px;background:var(--color-bg-input,#252332);padding:8px;cursor:pointer}
  .custom-theme-editor .custom-close{border:0;background:transparent;font-size:22px;line-height:1;padding:4px 8px}
  .custom-theme-editor .custom-label{margin:0;font-size:13px;font-weight:600;color:var(--color-text-primary,#f4f1ff)}
  .custom-theme-editor .custom-modes{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;background:var(--color-bg-tertiary,#181621);border-radius:10px}
  .custom-theme-editor .custom-modes button{background:transparent;border-color:transparent}
  .custom-theme-editor .custom-modes button[aria-pressed="true"]{background:var(--color-bg-elevated,#252332);border-color:var(--color-border-secondary,#555066)}
  .custom-theme-editor .custom-sv{position:relative;min-width:0;aspect-ratio:1.9;border-radius:10px;overflow:hidden;touch-action:none;cursor:crosshair}
  .custom-theme-editor .custom-sv:before{content:"";position:absolute;inset:0;background:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent);pointer-events:none}
  .custom-theme-editor .custom-sv:focus-visible{outline:2px solid var(--color-brand-primary,#65b9dc);outline-offset:3px}
  .custom-theme-editor .custom-cursor{position:absolute;width:16px;height:16px;box-sizing:border-box;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px #0008;pointer-events:none}
  .custom-theme-editor .custom-hue{width:100%;height:18px;margin:0;appearance:none;border-radius:20px;background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);cursor:pointer}
  .custom-theme-editor .custom-hue::-webkit-slider-thumb{appearance:none;width:18px;height:18px;border:2px solid #fff;border-radius:50%;background:transparent;box-shadow:0 0 0 1px #0008}
  .custom-theme-editor .custom-color-list{display:flex;gap:8px;flex-wrap:wrap}
  .custom-theme-editor .custom-color-slot{display:flex;gap:2px;align-items:center}
  .custom-theme-editor .custom-color-chip{width:34px;height:34px;padding:0;border-radius:8px}
  .custom-theme-editor .custom-color-chip[aria-pressed="true"]{outline:2px solid var(--color-brand-primary,#65b9dc);outline-offset:2px}
  .custom-theme-editor .custom-color-remove{padding:4px;border:0;background:transparent;line-height:1}
  .custom-theme-editor .custom-hex{display:flex;align-items:center;gap:8px;background:var(--color-bg-input,#252332);padding:8px;border-radius:8px;border:1px solid var(--color-border-secondary,#555066)}
  .custom-theme-editor .custom-hex-preview{width:26px;height:26px;border:1px solid #80808066;border-radius:6px;flex:none}
  .custom-theme-editor .custom-hex input{width:100%;min-width:0;border:0;background:transparent;color:inherit;font:inherit;outline-offset:3px}
  .custom-theme-editor .custom-hex input[aria-invalid="true"]{outline:2px solid var(--color-danger,#ffb3c7)}
  .custom-theme-editor .custom-saturation-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .custom-theme-editor .custom-saturation{width:100%;margin:0;cursor:pointer}
  .custom-theme-editor .custom-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .custom-theme-editor .custom-add{width:100%}
  .custom-theme-editor .custom-help{font-size:11px}
  .custom-theme-editor [hidden]{display:none}
`;

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const maximum = Math.max(r!, g!, b!), minimum = Math.min(r!, g!, b!), delta = maximum - minimum;
  let hue = delta === 0 ? 0 : maximum === r ? ((g! - b!) / delta) % 6 : maximum === g ? (b! - r!) / delta + 2 : (r! - g!) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { h: hue, s: maximum === 0 ? 0 : delta / maximum * 100, v: maximum * 100 };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360 / 60, saturation = Math.min(100, Math.max(0, s)) / 100;
  const value = Math.min(100, Math.max(0, v)) / 100, chroma = value * saturation;
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1)), offset = value - chroma;
  const triples = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary], [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]];
  return `#${triples[Math.floor(hue)]!.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function mountCustomThemeEditor(container: HTMLElement, options: CustomThemeEditorOptions): CustomThemeEditor {
  const doc = container.ownerDocument, events = new AbortController(), signal = events.signal;
  let value = normalizeCustomTheme(options.value), colorIndex = 0, stopped = false, disabled = false, pointer: number | undefined;
  let hsv = hexToHsv(value.colors[0]!);
  const root = doc.createElement("section"); root.className = "custom-theme-editor"; root.hidden = true;
  root.dataset.customThemeEditor = "true"; root.setAttribute("aria-label", "Настройка своей темы");
  const style = doc.createElement("style"); style.textContent = STYLES; root.append(style);
  const heading = doc.createElement("div"); heading.className = "custom-heading";
  const title = doc.createElement("h4"); title.textContent = "Настрой свою тему";
  const buttons: HTMLButtonElement[] = [];
  function button(text: string, action: () => void, className = "") {
    const element = doc.createElement("button"); element.type = "button"; element.textContent = text; element.className = className;
    element.addEventListener("click", () => { if (!stopped && !disabled) action(); }, { signal }); buttons.push(element); return element;
  }
  const close = button("×", () => { root.hidden = true; releasePointer(); options.close(); }, "custom-close");
  close.setAttribute("aria-label", "Закрыть настройку темы"); heading.append(title, close); root.append(heading);
  const modeHeading = doc.createElement("p"); modeHeading.className = "custom-label"; modeHeading.textContent = "Внешний вид";
  const modes = doc.createElement("div"); modes.className = "custom-modes"; modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Внешний вид своей темы");
  const dark = button("☾ Тёмный", () => change({ ...value, mode: "dark" })); dark.dataset.themeMode = "dark";
  const light = button("☀ Светлый", () => change({ ...value, mode: "light" })); light.dataset.themeMode = "light";
  modes.append(dark, light); root.append(modeHeading, modes);
  const colorHeading = doc.createElement("p"); colorHeading.className = "custom-label"; colorHeading.textContent = "Цвета";
  const square = doc.createElement("div"); square.className = "custom-sv"; square.tabIndex = 0; square.dataset.customControl = "sv";
  square.setAttribute("role", "slider"); square.setAttribute("aria-label", "Насыщенность и яркость выбранного цвета");
  square.setAttribute("aria-valuemin", "0"); square.setAttribute("aria-valuemax", "100");
  const cursor = doc.createElement("span"); cursor.className = "custom-cursor"; cursor.setAttribute("aria-hidden", "true"); square.append(cursor);
  const hue = doc.createElement("input"); hue.type = "range"; hue.min = "0"; hue.max = "360"; hue.step = "1"; hue.className = "custom-hue";
  hue.dataset.customControl = "hue"; hue.setAttribute("aria-label", "Оттенок выбранного цвета");
  const help = doc.createElement("p"); help.className = "custom-help"; help.textContent = "←/→ — насыщенность, ↑/↓ — яркость";
  const colorList = doc.createElement("div"); colorList.className = "custom-color-list"; colorList.setAttribute("role", "group"); colorList.setAttribute("aria-label", "Цвета палитры");
  const slots: { root: HTMLElement; chip: HTMLButtonElement; remove: HTMLButtonElement }[] = [];
  for (let index = 0; index < 4; index++) {
    const slot = doc.createElement("div"); slot.className = "custom-color-slot";
    const chip = button("", () => { if (index >= value.colors.length) return; colorIndex = index; hsv = hexToHsv(value.colors[index]!); render(true); }, "custom-color-chip");
    chip.dataset.customColor = String(index); chip.setAttribute("aria-label", `Выбрать цвет ${index + 1}`);
    const remove = button("×", () => {
      if (value.colors.length < 2 || index >= value.colors.length) return;
      const colors = value.colors.filter((_, position) => position !== index);
      colorIndex = Math.min(colorIndex > index ? colorIndex - 1 : colorIndex, colors.length - 1);
      change({ ...value, colors }, true);
    }, "custom-color-remove"); remove.dataset.removeColor = String(index); remove.setAttribute("aria-label", `Удалить цвет ${index + 1}`);
    slot.append(chip, remove); slots.push({ root: slot, chip, remove }); colorList.append(slot);
  }
  const hexRow = doc.createElement("div"); hexRow.className = "custom-hex";
  const hexPreview = doc.createElement("span"); hexPreview.className = "custom-hex-preview"; hexPreview.setAttribute("aria-hidden", "true");
  const hex = doc.createElement("input"); hex.type = "text"; hex.maxLength = 7; hex.spellcheck = false; hex.dataset.customControl = "hex";
  hex.setAttribute("aria-label", "HEX выбранного цвета"); hex.setAttribute("autocomplete", "off"); hex.setAttribute("autocapitalize", "off");
  hex.setAttribute("pattern", "#[0-9a-fA-F]{6}"); hexRow.append(hexPreview, hex);
  const invalid = doc.createElement("p"); invalid.hidden = true; invalid.setAttribute("role", "status"); invalid.textContent = "Введи цвет в формате #322B54.";
  const add = button("+ Добавить цвет", () => {
    if (value.colors.length >= 4) return;
    const newColor = hsvToHex(hsv.h + 45, Math.max(25, hsv.s), Math.max(35, hsv.v));
    colorIndex = value.colors.length; change({ ...value, colors: [...value.colors, newColor] }, true);
  }, "custom-add"); add.dataset.customControl = "add";
  root.append(colorHeading, square, hue, help, colorList, hexRow, invalid, add);
  const saturationHeading = doc.createElement("div"); saturationHeading.className = "custom-saturation-heading";
  const saturationTitle = doc.createElement("p"); saturationTitle.className = "custom-label"; saturationTitle.textContent = "Насыщенность темы";
  const saturationValue = doc.createElement("output"); saturationValue.dataset.customControl = "saturation-value";
  saturationHeading.append(saturationTitle, saturationValue);
  const saturation = doc.createElement("input"); saturation.type = "range"; saturation.min = "0"; saturation.max = "100"; saturation.step = "1";
  saturation.className = "custom-saturation"; saturation.dataset.customControl = "saturation"; saturation.setAttribute("aria-label", "Насыщенность темы");
  root.append(saturationHeading, saturation);
  const actions = doc.createElement("div"); actions.className = "custom-actions";
  const random = button("Удиви меня!", () => {
    const base = Math.floor(Math.random() * 360);
    colorIndex = 0; change({ ...value, colors: [base, base + 45, base + 120].map(angle => hsvToHex(angle, 40 + Math.random() * 40, 40 + Math.random() * 30)) }, true);
  }); random.dataset.customControl = "random";
  const reset = button("Сбросить палитру", () => { colorIndex = 0; change(DEFAULT_CUSTOM_THEME, true); }); reset.dataset.customControl = "reset";
  actions.append(random, reset); root.append(actions);

  function change(next: CustomTheme, replaceDraft = false) {
    if (stopped || disabled) return;
    value = normalizeCustomTheme(next); hsv = hexToHsv(value.colors[colorIndex]!); render(replaceDraft);
    options.change(normalizeCustomTheme(value));
  }
  function changeHsv(next: typeof hsv) {
    const colors = [...value.colors]; colors[colorIndex] = hsvToHex(next.h, next.s, next.v);
    // Retain hue on the black/grey edges; an RGB conversion cannot recover it.
    const remembered = next; change({ ...value, colors }, true); hsv = remembered; render(true);
  }
  function render(replaceDraft = false) {
    if (stopped) return;
    dark.setAttribute("aria-pressed", String(value.mode === "dark")); light.setAttribute("aria-pressed", String(value.mode === "light"));
    square.style.background = hsvToHex(hsv.h, 100, 100); cursor.style.left = `${hsv.s}%`; cursor.style.top = `${100 - hsv.v}%`;
    square.setAttribute("aria-valuenow", String(Math.round(hsv.s)));
    square.setAttribute("aria-valuetext", `Насыщенность ${Math.round(hsv.s)}%, яркость ${Math.round(hsv.v)}%`);
    square.setAttribute("aria-disabled", String(disabled)); square.tabIndex = disabled ? -1 : 0;
    hue.value = String(Math.round(hsv.h)); hue.disabled = disabled;
    const focusRoot = hex.getRootNode?.() as Document | ShadowRoot | undefined;
    if (replaceDraft || (focusRoot?.activeElement ?? doc.activeElement) !== hex) { hex.value = value.colors[colorIndex]!.toUpperCase(); hex.setAttribute("aria-invalid", "false"); invalid.hidden = true; }
    hex.disabled = disabled; hexPreview.style.background = value.colors[colorIndex]!;
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!, color = value.colors[index]; slot.root.hidden = color === undefined;
      slot.chip.style.background = color ?? "transparent"; slot.chip.title = color?.toUpperCase() ?? "";
      slot.chip.setAttribute("aria-pressed", String(index === colorIndex));
    }
    for (const button of buttons) button.disabled = disabled;
    for (const slot of slots) {
      slot.chip.disabled = disabled || slot.root.hidden;
      slot.remove.disabled = disabled || slot.root.hidden || value.colors.length === 1;
    }
    add.disabled = disabled || value.colors.length >= 4;
    saturation.value = String(value.saturation); saturation.disabled = disabled; saturationValue.textContent = `${value.saturation}%`;
  }
  hue.addEventListener("input", () => { const amount = Number(hue.value); if (!stopped && !disabled && Number.isFinite(amount)) changeHsv({ ...hsv, h: amount }); }, { signal });
  saturation.addEventListener("input", () => {
    const amount = Number(saturation.value); if (!stopped && !disabled && Number.isFinite(amount)) change({ ...value, saturation: Math.min(100, Math.max(0, amount)) });
  }, { signal });
  hex.addEventListener("input", () => {
    if (stopped || disabled) return;
    const valid = /^#[0-9a-f]{6}$/i.test(hex.value); hex.setAttribute("aria-invalid", String(!valid)); invalid.hidden = valid;
    if (valid) { const colors = [...value.colors]; colors[colorIndex] = hex.value.toLowerCase(); change({ ...value, colors }); }
  }, { signal });
  hex.addEventListener("blur", () => { if (!stopped) render(true); }, { signal });
  function point(event: PointerEvent) {
    const bounds = square.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    changeHsv({ h: hsv.h, s: Math.min(100, Math.max(0, (event.clientX - bounds.left) / bounds.width * 100)),
      v: Math.min(100, Math.max(0, 100 - (event.clientY - bounds.top) / bounds.height * 100)) });
  }
  function releasePointer() {
    if (pointer === undefined) return;
    const activePointer = pointer; pointer = undefined;
    try { if (square.hasPointerCapture?.(activePointer) !== false) square.releasePointerCapture?.(activePointer); } catch { /* Capture may already have ended. */ }
  }
  square.addEventListener("pointerdown", event => {
    if (stopped || disabled || event.button !== 0) return;
    event.preventDefault(); square.focus(); releasePointer(); pointer = event.pointerId;
    try { square.setPointerCapture?.(event.pointerId); } catch { /* Synthetic events may not carry an active pointer. */ }
    point(event);
  }, { signal });
  square.addEventListener("pointermove", event => { if (!stopped && !disabled && pointer === event.pointerId) point(event); }, { signal });
  const endPointer = (event: PointerEvent) => { if (pointer === event.pointerId) releasePointer(); };
  square.addEventListener("pointerup", endPointer, { signal }); square.addEventListener("pointercancel", endPointer, { signal });
  square.addEventListener("lostpointercapture", event => { if (pointer === event.pointerId) pointer = undefined; }, { signal });
  square.addEventListener("keydown", event => {
    if (stopped || disabled) return;
    const step = event.shiftKey ? 10 : 1;
    const next = { ...hsv };
    switch (event.key) {
      case "ArrowLeft": next.s = Math.max(0, hsv.s - step); break;
      case "ArrowRight": next.s = Math.min(100, hsv.s + step); break;
      case "ArrowUp": next.v = Math.min(100, hsv.v + step); break;
      case "ArrowDown": next.v = Math.max(0, hsv.v - step); break;
      default: return;
    }
    event.preventDefault(); changeHsv(next);
  }, { signal });
  root.addEventListener("keydown", event => { if (!stopped && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); root.hidden = true; releasePointer(); options.close(); } }, { signal });
  container.append(root); render(true);
  return {
    open(next) { if (stopped) return; value = normalizeCustomTheme(next); colorIndex = Math.min(colorIndex, value.colors.length - 1); hsv = hexToHsv(value.colors[colorIndex]!); root.hidden = false; render(true); },
    hide() { if (!stopped) { root.hidden = true; releasePointer(); } },
    update(next) {
      if (stopped) return;
      const normalized = normalizeCustomTheme(next);
      if (JSON.stringify(normalized) !== JSON.stringify(value)) { value = normalized; colorIndex = Math.min(colorIndex, value.colors.length - 1); hsv = hexToHsv(value.colors[colorIndex]!); render(); }
    },
    disabled(next) { if (stopped) return; disabled = next; if (next) releasePointer(); render(); },
    dispose() { if (stopped) return; releasePointer(); stopped = true; events.abort(); root.remove(); },
  };
}
