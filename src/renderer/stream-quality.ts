import { Scope } from "./lifecycle";
import { before, after, instead } from "./patcher";
import type { StreamProfile } from "../shared/streams";

export const DIMENSIONS: Record<string, [number, number]> = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080], "1440p": [2560, 1440] };
export interface StreamObservers {
  observeDisplayTracks(callback: (track: MediaStreamTrack) => void): () => void;
  observePeerConnections(callback: (pc: RTCPeerConnection) => void): () => void;
}
export function constraintsFor(profile: StreamProfile, original: MediaTrackConstraints = {}): MediaTrackConstraints {
  const [width, height] = DIMENSIONS[profile.resolution];
  return { ...original, width: { ideal: width, max: width }, height: { ideal: height, max: height },
    frameRate: { ideal: profile.fps, max: profile.fps } };
}
export function encodingsFor(profile: StreamProfile, encodings: RTCRtpEncodingParameters[] = []): RTCRtpEncodingParameters[] {
  const values = encodings.length ? encodings : [{}];
  return values.map(encoding => {
    const scale = Math.max(1, encoding.scaleResolutionDownBy ?? 1);
    return { ...encoding, maxBitrate: Math.round(profile.bitrateMbps * 1_000_000 / (scale * scale)),
      maxFramerate: profile.fps, scaleResolutionDownBy: scale };
  });
}

export function installStreamQuality(observers: StreamObservers, settings: () => { qualityEnabled: boolean; profile: StreamProfile }) {
  const scope = new Scope();
  const tracks = new Map<MediaStreamTrack, { scope: Scope; profile: StreamProfile }>();
  const peers = new Map<RTCPeerConnection, Scope>();
  const senders = new WeakSet<RTCRtpSender>();
  let stopped = false;
  let errors = 0;
  const fail = () => { errors++; };
  function prune() {
    for (const [track, item] of tracks) if (track.readyState === "ended") { item.scope.dispose(); tracks.delete(track); }
    for (const [peer, peerScope] of peers) if (peer.connectionState === "closed") { peerScope.dispose(); peers.delete(peer); }
  }
  function profileFor(track: MediaStreamTrack | null | undefined) { return track ? tracks.get(track)?.profile : undefined; }
  function observeTrack(track: MediaStreamTrack) {
    prune();
    if (stopped || track.kind !== "video" || tracks.has(track) || tracks.size >= 32) return;
    const configured = settings();
    if (!configured.qualityEnabled) return;
    const profile = { ...configured.profile };
    if (!DIMENSIONS[profile.resolution]) return;
    const trackScope = new Scope(); tracks.set(track, { scope: trackScope, profile });
    const ended = () => { trackScope.dispose(); tracks.delete(track); };
    track.addEventListener("ended", ended, { once: true });
    trackScope.add(() => track.removeEventListener("ended", ended));
    try {
      trackScope.add(instead("StreamQuality", track, "applyConstraints", (args, next) => {
        const original = args[0] ?? {};
        return Promise.resolve(next(constraintsFor(profile, original))).catch(error => {
          fail();
          // applyConstraints atomically rejects incompatible constraints. Retain the host's
          // own supported settings when that explicit rejection occurs; no network retry.
          if (error?.name === "OverconstrainedError") return next(original);
          throw error;
        });
      }));
      void track.applyConstraints(constraintsFor(profile)).catch(fail);
    } catch { fail(); }
  }
  function observeSender(sender: RTCRtpSender, peerScope: Scope) {
    if (!sender || senders.has(sender)) return;
    senders.add(sender);
    try {
      peerScope.add(before("StreamQuality", sender, "setParameters", args => {
        const profile = profileFor(sender.track);
        if (!profile || !Array.isArray(args[0]?.encodings) || args[0].encodings.length === 0) return;
        return [{ ...args[0], degradationPreference: "maintain-resolution", encodings: encodingsFor(profile, args[0].encodings) }, ...args.slice(1)];
      }));
      // Wait until negotiation has produced an encoding; an empty encoding list must
      // never be changed into a different-length list in setParameters.
      const apply = async () => {
        if (stopped || !profileFor(sender.track)) return;
        try { const params = sender.getParameters(); if (params.encodings?.length) await sender.setParameters(params); }
        catch { fail(); }
      };
      const timer = setTimeout(() => { void apply(); }, 1000);
      peerScope.add(() => clearTimeout(timer));
    } catch { fail(); }
  }
  function observePeer(pc: RTCPeerConnection) {
    prune();
    if (stopped || peers.has(pc)) return;
    if (peers.size >= 32) {
      const oldest = peers.keys().next().value;
      if (oldest) { peers.get(oldest)?.dispose(); peers.delete(oldest); }
    }
    const peerScope = new Scope(); peers.set(pc, peerScope);
    const closed = () => { if (pc.connectionState === "closed") { peerScope.dispose(); peers.delete(pc); } };
    pc.addEventListener("connectionstatechange", closed);
    peerScope.add(() => pc.removeEventListener("connectionstatechange", closed));
    try {
      peerScope.add(after("StreamQuality", pc, "addTrack", sender => observeSender(sender, peerScope)));
      peerScope.add(instead("StreamQuality", pc, "addTransceiver", (args, next) => {
        const profile = profileFor(args[0]);
        const init = args[1] ?? {};
        const altered = profile ? [args[0], { ...init, sendEncodings: encodingsFor(profile, init.sendEncodings) }, ...args.slice(2)] : args;
        const transceiver = next(...altered);
        observeSender(transceiver.sender, peerScope);
        return transceiver;
      }));
      pc.getSenders().forEach(sender => observeSender(sender, peerScope));
    } catch { fail(); }
  }
  scope.add(observers.observeDisplayTracks(observeTrack));
  scope.add(observers.observePeerConnections(observePeer));
  // Explicit track.stop()/pc.close() do not reliably emit ended/state events.
  const pruneTimer = setInterval(prune, 2000);
  scope.add(() => clearInterval(pruneTimer));
  return {
    snapshot: () => { prune(); return { activeTracks: tracks.size, trackedPeers: peers.size, errors,
      target: settings().qualityEnabled ? { ...settings().profile } : null, mode: "capture-and-sender", verified1440p: false }; },
    stop() {
      if (stopped) return; stopped = true; scope.dispose();
      for (const item of tracks.values()) item.scope.dispose();
      for (const peer of peers.values()) peer.dispose();
      tracks.clear(); peers.clear();
    }
  };
}
