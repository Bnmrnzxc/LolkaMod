/** Local, versioned theme IDs shared by validation, the renderer and the picker. */
export const THEME_IDS = [
  "native", "custom", "graphite", "amoled", "contrast", "midnight", "forest", "ocean", "rose", "coffee", "slate", "plum",
  "mint", "peach", "lavender", "sky", "sand", "sakura", "pistachio",
  "aurora", "sunset", "neon", "ember", "lagoon", "dusk", "twilight",
] as const;
export type ThemeId = typeof THEME_IDS[number];
const ids: ReadonlySet<string> = new Set(THEME_IDS);
export function isThemeId(value: unknown): value is ThemeId { return typeof value === "string" && ids.has(value); }

export type CustomTheme = { mode: "dark" | "light"; colors: readonly string[]; saturation: number };
export const DEFAULT_CUSTOM_THEME: Readonly<CustomTheme> = Object.freeze({
  mode: "dark", colors: Object.freeze(["#322b54"]), saturation: 80,
});

/** Saved colors are data only. CSS uses validated six-digit HEX values. */
export function normalizeCustomTheme(value: unknown): CustomTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid custom theme");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["mode", "colors", "saturation"].includes(key)) ||
      !["dark", "light"].includes(raw.mode as string) || !Array.isArray(raw.colors) ||
      raw.colors.length < 1 || raw.colors.length > 4 ||
      Array.from(raw.colors).some(color => typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) ||
      typeof raw.saturation !== "number" || !Number.isFinite(raw.saturation) || raw.saturation < 0 || raw.saturation > 100) {
    throw new Error("Invalid custom theme");
  }
  return { mode: raw.mode as CustomTheme["mode"], colors: raw.colors.map(color => (color as string).toLowerCase()), saturation: raw.saturation };
}

