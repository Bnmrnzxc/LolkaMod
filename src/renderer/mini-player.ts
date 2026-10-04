export type MiniPlayerReason = 'unsupported' | 'video-required' | 'video-unavailable' | 'disabled-by-host'
  | 'user-gesture-required' | 'blocked-by-policy' | 'operation-in-progress' | 'failed' | 'stopped' | null;
export type MiniPlayerState = {
  status: 'idle' | 'opening' | 'open' | 'closing' | 'unavailable' | 'error' | 'stopped';
  reason: MiniPlayerReason;
  message: string;
};
export type MiniPlayerResult = { ok: boolean; reason: MiniPlayerReason; message: string };
export type MiniPlayerOptions = { document?: Document; onState?: (state: MiniPlayerState) => void };

const MESSAGES: Record<Exclude<MiniPlayerReason, null>, string> = {
  unsupported: 'Мини-плеер не поддерживается этой сборкой Lolka.',
  'video-required': 'Выбери видео, которое нужно открыть в мини-плеере.',
  'video-unavailable': 'Видео ещё не готово или уже остановлено.',
  'disabled-by-host': 'Для этого видео Lolka отключила мини-плеер.',
  'user-gesture-required': 'Открой мини-плеер нажатием кнопки.',
  'blocked-by-policy': 'Клиент запретил открытие мини-плеера.',
  'operation-in-progress': 'Дождись завершения операции с мини-плеером.',
  failed: 'Не удалось открыть мини-плеер. Попробуй ещё раз.',
  stopped: 'Мини-плеер отключён.',
};

const activeControllers = new WeakMap<Document, { stop(): void; owns(video: HTMLVideoElement): boolean }>();

function result(reason: MiniPlayerReason = null): MiniPlayerResult {
  return { ok: reason === null, reason, message: reason ? MESSAGES[reason] : '' };
}

function errorReason(error: unknown): MiniPlayerReason {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  return name === 'NotAllowedError' ? 'user-gesture-required'
    : name === 'SecurityError' ? 'blocked-by-policy'
      : name === 'NotSupportedError' ? 'unsupported'
        : name === 'InvalidStateError' ? 'video-unavailable' : 'failed';
}

export type MiniPlayerController = {
  capability(video?: HTMLVideoElement | null): MiniPlayerResult;
  open(video: HTMLVideoElement): Promise<MiniPlayerResult>;
  close(): Promise<MiniPlayerResult>;
  state(): MiniPlayerState;
  stop(): void;
};

