import { validateAudio, validateAudioSamples } from "./limits.js";

export interface ListeningClip {
  pcm: Float32Array;
  sampleRate: number;
  /** Half-open sample bounds in the original clip, or the complete clip. */
  region?: { start: number; end: number } | undefined;
}

export type ListeningState =
  | { phase: "idle" | "gap"; role: null; positionSeconds: null }
  | { phase: "reference" | "attempt"; role: "reference" | "attempt"; positionSeconds: number };

interface Session {
  nodes: [AudioBufferSourceNode, AudioBufferSourceNode];
  referenceAt: number;
  attemptAt: number;
  referenceOffset: number;
  attemptOffset: number;
  referenceDuration: number;
  attemptDuration: number;
}

export const LISTENING_GAP_SECONDS = 0.35;

/** Schedule both passages on the audio clock. No timer starts the second clip. */
export class PairedPlayer {
  private session: Session | null = null;

  constructor(private readonly context: BaseAudioContext) {}

  get isPlaying(): boolean { return this.session !== null; }

  get state(): ListeningState {
    const session = this.session;
    if (!session) return { phase: "idle", role: null, positionSeconds: null };
    const now = this.context.currentTime;
    if (now < session.referenceAt + session.referenceDuration) return {
      phase: "reference", role: "reference",
      positionSeconds: session.referenceOffset + Math.max(0, now - session.referenceAt),
    };
    if (now < session.attemptAt) return { phase: "gap", role: null, positionSeconds: null };
    return { phase: "attempt", role: "attempt",
      positionSeconds: session.attemptOffset + Math.min(session.attemptDuration, now - session.attemptAt) };
  }

  play(reference: ListeningClip, attempt: ListeningClip, onEnded: () => void): void {
    this.stop();
    const prepare = (clip: ListeningClip): { buffer: AudioBuffer; offset: number } => {
      validateAudio(clip.pcm.length, clip.sampleRate);
      const { start, end } = clip.region ?? { start: 0, end: clip.pcm.length };
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > clip.pcm.length || end <= start) {
        throw new Error("Choose a nonempty passage within each clip.");
      }
      const samples = clip.pcm.subarray(start, end);
      validateAudioSamples(samples);
      const buffer = this.context.createBuffer(1, samples.length, clip.sampleRate);
      buffer.copyToChannel(Float32Array.from(samples), 0);
      return { buffer, offset: start / clip.sampleRate };
    };
    const first = prepare(reference), second = prepare(attempt);
    const nodes: Session["nodes"] = [this.context.createBufferSource(), this.context.createBufferSource()];
    // A short lead leaves both native starts in the future even if creating the
    // buffers consumed an audio quantum. The gap is measured between their ends.
    const referenceAt = this.context.currentTime + 0.03;
    const session: Session = { nodes, referenceAt,
      attemptAt: referenceAt + first.buffer.duration + LISTENING_GAP_SECONDS,
      referenceOffset: first.offset, attemptOffset: second.offset,
      referenceDuration: first.buffer.duration, attemptDuration: second.buffer.duration };
    this.session = session;
    try {
      for (const [index, node] of nodes.entries()) {
        node.buffer = index === 0 ? first.buffer : second.buffer;
        node.playbackRate.value = 1;
        node.loop = false;
        node.connect(this.context.destination);
      }
      nodes[0].onended = () => nodes[0].disconnect();
      nodes[1].onended = () => {
        if (this.session !== session) return;
        this.stop();
        onEnded();
      };
      nodes[0].start(session.referenceAt);
      nodes[1].start(session.attemptAt);
    } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    const session = this.session;
    this.session = null;
    for (const node of session?.nodes ?? []) {
      node.onended = null;
      try { node.stop(); } catch { /* A node may not have started. */ }
      node.disconnect();
    }
  }
}