export type ThemePalette = {
  mode: "dark" | "light";
  primary: string; secondary: string; tertiary: string; elevated: string; hover: string;
  border: string; borderStrong: string; text: string; normal: string; muted: string; disabled: string;
  brand: string; brandHover: string; brandText: string; rgb: string;
  danger: string; success: string; warning: string;
  gradient?: string; gradientStops?: readonly string[];
};
export type ThemeDefinition = {
  id: ThemeId; title: string; description: string; group: "base" | "dark" | "light" | "gradient";
  swatch: string; palette?: Readonly<ThemePalette>;
};
function channels(hex: string): number[] { return [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)); }
function mix(a: string, b: string, amount: number): string {
  const ca = channels(a), cb = channels(b);
  return "#" + ca.map((v, i) => Math.round(v + (cb[i]! - v) * amount).toString(16).padStart(2, "0")).join("");
}
function luminance(hex: string): number {
  const values = channels(hex).map(c => { const s = c / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
  return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722;
}
function brandText(brand: string): string {
  const l = luminance(brand), dark = luminance("#081326");
  if ((l + .05) / (dark + .05) >= 4.5) return "#081326";
  return 1.05 / (l + .05) >= 4.5 ? "#ffffff" : "#000000";
}
function preset(id: Exclude<ThemeId, "native">, title: string, description: string,
  group: Exclude<ThemeDefinition["group"], "base"> | "base", primary: string, accent: string,
  stops?: readonly string[]): ThemeDefinition {
  const light = group === "light";
  const gradient = stops ? `linear-gradient(135deg,${stops.join(",")})` : undefined;
  const p: ThemePalette = {
    mode: light ? "light" : "dark", primary,
    secondary: mix(primary, light ? accent : "#000000", light ? .07 : .16),
    tertiary: mix(primary, light ? accent : "#ffffff", light ? .10 : .07),
    elevated: mix(primary, "#ffffff", light ? .40 : .10),
    hover: mix(primary, light ? accent : "#ffffff", light ? .17 : .14),
    border: mix(primary, light ? accent : "#aab6ce", light ? .28 : .22),
    borderStrong: mix(primary, light ? accent : "#cbd5e1", light ? .52 : .38),
    text: light ? "#152633" : "#f3f6fc", normal: light ? "#263b49" : "#dce5f0",
    muted: light ? "#45545f" : "#b9c6d8", disabled: light ? "#687982" : "#8393a8",
    brand: accent, brandHover: mix(accent, light ? "#000000" : "#ffffff", .12), brandText: brandText(accent),
    danger: light ? "#9f1c42" : "#ffb3c7", success: light ? "#1c7658" : "#69d8a9", warning: light ? "#925414" : "#ffd07d",
    rgb: channels(primary).join(", "), ...(gradient ? { gradient, gradientStops: Object.freeze([...stops!]) } : {}),
  };
  if (id === "contrast") { p.text = p.normal = "#ffffff"; p.muted = "#d3ddeb"; p.border = "#a9b6c9"; p.borderStrong = "#dce7f7"; }
  const swatch = gradient ?? `linear-gradient(145deg,${primary},${p.hover})`;
  return Object.freeze({ id, title, description, group, swatch, palette: Object.freeze(p) });
}

/** Hue follows chosen colors; surface brightness keeps text readable in either mode. */
export function createCustomThemePalette(value: CustomTheme): Readonly<ThemePalette> {
  const custom = normalizeCustomTheme(value);
  const colors = custom.colors.map(hex => {
    const rgb = channels(hex), max = Math.max(...rgb);
    return "#" + rgb.map(channel => Math.round(max - (max - channel) * custom.saturation / 100)
      .toString(16).padStart(2, "0")).join("");
  });
  const light = custom.mode === "light", target = light ? "#ffffff" : "#000000";
  const create = (primary: string, accent: string, stops?: readonly string[]) => {
    const p = preset("custom", "Своя тема", "Ваша палитра", light ? "light" : "dark", primary, accent, stops).palette!;
    return light ? { ...p, success: "#14523c", warning: "#63380b" } : p;
  };
  const surfaces = (p: Readonly<ThemePalette>) => [p.primary, p.secondary, p.tertiary, p.elevated, p.hover];
  const contrast = (a: string, b: string) => {
    const lo = Math.min(luminance(a), luminance(b)), hi = Math.max(luminance(a), luminance(b));
    return (hi + .05) / (lo + .05);
  };
  const readableSurface = (color: string) => {
    for (let step = 0; step <= 100; step++) {
      const candidate = mix(color, target, step / 100);
      // Black is the darkest possible accent used by light surface mixtures.
      const p = create(candidate, light ? "#000000" : color);
      if ([p.text, p.normal, p.muted, p.danger, p.success, p.warning].every(ink => surfaces(p).every(bg => contrast(ink, bg) >= 5))) return candidate;
    }
    return target;
  };
  const primary = readableSurface(colors[0]!);
  const stops = colors.length > 1 ? colors.map(readableSurface) : undefined;
  let accent = colors[0]!;
  for (let step = 0; step <= 100; step++) {
    accent = mix(colors[0]!, light ? "#000000" : "#ffffff", step / 100);
    const p = create(primary, accent, stops);
    if ([...surfaces(p), ...(stops ?? [])].every(bg => contrast(accent, bg) >= 4.5)) break;
  }
  const palette = { ...create(primary, accent, stops) };
  // Hover moves away from its text so contrast survives arbitrary accent colors.
  palette.brandHover = mix(accent, palette.brandText === "#ffffff" ? "#000000" : "#ffffff", .12);
  return Object.freeze(palette);
}

/** Swatches use the actual surface colors; they are not unrelated preview artwork. */
export const BUILT_IN_THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({ id: "native", title: "Штатная", description: "Оформление, выбранное в Lolka", group: "base", swatch: "linear-gradient(145deg,#302b38,#17141d)" }),
  preset("graphite", "Графит", "Нейтральные тёмные поверхности", "base", "#17191d", "#5374e0"),
  preset("amoled", "AMOLED", "Чёрный фон и приглушённые панели", "base", "#000000", "#7d9cff"),
  preset("contrast", "Высокий контраст", "Чёткие границы, яркий текст и заметный фокус", "base", "#07090d", "#9dbbff"),
  preset("midnight", "Полночь", "Глубокий синий с ледяными акцентами", "dark", "#11182b", "#8aa8ff"),
  preset("forest", "Хвойный лес", "Тёмно-зелёный с мягким мятным акцентом", "dark", "#101f1a", "#69c9a1"),
  preset("ocean", "Океан", "Холодный бирюзовый и цвет морской глубины", "dark", "#10202b", "#66c9df"),
  preset("rose", "Тёмная роза", "Приглушённый бордовый с розовым акцентом", "dark", "#291822", "#ef94b5"),
  preset("coffee", "Кофе", "Тёплый коричневый и карамельные детали", "dark", "#241c18", "#d9ad82"),
  preset("slate", "Сланец", "Спокойный серо-синий интерфейс", "dark", "#1b2430", "#a1b9d8"),
  preset("plum", "Слива", "Насыщенный фиолетовый с лавандовым акцентом", "dark", "#23182f", "#bda1f3"),
  preset("mint", "Мята", "Светлые мятные поверхности", "light", "#eaf7f1", "#28684f"),
  preset("peach", "Персик", "Мягкий персиковый с терракотовыми деталями", "light", "#fff0e4", "#9b472f"),
  preset("lavender", "Лаванда", "Пастельный сиреневый и сливовые акценты", "light", "#f2edfc", "#665098"),
  preset("sky", "Небо", "Светло-голубой с прохладными синими деталями", "light", "#eaf4ff", "#2c638d"),
  preset("sand", "Песок", "Тёплый светлый фон с янтарным акцентом", "light", "#faf4e4", "#805e27"),
  preset("sakura", "Сакура", "Нежно-розовые панели с ягодным акцентом", "light", "#ffedf2", "#924966"),
  preset("pistachio", "Фисташка", "Светлый зелёный с оливковыми акцентами", "light", "#eff5e3", "#536a2e"),
  preset("aurora", "Северное сияние", "Переход от ночного синего к зелёному", "gradient", "#152631", "#7addc4", ["#17213b", "#153d45", "#285044"]),
  preset("sunset", "Закат", "Сливовые и тёплые медные оттенки", "gradient", "#2b1a2b", "#ffb292", ["#25163d", "#4b2440", "#553823"]),
  preset("neon", "Неон", "Фиолетовый и синий с ярким розовым акцентом", "gradient", "#1e1737", "#ee9cfa", ["#32175b", "#432050", "#143e57"]),
  preset("ember", "Угли", "Глубокий чёрный с тёмно-красным переходом", "gradient", "#241319", "#f69a88", ["#0c0e14", "#3c1522", "#54241c"]),
  preset("lagoon", "Лагуна", "Морской синий, бирюзовый и зелёный", "gradient", "#10272d", "#85dccb", ["#13283e", "#15434b", "#234d3b"]),
  preset("dusk", "Сумерки", "Плавный переход от фиолетового к холодному синему", "gradient", "#231f35", "#bca7fa", ["#34223e", "#2b3056", "#20394f"]),
  preset("twilight", "Вечернее золото", "Тёмный оливковый с тёплым золотистым краем", "gradient", "#24271e", "#dcca86", ["#162e29", "#344632", "#51432a"]),
]);
