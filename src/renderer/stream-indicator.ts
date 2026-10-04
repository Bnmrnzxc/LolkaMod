import type { StreamDiagnosticsSnapshot, StreamMetrics, StreamRecord } from './stream-diagnostics';

export type IndicatorSnapshot = StreamDiagnosticsSnapshot & { sampledAt?: number | null; nativeActive?: boolean };
export type StreamIndicatorTarget = {
  streamId?: () => string | undefined;
  ownScreen?: boolean;
  active?: () => boolean;
  requested?: () => { resolution: string; fps: number; codec: string } | null;
};
export type StreamIndicatorCard = {
  id: string;
  title: string;
  direction: 'inbound' | 'outbound';
  media: 'screen' | 'camera' | 'unknown';
  summary: string;
  qualityLimited: boolean;
  rows: { label: string; value: string }[];
};
export type StreamIndicatorModel = {
  status: 'idle' | 'waiting' | 'live' | 'stale' | 'unavailable';
  message: string;
  sampleAgeMs: number | null;
  selectedId: string | null;
  cards: StreamIndicatorCard[];
  requested?: { resolution: string; fps: number; codec: string };
};
export type StreamIndicatorOptions = {
  document?: Document;
  enabled?: boolean;
  detailed?: boolean;
  now?: () => number;
};

const STALE_AFTER_MS = 7_000;
const MAX_VIEWS = 64;
let nextViewId = 1;
const activeControllers = new WeakMap<Document, { stop(): void }>();

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function fps(value: unknown): string {
  const number = finite(value);
  return number === null ? 'Нет данных' : `${number.toFixed(1).replace(/\.0$/, '')} FPS`;
}

function dimensions(metric: StreamMetrics | null): string {
  const width = finite(metric?.width);
  const height = finite(metric?.height);
  return width === null || height === null || width === 0 || height === 0
    ? 'Нет данных' : `${Math.round(width)} × ${Math.round(height)}`;
}

function bitrate(value: unknown): string {
  const number = finite(value);
  return number === null ? 'Нет данных' : `${(number / 1000).toFixed(2)} Мбит/с`;
}

function codec(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9._+-]{1,32}$/i.test(value) ? value : 'Нет данных';
}

function streamCards(streams: StreamRecord[]): StreamIndicatorCard[] {
  const ordinals = new Map<string, number>();
  return streams.slice(0, 128).filter(stream => stream.direction === 'inbound' || stream.direction === 'outbound')
    .map((stream, index) => {
      const connection = Number.isSafeInteger(stream.connectionId) && stream.connectionId >= 0 ? stream.connectionId : 0;
      const base = `${connection}:${stream.direction}`;
      const ordinal = ordinals.get(base) ?? 0;
      ordinals.set(base, ordinal + 1);
      const streamId = (stream as StreamRecord & { streamId?: unknown }).streamId;
      const stableId = typeof streamId === 'string' && /^\d+:(?:inbound|outbound):\d+$/.test(streamId)
        && streamId.startsWith(`${base}:`) ? streamId : `${base}:${ordinal}`;
      const actual = stream.direction === 'outbound' ? stream.encoded : stream.decoded;
      const title = stream.direction === 'inbound' ? `Входящее видео ${index + 1}`
        : stream.media === 'screen' ? `Мой стрим ${index + 1}`
          : stream.media === 'camera' ? `Камера ${index + 1}` : `Исходящее видео ${index + 1}`;
      const rows: StreamIndicatorCard['rows'] = [];
      if (stream.direction === 'outbound' && stream.capture) {
        rows.push({ label: 'Размер захвата', value: dimensions(stream.capture) });
        rows.push({ label: 'FPS в настройках захвата', value: fps(stream.capture.fps) });
      }
      rows.push({ label: stream.direction === 'outbound' ? 'Отправляется' : 'Декодируется', value: dimensions(actual) });
      rows.push({ label: 'Фактический FPS', value: fps(actual?.fps) });
      rows.push({ label: 'Битрейт видео', value: bitrate(stream.bitrateKbps) });
      rows.push({ label: 'Кодек', value: codec(stream.codec) });
      if (stream.direction === 'outbound') {
        const reason = stream.qualityLimitationReason === 'cpu' ? 'Нагрузка процессора'
          : stream.qualityLimitationReason === 'bandwidth' ? 'Пропускная способность сети'
            : stream.qualityLimitationReason === 'other' ? 'Другое ограничение'
              : stream.qualityLimitationReason === 'none' ? 'Нет по данным отправителя' : 'Нет данных';
        rows.push({ label: 'Ограничение качества', value: reason });
      }
      return {
        id: stableId,
        title, direction: stream.direction,
        media: stream.media === 'screen' || stream.media === 'camera' ? stream.media : 'unknown',
        qualityLimited: ['cpu', 'bandwidth', 'other'].includes(stream.qualityLimitationReason ?? ''),
        summary: `${dimensions(actual)} · ${fps(actual?.fps)} · ${bitrate(stream.bitrateKbps)} · ${codec(stream.codec)}`,
        rows,
      };
    });
}

