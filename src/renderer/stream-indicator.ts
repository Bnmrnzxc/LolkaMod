import type { StreamDiagnosticsSnapshot, StreamMetrics, StreamRecord } from './stream-diagnostics';

export type IndicatorSnapshot = StreamDiagnosticsSnapshot & { sampledAt?: number | null; nativeActive?: boolean };
export type IndicatorPosition = 'top-right' | 'top-left' | 'bottom-right';
export type StreamIndicatorCard = {
  id: string;
  title: string;
  direction: 'inbound' | 'outbound';
  summary: string;
  rows: { label: string; value: string }[];
};
export type StreamIndicatorModel = {
  status: 'idle' | 'waiting' | 'live' | 'stale' | 'unavailable';
  message: string;
  sampleAgeMs: number | null;
  selectedId: string | null;
  cards: StreamIndicatorCard[];
};
export type StreamIndicatorOptions = {
  document?: Document;
  enabled?: boolean;
  detailed?: boolean;
  position?: IndicatorPosition;
  now?: () => number;
};

const STALE_AFTER_MS = 7_000;
const HOST_ID = 'lolkamod-stream-indicator';
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
        summary: `${dimensions(actual)} · ${fps(actual?.fps)} · ${bitrate(stream.bitrateKbps)} · ${codec(stream.codec)}`,
        rows,
      };
    });
}

const CSS = `
:host{all:initial;color-scheme:dark;font:12px/1.45 "Segoe UI",system-ui,sans-serif;color:#f3f5fb}
*{box-sizing:border-box}
.card{position:fixed;top:64px;right:18px;z-index:2147482000;width:min(320px,calc(100vw - 36px));
padding:10px 12px;border:1px solid #485165;border-radius:12px;background:#151a24ed;box-shadow:0 8px 28px #0006;pointer-events:none}
.card[data-position="top-left"]{left:18px;right:auto}
.card[data-position="bottom-right"]{top:auto;bottom:108px}
.card[hidden],[hidden]{display:none!important}
.heading{font-weight:650;margin:0 0 4px}
.summary{color:#e5eaf3;overflow-wrap:anywhere}
.notice{color:#b7c3d6;margin-top:5px}
select{width:100%;margin-bottom:7px;padding:4px;border:1px solid #58637a;border-radius:6px;background:#202736;
color:#f3f5fb;font:inherit;pointer-events:auto}
select:focus-visible{outline:2px solid #a7bcff;outline-offset:2px}
dl{display:grid;grid-template-columns:1fr auto;gap:4px 10px;margin:8px 0 0}
dt{color:#b7c3d6}dd{margin:0;text-align:right;color:#edf2fb}
`;

export type StreamIndicatorController = {
  update(snapshot: IndicatorSnapshot | null | undefined): void;
  setEnabled(enabled: boolean): void;
  setDetailed(detailed: boolean): void;
  setPosition(position: IndicatorPosition): void;
  select(id: string): void;
  model(): StreamIndicatorModel;
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
  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-lolkamod-owned', 'stream-indicator');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style'); style.textContent = CSS;
  const card = doc.createElement('section'); card.className = 'card';
  card.dataset.position = options.position ?? 'top-right';
  card.setAttribute('aria-label', 'Показатели видеопотока LolkaMod');
  const selection = doc.createElement('select'); selection.setAttribute('aria-label', 'Видеопоток');
  const heading = doc.createElement('div'); heading.className = 'heading';
  const summary = doc.createElement('div'); summary.className = 'summary';
  const notice = doc.createElement('div'); notice.className = 'notice';
  const details = doc.createElement('dl');
  card.append(selection, heading, summary, notice, details);
  shadow.append(style, card);

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
    card.hidden = !enabled || status === 'idle';
    if (enabled && !host.isConnected && doc.body) doc.body.append(host);
    if (!enabled) host.remove();
    selection.replaceChildren();
    for (const stream of cards) {
      const option = doc.createElement('option'); option.value = stream.id; option.textContent = stream.title;
      selection.append(option);
    }
    selection.hidden = cards.length < 2;
    selection.value = selectedId ?? '';
    const selected = cards.find(stream => stream.id === selectedId);
    heading.textContent = selected?.title ?? 'Показатели стрима';
    summary.textContent = status === 'live' ? selected?.summary ?? message : message;
    notice.textContent = status === 'live' && selected?.direction === 'outbound'
      ? 'Данные отправителя; качество у зрителя может отличаться.'
      : status === 'live' && selected?.direction === 'inbound'
        ? 'Входящее видео; источник не определён.' : '';
    details.hidden = !detailed || status !== 'live' || !selected;
    details.replaceChildren();
    if (selected) for (const row of selected.rows) {
      const label = doc.createElement('dt'); label.textContent = row.label;
      const value = doc.createElement('dd'); value.textContent = row.value;
      details.append(label, value);
    }
  }

  const onSelect = () => { selectedId = selection.value; render(); };
  selection.addEventListener('change', onSelect);
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
    setPosition(position) { if (['top-right', 'top-left', 'bottom-right'].includes(position)) card.dataset.position = position; },
    select(id) { if (latestModel.cards.some(stream => stream.id === id)) { selectedId = id; render(); } },
    model: () => ({ ...latestModel, cards: latestModel.cards.map(stream => ({ ...stream, rows: stream.rows.map(row => ({ ...row })) })) }),
    stop() {
      if (stopped) return;
      stopped = true;
      selection.removeEventListener('change', onSelect);
      host.remove();
      snapshot = null;
      if (activeControllers.get(doc) === controller) activeControllers.delete(doc);
    },
  };
  activeControllers.set(doc, controller);
  render();
  return controller;
}