/** Uses only the explicitly supplied host video. No capture, track, volume or PC mutations. */
export function createMiniPlayer(options: MiniPlayerOptions = {}): MiniPlayerController {
  const doc = options.document ?? document;
  activeControllers.get(doc)?.stop();
  let stopped = false;
  let operation = 0;
  let opening = false;
  let closing = false;
  let ownedVideo: HTMLVideoElement | null = null;
  let cleanupVideo: (() => void) | undefined;
  let current: MiniPlayerState = { status: 'idle', reason: null, message: '' };

  function notify(status: MiniPlayerState['status'], reason: MiniPlayerReason = null) {
    current = { status, reason, message: reason ? MESSAGES[reason] : '' };
    try { options.onState?.({ ...current }); } catch { /* UI observers cannot affect host video. */ }
  }

  function capability(video?: HTMLVideoElement | null): MiniPlayerResult {
    if (stopped) return result('stopped');
    if (!doc.pictureInPictureEnabled || typeof doc.exitPictureInPicture !== 'function') return result('unsupported');
    if (!video) return result('video-required');
    if (video.ownerDocument !== doc || video.tagName !== 'VIDEO' || !video.isConnected || video.ended
      || video.readyState === 0 || video.videoWidth === 0 || video.videoHeight === 0) return result('video-unavailable');
    if (video.disablePictureInPicture) return result('disabled-by-host');
    if (typeof video.requestPictureInPicture !== 'function') return result('unsupported');
    return result();
  }

  function releaseVideo() {
    cleanupVideo?.(); cleanupVideo = undefined; ownedVideo = null;
  }

  async function close(): Promise<MiniPlayerResult> {
    ++operation;
    const video = ownedVideo;
    releaseVideo();
    closing = true;
    if (!stopped) notify('closing');
    try {
      // An unrelated host PiP window belongs to Lolka, so never close it.
      if (video && doc.pictureInPictureElement === video) await doc.exitPictureInPicture();
      if (!stopped) notify('idle');
      return result();
    } catch {
      if (!stopped) notify('error', 'failed');
      return result('failed');
    } finally { closing = false; }
  }

  function observeVideo(video: HTMLVideoElement) {
    ownedVideo = video;
    const onLeave = () => {
      if (ownedVideo !== video) return;
      ++operation; releaseVideo();
      if (!stopped) notify('idle');
    };
    const onEnded = () => { if (ownedVideo === video) void close(); };
    video.addEventListener('leavepictureinpicture', onLeave);
    video.addEventListener('ended', onEnded);
    video.addEventListener('emptied', onEnded);
    const stream = video.srcObject;
    const tracks = stream && 'getVideoTracks' in stream && typeof stream.getVideoTracks === 'function'
      ? stream.getVideoTracks() : [];
    const onTrackEnded = () => {
      if (ownedVideo === video && video.srcObject === stream
        && tracks.length > 0 && tracks.every(track => track.readyState === 'ended')) void close();
    };
    for (const track of tracks) track.addEventListener('ended', onTrackEnded);
    const Observer = doc.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(() => {
      if (ownedVideo === video && !video.isConnected) void close();
    }) : undefined;
    observer?.observe(doc.documentElement, { childList: true, subtree: true });
    cleanupVideo = () => {
      video.removeEventListener('leavepictureinpicture', onLeave);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('emptied', onEnded);
      for (const track of tracks) track.removeEventListener('ended', onTrackEnded);
      observer?.disconnect();
    };
  }

  const onPageHide = () => stop();
  doc.defaultView?.addEventListener('pagehide', onPageHide);
  function stop() {
    if (stopped) return;
    stopped = true;
    doc.defaultView?.removeEventListener('pagehide', onPageHide);
    void close();
    notify('stopped', 'stopped');
    if (activeControllers.get(doc) === owner) activeControllers.delete(doc);
  }

  const controller: MiniPlayerController = {
    capability,
    async open(video) {
      const check = capability(video);
      if (!check.ok) { if (!stopped) notify('unavailable', check.reason); return check; }
      if (opening || closing) return result('operation-in-progress');
      if (doc.pictureInPictureElement === video && ownedVideo === video) return result();
      releaseVideo();
      const requestOperation = ++operation;
      observeVideo(video);
      notify('opening');
      opening = true;
      try {
        // Keep this call before the first await: Chromium requires transient user activation.
        await video.requestPictureInPicture();
        if (stopped || operation !== requestOperation || !video.isConnected || video.ended
          || doc.pictureInPictureElement !== video) {
          const replacement = activeControllers.get(doc);
          if (doc.pictureInPictureElement === video && !(replacement && replacement !== owner && replacement.owns(video))) {
            try { await doc.exitPictureInPicture(); } catch { /* Window may have already closed. */ }
          }
          if (ownedVideo === video) releaseVideo();
          if (!stopped && operation === requestOperation) notify('unavailable', 'video-unavailable');
          return result(stopped ? 'stopped' : 'video-unavailable');
        }
        notify('open');
        return result();
      } catch (error) {
        const reason = errorReason(error);
        if (ownedVideo === video) releaseVideo();
        if (!stopped && operation === requestOperation) notify('error', reason);
        return result(reason);
      } finally { opening = false; }
    },
    close,
    state: () => ({ ...current }),
    stop,
  };
  const owner = { stop, owns: (video: HTMLVideoElement) => ownedVideo === video };
  activeControllers.set(doc, owner);
  return controller;
}
