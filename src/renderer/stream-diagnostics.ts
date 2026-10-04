export type StreamDirection = 'inbound' | 'outbound';
export type StreamMedia = 'screen' | 'camera' | 'unknown';

export type StreamMetrics = {
  width: number | null;
  height: number | null;
  fps: number | null;
};

export type StreamEncoding = {
  maxBitrate: number | null;
  scaleResolutionDownBy: number | null;
  maxFramerate: number | null;
  active: boolean | null;
};

export type StreamRecord = {
  connectionId: number;
  direction: StreamDirection;
  media: StreamMedia;
  capture: StreamMetrics | null;
  encoded: StreamMetrics | null;
  decoded: StreamMetrics | null;
  codec: string | null;
  bitrateKbps: number | null;
  packetLossCount: number | null;
  qualityLimitationReason: string | null;
  encodings: StreamEncoding[];
};

export type StreamDiagnosticsSnapshot = {
  state: {
    connections: number;
    displayCapture: number;
    samples: number;
    noStream: boolean;
  };
  streams: StreamRecord[];
};

type Baseline = { bytes: number; frames: number | null; timestamp: number };
type Connection = {
  id: number;
  pc: any;
  listener?: () => void;
};
type Capture = { track: any; listener: () => void };

const POLL_INTERVAL_MS = 2_000;
const MAX_CONNECTIONS = 32;
const MAX_STREAMS = 128;
const MAX_BASELINES = 128;
const VIDEO_TYPES = new Set(['inbound-rtp', 'outbound-rtp']);
let activeStop: (() => void) | undefined;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function videoReport(report: any): boolean {
  return report?.kind === 'video' || report?.mediaType === 'video';
}

function reportValues(report: any): any[] {
  if (!report) return [];
  if (typeof report.values === 'function') return Array.from(report.values());
  if (typeof report.forEach === 'function') {
    const values: any[] = [];
    report.forEach((value: any) => values.push(value));
    return values;
  }
  if (Array.isArray(report)) return report;
  return [];
}

function metric(value: any): StreamMetrics | null {
  if (!value) return null;
  return {
    width: finite(value.frameWidth),
    height: finite(value.frameHeight),
    fps: finite(value.framesPerSecond),
  };
}

function captureMetric(track: any): StreamMetrics | null {
  try {
    const settings = track.getSettings?.();
    if (!settings) return null;
    return {
      width: finite(settings.width),
      height: finite(settings.height),
      fps: finite(settings.frameRate),
    };
  } catch {
    return null;
  }
}

function codecName(report: any, codecs: Map<unknown, any>): string | null {
  const mime = codecs.get(report?.codecId)?.mimeType;
  if (typeof mime !== 'string' || !mime.toLowerCase().startsWith('video/')) return null;
  const name = mime.slice(mime.indexOf('/') + 1);
  return /^[a-z0-9._+-]{1,32}$/i.test(name) ? name : null;
}

function safeQualityReason(value: unknown): string | null {
  return value === 'none' || value === 'cpu' || value === 'bandwidth' || value === 'other'
    ? value
    : null;
}

function encodingSamples(sender: any): StreamEncoding[] {
  try {
    const encodings = sender.getParameters?.()?.encodings;
    if (!Array.isArray(encodings)) return [];
    return encodings.slice(0, 8).map((encoding: any) => ({
      maxBitrate: finite(encoding?.maxBitrate),
      scaleResolutionDownBy: finite(encoding?.scaleResolutionDownBy),
      maxFramerate: finite(encoding?.maxFramerate),
      active: typeof encoding?.active === 'boolean' ? encoding.active : null,
    }));
  } catch {
    return [];
  }
}

function cloneStream(stream: StreamRecord): StreamRecord {
  return {
    ...stream,
    capture: stream.capture ? { ...stream.capture } : null,
    encoded: stream.encoded ? { ...stream.encoded } : null,
    decoded: stream.decoded ? { ...stream.decoded } : null,
    encodings: stream.encodings.map(encoding => ({ ...encoding })),
  };
}

