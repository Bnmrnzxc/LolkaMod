export type ThemeId = 'native' | 'graphite' | 'amoled' | 'contrast';

export type ThemeDefinition = {
  id: ThemeId;
  title: string;
  description: string;
};

export const THEMES: readonly ThemeDefinition[] = Object.freeze([
  { id: 'native', title: 'Штатная', description: 'Оформление, выбранное в Lolka' },
  { id: 'graphite', title: 'Графит', description: 'Тёмные нейтральные поверхности' },
  { id: 'amoled', title: 'AMOLED', description: 'Чёрный фон и приглушённые панели' },
  { id: 'contrast', title: 'Высокий контраст', description: 'Яркий текст, границы и фокус' },
]);

type Palette = {
  primary: string;
  secondary: string;
  tertiary: string;
  elevated: string;
  hover: string;
  border: string;
  borderStrong: string;
  text: string;
  normal: string;
  muted: string;
  disabled: string;
  brand: string;
  brandHover: string;
  brandText: string;
  rgb: string;
};

const PALETTES: Record<Exclude<ThemeId, 'native'>, Palette> = {
  graphite: {
    primary: '#17191d', secondary: '#202329', tertiary: '#282c33', elevated: '#30353e',
    hover: '#373d47', border: '#373d46', borderStrong: '#535d6b',
    text: '#f3f5f8', normal: '#d1d6df', muted: '#a6afbd', disabled: '#7c8798',
    brand: '#5374e0', brandHover: '#4752c4', brandText: '#ffffff', rgb: '23, 25, 29',
  },
  amoled: {
    primary: '#000000', secondary: '#08090b', tertiary: '#121418', elevated: '#1a1e24',
    hover: '#252b34', border: '#2b3039', borderStrong: '#4d5766',
    text: '#f6f7fb', normal: '#d3d8e2', muted: '#a2acbc', disabled: '#737e90',
    brand: '#5374e0', brandHover: '#4752c4', brandText: '#ffffff', rgb: '0, 0, 0',
  },
  contrast: {
    primary: '#07090d', secondary: '#11151c', tertiary: '#1b222d', elevated: '#252f3e',
    hover: '#354359', border: '#a9b6c9', borderStrong: '#dce7f7',
    text: '#ffffff', normal: '#ffffff', muted: '#d3ddeb', disabled: '#aebacc',
    brand: '#9dbbff', brandHover: '#bfd3ff', brandText: '#081326', rgb: '7, 9, 13',
  },
};

const ATTRIBUTE = 'data-lolkamod-theme';
const activeControllers = new WeakMap<Document, { stop(): void }>();

function declarations(p: Palette): string {
  const values: Record<string, string> = {
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
  };
  return Object.entries(values).map(([name, value]) => `--${name}:${value};`).join('\n');
}

export function themeCss(theme: ThemeId): string {
  if (theme === 'native') return '';
  const palette = PALETTES[theme];
  if (!palette) throw new TypeError('Неизвестная тема LolkaMod');
  const root = `html[${ATTRIBUTE}="${theme}"]`;
  // These host classes define palettes locally, so override variables at their scope too.
  // Host preference/classes remain intact; new host theme changes need no observer.
  return `${root},${root} :where(.dark-theme,.light-theme){
color-scheme:dark;
${declarations(palette)}
}
${theme === 'contrast' ? `${root} :where(button,a,input,textarea,select,[tabindex]):focus-visible{
outline:3px solid #ffdf6e;outline-offset:3px;
}` : ''}`;
}

export type ThemeController = {
  apply(theme: ThemeId): void;
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
    apply(theme) {
      if (stopped) return;
      const css = themeCss(theme); // Reject unknown input before mutating the host.
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
