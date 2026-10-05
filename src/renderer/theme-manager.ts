import { BUILT_IN_THEMES, createCustomThemePalette, DEFAULT_CUSTOM_THEME, type CustomTheme, type ThemeId, type ThemePalette } from '../shared/themes';
export type { ThemeId, ThemeDefinition } from '../shared/themes';
export const THEMES = BUILT_IN_THEMES;
const PALETTES = new Map(THEMES.flatMap(theme => theme.palette ? [[theme.id, theme.palette] as const] : []));
const ATTRIBUTE = 'data-lolkamod-theme';
const activeControllers = new WeakMap<Document, { stop(): void }>();

function declarations(p: Readonly<ThemePalette>): string {
  const values: Record<string, string> = {
    'lolkamod-color-scheme': p.mode,
    'color-bg-primary': p.primary,
    'color-bg-secondary': p.secondary,
    'color-bg-secondary-alt': p.secondary,
    'color-bg-secondary-hover': p.tertiary,
    'color-bg-tertiary': p.tertiary,
    'color-bg-quaternary': p.secondary,
    'color-bg-elevated': p.elevated,
    'color-bg-input': p.tertiary,
    'color-bg-select': p.tertiary,
    'color-bg-select-dropdown': p.elevated,
    'color-bg-select-option-hover': p.hover,
    'color-bg-select-option-selected': p.hover,
    'color-bg-popover': p.elevated,
    'color-bg-popover-border': p.border,
    'color-bg-tooltip': p.elevated,
    'color-bg-active': p.hover,
    'color-bg-hover': p.hover,
    'color-bg-profile-bar': p.secondary,
    'color-bg-profile-bar-hover': p.tertiary,
    'color-bg-voice-button': p.tertiary,
    'color-bg-voice-button-hover': p.hover,
    'color-bg-button-secondary': p.tertiary,
    'color-bg-button-secondary-hover': p.hover,
    'color-bg-button-secondary-active': p.hover,
    'color-picker-sidebar': p.secondary,
    'color-server-header-bg-rgb': p.rgb,
    'color-text-primary': p.text,
    'color-text-normal': p.normal,
    'color-text-secondary': p.muted,
    'color-text-muted': p.muted,
    'color-text-muted-soft': p.muted,
    'color-text-disabled': p.disabled,
    'color-text-on-brand': p.brandText,
    'text-default': p.normal,
    'text-primary': p.text,
    'text-secondary': p.muted,
    'text-muted': p.muted,
    'color-border-primary': p.border,
    'color-border-secondary': p.borderStrong,
    'color-border-button': p.border,
    'color-border-button-secondary': p.border,
    'color-border-button-secondary-hover': p.borderStrong,
    'color-border-input-hover': p.borderStrong,
    'color-brand-primary': p.brand,
    'color-brand-primary-hover': p.brandHover,
    'color-brand-primary-border': p.brand,
    'color-bg-button-primary': p.brand,
    'color-bg-button-primary-hover': p.brandHover,
    'color-bg-button-primary-active': p.brandHover,
    'color-border-button-primary': p.brand,
    'color-link': p.brand,
    'color-status-danger': p.danger,
    'color-status-danger-bright': p.danger,
    'color-text-danger': p.danger,
    'color-status-success': p.success,
    'color-status-success-bright': p.success,
    'color-status-warning': p.warning,
  };
  return Object.entries(values).map(([name, value]) => `--${name}:${value};`).join('\n');
}

export function themeCss(theme: ThemeId, custom: CustomTheme = DEFAULT_CUSTOM_THEME): string {
  if (theme === 'native') return '';
  const palette = theme === 'custom' ? createCustomThemePalette(custom) : PALETTES.get(theme);
  if (!palette) throw new TypeError('Неизвестная тема LolkaMod');
  const root = `html[${ATTRIBUTE}="${theme}"]`;
  // These host classes define palettes locally, so override variables at their scope too.
  // Host preference/classes remain intact; new host theme changes need no observer.
  return `${root},${root} :where(.dark-theme,.light-theme,.ash-theme,.aubergine-theme,.slack-theme){
color-scheme:${palette.mode};
${declarations(palette)}
}
${palette.gradient ? `${root} :where(
[class*="AppWithSidebar-module__sidebar1__"],
[class*="AppWithSidebar-module__sidebar2__"],
[class*="AppWithSidebar-module__content__"],
[class*="Channel-module__chatArea__"],
[class*="Channel-module__chatAreaFull__"],
[class*="Channel-module__chatAreaCompact__"],
[class*="SettingsLayout-module__sidebar__"],
[class*="SettingsLayout-module__main__"],
[class*="AppearanceSettings-module__root__"]){
background-color:${palette.primary};
background-image:${palette.gradient};
background-size:cover;
}` : ''}
${theme === 'contrast' ? `${root} :where(button,a,input,textarea,select,[tabindex]):focus-visible{
outline:3px solid #ffdf6e;outline-offset:3px;
}` : ''}`;
}

export type ThemeController = {
  apply(theme: ThemeId, custom?: CustomTheme): void;
  current(): ThemeId;
  stop(): void;
};

export function createThemeController(doc: Document = document): ThemeController {
  activeControllers.get(doc)?.stop();
  const root = doc.documentElement;
  const priorAttribute = root.getAttribute(ATTRIBUTE);
  const style = doc.createElement('style');
  style.id = 'lolkamod-built-in-theme';
  style.setAttribute('data-lolkamod-owned', 'theme');
  let current: ThemeId = 'native';
  let stopped = false;
  let appliedAttribute: ThemeId | undefined;

  function clearAttribute() {
    if (appliedAttribute && root.getAttribute(ATTRIBUTE) === appliedAttribute) {
      if (priorAttribute === null) root.removeAttribute(ATTRIBUTE);
      else root.setAttribute(ATTRIBUTE, priorAttribute);
    }
    appliedAttribute = undefined;
  }

  const controller: ThemeController = {
    apply(theme, custom) {
      if (stopped) return;
      const css = themeCss(theme, custom); // Reject unknown input before mutating the host.
      current = theme;
      if (theme === 'native') {
        clearAttribute();
        style.remove();
        style.textContent = '';
        return;
      }
      appliedAttribute = theme;
      root.setAttribute(ATTRIBUTE, theme);
      style.textContent = css;
      if (!style.isConnected) (doc.head ?? root).append(style);
    },
    current: () => current,
    stop() {
      if (stopped) return;
      stopped = true;
      clearAttribute();
      style.remove();
      style.textContent = '';
      current = 'native';
      if (activeControllers.get(doc) === controller) activeControllers.delete(doc);
    },
  };
  activeControllers.set(doc, controller);
  return controller;
}