export function installStreamDiagnostics(): {
  snapshot(): StreamDiagnosticsSnapshot;
  stop(): void;
  sample(): Promise<void>;
  observeDisplayTracks(callback: (track: MediaStreamTrack) => void): () => void;
  observePeerConnections(callback: (pc: RTCPeerConnection) => void): () => void;
} {
  activeStop?.();
  let stopped = false;
  let sampling = false;
  let nextConnectionId = 1;
  let sampleCount = 0;
  let latestStreams: StreamRecord[] = [];
  const connections = new Map<any, Connection>();
  const displayTracks = new Map<any, Capture>();
  const baselines = new Map<string, Baseline>();
  const displayObservers = new Set<(track: MediaStreamTrack) => void>();
  const connectionObservers = new Set<(pc: RTCPeerConnection) => void>();
  const win = (globalThis as any).window;
  const originalConstructorDescriptor = win ? Object.getOwnPropertyDescriptor(win, 'RTCPeerConnection') : undefined;
  const originalConstructor = win?.RTCPeerConnection;
  let constructorProxy: any;
  let mediaDevices: any;
  let originalMediaMethod: any;
  let originalMediaDescriptor: PropertyDescriptor | undefined;
  let mediaWrapper: any;

  const forgetConnection = (pc: any) => {
    const connection = connections.get(pc);
    if (!connection) return;
    if (connection.listener) {
      try { pc.removeEventListener?.('connectionstatechange', connection.listener); } catch { /* host object */ }
    }
    connections.delete(pc);
    const prefix = `${connection.id}:`;
    for (const key of baselines.keys()) if (key.startsWith(prefix)) baselines.delete(key);
    latestStreams = latestStreams.filter(stream => stream.connectionId !== connection.id);
  };

  const rememberDisplayStream = (stream: any) => {
    try {
      pruneDisplayTracks();
      for (const track of stream?.getVideoTracks?.() ?? []) {
        if (!track || track.readyState === 'ended' || displayTracks.has(track) || displayTracks.size >= MAX_CONNECTIONS) continue;
        const listener = () => {
          const capture = displayTracks.get(track);
          if (capture) {
            try { track.removeEventListener?.('ended', capture.listener); } catch { /* host object */ }
            displayTracks.delete(track);
          }
        };
        displayTracks.set(track, { track, listener });
        try { track.addEventListener?.('ended', listener, { once: true }); } catch { /* unsupported track shim */ }
        for (const observer of displayObservers) {
          try { observer(track); } catch { /* observers cannot affect successful host capture */ }
        }
      }
    } catch { /* preserve the successful host capture result */ }
  };

  function pruneDisplayTracks() {
    for (const [track, capture] of displayTracks) if (track.readyState === 'ended') {
      try { track.removeEventListener?.('ended', capture.listener); } catch { /* host track */ }
      displayTracks.delete(track);
    }
  }

  const registerConnection = (pc: any) => {
    if (stopped || !pc || connections.has(pc)) return;
    if (connections.size >= MAX_CONNECTIONS) {
      const oldest = connections.keys().next().value;
      if (oldest) forgetConnection(oldest);
    }
    const connection: Connection = { id: nextConnectionId++, pc };
    connection.listener = () => {
      if (pc.connectionState === 'closed') forgetConnection(pc);
    };
    connections.set(pc, connection);
    try { pc.addEventListener?.('connectionstatechange', connection.listener); } catch { /* unsupported shim */ }
    for (const observer of connectionObservers) {
      try { observer(pc); } catch { /* observers cannot affect host connection construction */ }
    }
  };

  if (win && typeof originalConstructor === 'function') {
    try {
      constructorProxy = new Proxy(originalConstructor, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget);
          registerConnection(pc);
          return pc;
        },
      });
      Object.defineProperty(win, 'RTCPeerConnection', {
        ...(originalConstructorDescriptor ?? { configurable: true, enumerable: true, writable: true }),
        value: constructorProxy,
      });
    } catch {
      constructorProxy = undefined;
    }
  }

  try {
    mediaDevices = win?.navigator?.mediaDevices;
    originalMediaDescriptor = mediaDevices
      ? Object.getOwnPropertyDescriptor(mediaDevices, 'getDisplayMedia')
      : undefined;
    originalMediaMethod = mediaDevices?.getDisplayMedia;
    if (typeof originalMediaMethod === 'function' && !originalMediaDescriptor?.get && !originalMediaDescriptor?.set) {
      mediaWrapper = function(this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(originalMediaMethod, this, args);
        return Promise.resolve(result).then((stream: any) => {
          rememberDisplayStream(stream);
          return stream;
        });
      };
      Object.defineProperty(mediaDevices, 'getDisplayMedia', {
        ...(originalMediaDescriptor ?? { configurable: true, enumerable: true, writable: true }),
        value: mediaWrapper,
      });
    }
  } catch {
    mediaWrapper = undefined;
  }

  const pushStream = (stream: StreamRecord) => {
    latestStreams.push(stream);
    if (latestStreams.length > MAX_STREAMS) latestStreams.splice(0, latestStreams.length - MAX_STREAMS);
  };

  const rateFor = (connection: Connection, direction: StreamDirection, keyPart: unknown,
    bytes: number | null, frames: number | null, timestamp: number): { bitrateKbps: number | null; fps: number | null } => {
    if (bytes === null) return { bitrateKbps: null, fps: null };
    const key = `${connection.id}:${direction}:${String(keyPart ?? 'unknown')}`;
    const previous = baselines.get(key);
    baselines.delete(key);
    baselines.set(key, { bytes, frames, timestamp });
    while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value as string);
    if (!previous || timestamp <= previous.timestamp) return { bitrateKbps: null, fps: null };
    const elapsed = timestamp - previous.timestamp;
    const bitrateKbps = bytes >= previous.bytes ? ((bytes - previous.bytes) * 8) / elapsed : null;
    const fps = frames !== null && previous.frames !== null && frames >= previous.frames
      ? ((frames - previous.frames) * 1000) / elapsed
      : null;
    return {
      bitrateKbps: bitrateKbps !== null && Number.isFinite(bitrateKbps) ? bitrateKbps : null,
      fps: fps !== null && Number.isFinite(fps) ? fps : null,
    };
  };

  const makeStream = (connection: Connection, direction: StreamDirection, report: any,
    codecs: Map<unknown, any>, sender?: any, senderTrack?: any): StreamRecord => {
    const screen = !!senderTrack && displayTracks.has(senderTrack);
    let camera = false;
    if (!screen && senderTrack) {
      try { camera = typeof senderTrack.getSettings?.()?.facingMode === 'string'; } catch { /* unreadable settings */ }
    }
    const media: StreamMedia = direction === 'inbound' ? 'unknown' : screen ? 'screen' : camera ? 'camera' : 'unknown';
    const timestamp = finite(report.timestamp) ?? Date.now();
    const bytes = finite(direction === 'outbound' ? report.bytesSent : report.bytesReceived);
    const frames = finite(direction === 'outbound' ? report.framesEncoded : report.framesDecoded);
    const rate = rateFor(connection, direction, report.id, bytes, frames, timestamp);
    const video = metric(report);
    if (video && video.fps === null) video.fps = rate.fps;
    const record: StreamRecord = {
      connectionId: connection.id,
      direction,
      media,
      capture: screen ? captureMetric(senderTrack) : null,
      encoded: direction === 'outbound' ? video : null,
      decoded: direction === 'inbound' ? video : null,
      codec: codecName(report, codecs),
      bitrateKbps: rate.bitrateKbps,
      packetLossCount: finite(report.packetsLost),
      qualityLimitationReason: direction === 'outbound' ? safeQualityReason(report.qualityLimitationReason) : null,
      encodings: direction === 'outbound' && sender ? encodingSamples(sender) : [],
    };
    return record;
  };

  const sample = async (): Promise<void> => {
    if (stopped || sampling) return;
    sampling = true;
    pruneDisplayTracks();
    const sampled: StreamRecord[] = [];
    try {
      const currentConnections = [...connections.values()];
      for (const connection of currentConnections) {
        const pc = connection.pc;
        if (stopped) return;
        if (pc.connectionState === 'closed') {
          forgetConnection(pc);
          continue;
        }
        const senders: any[] = [];
        try { senders.push(...(pc.getSenders?.() ?? [])); } catch { /* transient host state */ }
        for (const sender of senders) {
          const track = sender?.track;
          if (!track || track.kind !== 'video') continue;
          try {
            if (typeof sender.getStats !== 'function') continue;
            const values = reportValues(await sender.getStats());
            const codecs = new Map(values.filter(value => value?.type === 'codec').map(value => [value.id, value]));
            for (const report of values) {
              if (report?.type !== 'outbound-rtp' || !videoReport(report)) continue;
              sampled.push(makeStream(connection, 'outbound', report, codecs, sender, track));
            }
          } catch { /* transient sender statistics failure */ }
        }
        try {
          const values = reportValues(await pc.getStats());
          const codecs = new Map(values.filter(value => value?.type === 'codec').map(value => [value.id, value]));
          for (const report of values) {
            if (report?.type !== 'inbound-rtp' || !videoReport(report)) continue;
            sampled.push(makeStream(connection, 'inbound', report, codecs));
          }
        } catch { /* transient connection statistics failure */ }
      }
      latestStreams = sampled.slice(-MAX_STREAMS);
      sampleCount += 1;
    } catch { /* diagnostics must never affect host media */ }
    finally { sampling = false; }
  };

  const interval = setInterval(() => { void sample(); }, POLL_INTERVAL_MS);

  const snapshot = (): StreamDiagnosticsSnapshot => { pruneDisplayTracks(); return ({
    state: {
      connections: connections.size,
      displayCapture: displayTracks.size,
      samples: sampleCount,
      noStream: latestStreams.length === 0,
    },
    streams: latestStreams.map(cloneStream),
  }); };

  const observeDisplayTracks = (callback: (track: MediaStreamTrack) => void): (() => void) => {
    if (stopped) return () => {};
    displayObservers.add(callback);
    for (const { track } of displayTracks.values()) {
      try { callback(track); } catch { /* observer errors are isolated */ }
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      displayObservers.delete(callback);
    };
  };

  const observePeerConnections = (callback: (pc: RTCPeerConnection) => void): (() => void) => {
    if (stopped) return () => {};
    connectionObservers.add(callback);
    for (const { pc } of connections.values()) {
      try { callback(pc); } catch { /* observer errors are isolated */ }
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      connectionObservers.delete(callback);
    };
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    for (const pc of [...connections.keys()]) forgetConnection(pc);
    for (const { track, listener } of displayTracks.values()) {
      try { track.removeEventListener?.('ended', listener); } catch { /* host track */ }
    }
    displayTracks.clear();
    baselines.clear();
    latestStreams = [];
    displayObservers.clear();
    connectionObservers.clear();

    if (win && constructorProxy && win.RTCPeerConnection === constructorProxy) {
      try {
        if (originalConstructorDescriptor) Object.defineProperty(win, 'RTCPeerConnection', originalConstructorDescriptor);
        else delete win.RTCPeerConnection;
      } catch { /* another owner changed the slot */ }
    }
    if (mediaDevices && mediaWrapper && mediaDevices.getDisplayMedia === mediaWrapper) {
      try {
        if (originalMediaDescriptor) Object.defineProperty(mediaDevices, 'getDisplayMedia', originalMediaDescriptor);
        else delete mediaDevices.getDisplayMedia;
      } catch { /* another owner changed the slot */ }
    }
    if (activeStop === stop) activeStop = undefined;
  };

  activeStop = stop;
  return { snapshot, stop, sample, observeDisplayTracks, observePeerConnections };
}