const ICON_CSS = `
:host{all:initial;display:inline-flex;vertical-align:middle;width:18px;height:18px;line-height:0;color:var(--color-text-secondary,#9b9ba2)}
:host([hidden]){display:none}
button{all:unset;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;
border-radius:3px;cursor:help;color:var(--color-text-secondary,#9b9ba2);box-sizing:border-box}
button[data-state="live"]{color:var(--color-status-success-bright,#43b581)}
button[data-state="limited"],button[data-state="stale"]{color:var(--color-status-warning,#faa61a)}
button:hover{background:#ffffff14}button:focus-visible{outline:2px solid #a7bcff;outline-offset:3px}
svg{display:block;width:18px;height:18px;pointer-events:none}
`;
const TOOLTIP_CSS = `
:host{all:initial;display:contents;color-scheme:dark;font:12px/1.45 "Segoe UI",system-ui,sans-serif;color:var(--color-text-primary,#f3f5fb)}
*{box-sizing:border-box}
.tooltip{position:fixed;z-index:2147482000;width:min(280px,calc(100vw - 24px));padding:11px 13px;
border:1px solid var(--color-border-primary,#485165);border-radius:9px;background:var(--color-bg-tooltip,#151a24);box-shadow:0 8px 28px #0008;pointer-events:none}
.heading{font-weight:650;margin:0 0 7px}.summary{color:var(--color-text-normal,#e5eaf3);overflow-wrap:anywhere}
.summary{white-space:pre-line}
.notice{color:var(--color-text-secondary,#aab6c9);margin-top:8px;font-size:11px}
dl{display:grid;grid-template-columns:1fr auto;gap:5px 10px;margin:0}
dt{color:var(--color-text-secondary,#b7c3d6)}dd{margin:0;text-align:right;color:var(--color-text-primary,#edf2fb)}
[hidden]{display:none!important}
`;

type IndicatorView = {
  container: HTMLElement;
  target: StreamIndicatorTarget;
  revision: number;
  host: HTMLElement;
  button: HTMLButtonElement;
  portal: HTMLElement;
  tooltip: HTMLElement;
  heading: HTMLElement;
  summary: HTMLElement;
  details: HTMLElement;
  notice: HTMLElement;
  hovered: boolean;
  focused: boolean;
  model: StreamIndicatorModel;
  cleanup(): void;
};

export type StreamIndicatorController = {
  update(snapshot: IndicatorSnapshot | null | undefined): void;
  setEnabled(enabled: boolean): void;
  setDetailed(detailed: boolean): void;
  attach(container: HTMLElement, target?: StreamIndicatorTarget): () => void;
  detach(container: HTMLElement): void;
  select(id: string): void;
  model(container?: HTMLElement): StreamIndicatorModel;
  stop(): void;
};

export function createStreamIndicator(options: StreamIndicatorOptions = {}): StreamIndicatorController {
  const doc = options.document ?? document;
  activeControllers.get(doc)?.stop();
  const now = options.now ?? Date.now;
  let enabled = options.enabled ?? true;
  let detailed = options.detailed ?? false;
  let stopped = false;
  let snapshot: IndicatorSnapshot | null = null;
  let selectedId: string | null = null;
  let lastSamples = -1;
  let observedAt: number | null = null;
  let latestModel: StreamIndicatorModel = { status: 'idle', message: 'Стрим не запущен', sampleAgeMs: null, selectedId, cards: [] };
  const views = new Map<HTMLElement, IndicatorView>();
  let openView: IndicatorView | undefined;

  function cloneModel(model: StreamIndicatorModel): StreamIndicatorModel {
    return { ...model, ...(model.requested ? { requested: { ...model.requested } } : {}),
      cards: model.cards.map(stream => ({ ...stream, rows: stream.rows.map(row => ({ ...row })) })) };
  }

  function closeTooltip(view: IndicatorView) {
    view.portal.remove();
    view.button.setAttribute('aria-expanded', 'false');
    if (openView === view) openView = undefined;
  }

  function positionTooltip(view: IndicatorView) {
    if (!view.portal.isConnected) return;
    const anchor = view.button.getBoundingClientRect();
    const popup = view.tooltip.getBoundingClientRect();
    const width = doc.defaultView?.innerWidth ?? doc.documentElement.clientWidth;
    const height = doc.defaultView?.innerHeight ?? doc.documentElement.clientHeight;
    const left = Math.max(8, Math.min(anchor.right - popup.width, width - popup.width - 8));
    const above = anchor.top - popup.height - 8;
    const preferredTop = above >= 8 ? above : anchor.bottom + 8;
    const top = Math.max(8, Math.min(preferredTop, height - popup.height - 8));
    view.tooltip.style.left = `${Math.round(left)}px`;
    view.tooltip.style.top = `${Math.round(top)}px`;
  }

  function updateTooltip(view: IndicatorView) {
    const model = view.model, selected = model.cards[0];
    view.heading.textContent = selected?.direction === 'outbound' && view.target.ownScreen
      ? 'Мой стрим' : 'Показатели видео';
    const requested = model.requested;
    view.summary.textContent = `${requested ? `Выбрано: ${requested.resolution} · ${requested.fps} FPS · ${requested.codec}\n` : ''}${model.message}`;
    view.summary.hidden = model.status === 'live';
    view.details.hidden = model.status !== 'live' || !selected;
    view.details.replaceChildren();
    if (selected && model.status === 'live') for (const row of selected.rows) {
      if (!detailed && ['Размер захвата', 'FPS в настройках захвата', 'Ограничение качества'].includes(row.label)) continue;
      const label = doc.createElement('dt'); label.textContent = row.label;
      const value = doc.createElement('dd'); value.textContent = row.value;
      view.details.append(label, value);
    }
    view.notice.textContent = model.status === 'live' && selected?.direction === 'outbound'
      ? 'Данные отправителя; качество у зрителя может отличаться.'
      : model.status === 'live' && selected?.direction === 'inbound' ? 'Данные декодирования в этом клиенте.' : '';
    view.notice.hidden = !view.notice.textContent;
    positionTooltip(view);
  }

  function syncTooltip(view: IndicatorView) {
    if (!enabled || stopped || !view.host.isConnected || view.host.hidden) {
      view.hovered = false; view.focused = false;
      closeTooltip(view); return;
    }
    if (!(view.hovered || view.focused) || !doc.body) {
      closeTooltip(view); return;
    }
    if (openView && openView !== view) {
      openView.hovered = false; openView.focused = false;
      closeTooltip(openView);
    }
    if (!view.portal.isConnected) doc.body.append(view.portal);
    openView = view;
    view.button.setAttribute('aria-expanded', 'true');
    updateTooltip(view);
  }

  function resolveModel(view: IndicatorView): StreamIndicatorModel {
    let active: boolean | undefined;
    try { active = view.target.active?.(); } catch { /* Host state can disappear during unmount. */ }
    if (active === false) return { status: 'idle', message: 'Стрим не запущен', sampleAgeMs: null, selectedId: null, cards: [] };
    let requested: StreamIndicatorModel['requested'];
    if (view.target.ownScreen) try {
      const value = view.target.requested?.();
      if (value && ['480p', '720p', '1080p', '1440p'].includes(value.resolution)
        && [15, 30, 60].includes(value.fps) && ['auto', 'av1', 'vp8', 'vp9', 'h264'].includes(value.codec.toLowerCase())) {
        requested = { resolution: value.resolution, fps: value.fps,
          codec: value.codec.toLowerCase() === 'auto' ? 'Авто' : value.codec.toUpperCase() };
      }
    } catch { /* Requested settings are optional and never replace measurements. */ }
    let requestedId: string | undefined;
    try { requestedId = view.target.streamId?.(); } catch { /* A missing host/video reference must not affect rendering. */ }
    let selected = typeof requestedId === 'string' && /^\d+:(?:inbound|outbound):\d+$/.test(requestedId)
      ? latestModel.cards.find(card => card.id === requestedId) : undefined;
    if (!selected && view.target.ownScreen) {
      const candidates = latestModel.cards.filter(card => card.direction === 'outbound' && card.media === 'screen');
      if (candidates.length === 1) selected = candidates[0];
    }
    if (selected) {
      const status = latestModel.status === 'stale' ? 'stale' : snapshot?.state.samples === 0 ? 'waiting' : 'live';
      return { status, message: status === 'stale' ? 'Ожидание свежих данных' : status === 'waiting' ? 'Ожидание показателей видео' : '',
        sampleAgeMs: latestModel.sampleAgeMs, selectedId: selected.id, cards: [selected], ...(requested ? { requested } : {}) };
    }
    const own = view.target.ownScreen;
    const status = own && (snapshot?.nativeActive || active) ? 'unavailable'
      : own && snapshot?.state.displayCapture && latestModel.cards.length === 0 ? 'waiting'
        : own && !snapshot?.nativeActive && latestModel.status === 'idle' ? 'idle' : 'unavailable';
    const message = status === 'idle' ? 'Стрим не запущен'
      : status === 'waiting' ? 'Ожидание показателей видео'
        : own && (snapshot?.nativeActive || active) ? 'Стрим активен; фактические метрики недоступны' : 'Метрики этого видео не сопоставлены';
    return { status, message, sampleAgeMs: latestModel.sampleAgeMs, selectedId: null, cards: [], ...(requested ? { requested } : {}) };
  }

  function renderView(view: IndicatorView) {
    view.model = resolveModel(view);
    view.host.hidden = !enabled || view.model.status === 'idle';
    const selected = view.model.cards[0];
    view.button.dataset.state = selected?.qualityLimited && view.model.status === 'live' ? 'limited' : view.model.status;
    const requested = view.model.requested;
    const chosen = view.model.status !== 'live' && requested
      ? `; выбрано ${requested.resolution}, ${requested.fps} FPS, ${requested.codec}` : '';
    view.button.setAttribute('aria-label', `Показатели видео: ${view.model.message || selected?.summary || 'Нет данных'}${chosen}`);
    syncTooltip(view);
  }

  function detach(container: HTMLElement) {
    const view = views.get(container); if (!view) return;
    closeTooltip(view); view.cleanup(); view.host.remove(); views.delete(container);
  }

  function attach(container: HTMLElement, target: StreamIndicatorTarget = {}): () => void {
    if (stopped || !container || container.ownerDocument !== doc) return () => {};
    const previous = views.get(container);
    if (previous) {
      previous.target = target; const revision = ++previous.revision; renderView(previous);
      return () => { if (views.get(container) === previous && previous.revision === revision) detach(container); };
    }
    if (views.size >= MAX_VIEWS) return () => {};
    const id = nextViewId++;
    const host = doc.createElement('span'); host.id = `lolkamod-stream-indicator-${id}`;
    host.setAttribute('data-lolkamod-owned', 'stream-indicator');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style'); style.textContent = ICON_CSS;
    const button = doc.createElement('button'); button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 3.5h12A1.5 1.5 0 0 1 17.5 5v7A1.5 1.5 0 0 1 16 13.5H4A1.5 1.5 0 0 1 2.5 12V5A1.5 1.5 0 0 1 4 3.5ZM10 13.5V17M7 17h6');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round');
    const bars = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    bars.setAttribute('d', 'M6 10V8M10 10V6M14 10V7'); bars.setAttribute('fill', 'none');
    bars.setAttribute('stroke', 'currentColor'); bars.setAttribute('stroke-width', '1.5'); bars.setAttribute('stroke-linecap', 'round');
    svg.append(path, bars); button.append(svg); shadow.append(style, button); container.append(host);
    const portal = doc.createElement('div'); portal.setAttribute('data-lolkamod-owned', 'stream-tooltip');
    const portalShadow = portal.attachShadow({ mode: 'open' });
    const popupStyle = doc.createElement('style'); popupStyle.textContent = TOOLTIP_CSS;
    const tooltip = doc.createElement('section'); tooltip.className = 'tooltip'; tooltip.id = `lolkamod-stream-tooltip-${id}`;
    tooltip.setAttribute('role', 'tooltip');
    const heading = doc.createElement('div'); heading.className = 'heading';
    const summary = doc.createElement('div'); summary.className = 'summary';
    const details = doc.createElement('dl'); const notice = doc.createElement('div'); notice.className = 'notice';
    tooltip.append(heading, summary, details, notice); portalShadow.append(popupStyle, tooltip);
    const view: IndicatorView = { container, target, revision: 1, host, button, portal, tooltip, heading, summary, details, notice,
      hovered: false, focused: false, model: latestModel, cleanup: () => {} };
    const enter = () => { view.hovered = true; renderView(view); };
    const leave = () => { view.hovered = false; syncTooltip(view); };
    const focus = () => { view.focused = true; renderView(view); };
    const blur = () => { view.focused = false; syncTooltip(view); };
    const click = (event: MouseEvent) => { event.stopPropagation(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); view.hovered = false; view.focused = false; closeTooltip(view); }
    };
    button.addEventListener('mouseenter', enter); button.addEventListener('mouseleave', leave);
    button.addEventListener('focus', focus); button.addEventListener('blur', blur);
    button.addEventListener('click', click); button.addEventListener('keydown', key);
    const reposition = () => positionTooltip(view);
    doc.defaultView?.addEventListener('resize', reposition);
    doc.addEventListener('scroll', reposition, true);
    view.cleanup = () => {
      button.removeEventListener('mouseenter', enter); button.removeEventListener('mouseleave', leave);
      button.removeEventListener('focus', focus); button.removeEventListener('blur', blur);
      button.removeEventListener('click', click); button.removeEventListener('keydown', key);
      doc.defaultView?.removeEventListener('resize', reposition); doc.removeEventListener('scroll', reposition, true);
    };
    views.set(container, view); renderView(view);
    return () => { if (views.get(container) === view && view.revision === 1) detach(container); };
  }

  function render() {
    if (stopped) return;
    const cards = streamCards(snapshot?.streams ?? []);
    if (!cards.some(stream => stream.id === selectedId)) selectedId = cards[0]?.id ?? null;
    const sampledAt = finite(snapshot?.sampledAt) ?? observedAt;
    const age = sampledAt === null ? null : Math.max(0, now() - sampledAt);
    const stale = age !== null && age > STALE_AFTER_MS;
    const waiting = !snapshot || snapshot.state.samples === 0;
    const status = cards.length === 0 ? (snapshot?.nativeActive ? 'unavailable' : snapshot?.state.displayCapture ? 'waiting' : 'idle')
      : waiting ? 'waiting' : stale ? 'stale' : 'live';
    const message = status === 'idle' ? 'Стрим не запущен'
      : status === 'unavailable' ? 'Стрим активен; фактические метрики недоступны'
        : status === 'waiting' ? 'Ожидание показателей видео'
        : status === 'stale' ? 'Ожидание свежих данных' : '';
    latestModel = { status, message, sampleAgeMs: age, selectedId, cards };
    for (const view of views.values()) renderView(view);
  }

  const controller: StreamIndicatorController = {
    update(next) {
      if (stopped) return;
      snapshot = next ?? null;
      const samples = next?.state.samples ?? -1;
      if (samples !== lastSamples) { lastSamples = samples; observedAt = samples > 0 ? now() : null; }
      render();
    },
    setEnabled(value) { enabled = value; render(); },
    setDetailed(value) { detailed = value; render(); },
    attach, detach,
    select(id) { if (latestModel.cards.some(stream => stream.id === id)) { selectedId = id; render(); } },
    model: container => cloneModel(container && views.get(container) ? views.get(container)!.model : latestModel),
    stop() {
      if (stopped) return;
      stopped = true;
      for (const container of [...views.keys()]) detach(container);
      snapshot = null;
      if (activeControllers.get(doc) === controller) activeControllers.delete(doc);
    },
  };
  activeControllers.set(doc, controller);
  render();
  return controller;
}
