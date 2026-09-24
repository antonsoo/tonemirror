export interface PlaybackState {
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
}

/** Thin wrapper around an AudioBufferSourceNode for one PCM clip, supporting
 * loop regions and a half-speed toggle (via playbackRate - naive, so pitch
 * drops with speed, which is fine for "listen to the shape slower"). */
export class ClipPlayer {
  private context: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAtContextTime = 0;
  private startOffsetSeconds = 0;
  private rate = 1;
  private loop: { start: number; end: number } | null = null;
  private onEnded: (() => void) | null = null;

  constructor(context: AudioContext) {
    this.context = context;
  }

  load(pcm: Float32Array, sampleRate: number): void {
    this.stop();
    const buffer = this.context.createBuffer(1, Math.max(1, pcm.length), sampleRate);
    buffer.copyToChannel(Float32Array.from(pcm), 0);
    this.buffer = buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  setHalfSpeed(half: boolean): void {
    this.rate = half ? 0.5 : 1;
    if (this.source) this.source.playbackRate.value = this.rate;
  }

  setLoopRegion(region: { start: number; end: number } | null): void {
    this.loop = region;
    if (this.source && this.buffer) {
      if (region) {
        this.source.loop = true;
        this.source.loopStart = region.start * this.buffer.duration;
        this.source.loopEnd = region.end * this.buffer.duration;
      } else {
        this.source.loop = false;
      }
    }
  }

  play(fromSeconds = 0, onEnded?: () => void): void {
    if (!this.buffer) return;
    this.stop();
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    if (this.loop) {
      source.loop = true;
      source.loopStart = this.loop.start * this.buffer.duration;
      source.loopEnd = this.loop.end * this.buffer.duration;
    }
    source.connect(this.context.destination);
    this.onEnded = onEnded ?? null;
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        this.onEnded?.();
      }
    };
    source.start(0, fromSeconds);
    this.source = source;
    this.startedAtContextTime = this.context.currentTime;
    this.startOffsetSeconds = fromSeconds;
  }

  pause(): number {
    const pos = this.currentPositionSeconds();
    this.stop();
    return pos;
  }

  stop(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  get isPlaying(): boolean {
    return this.source !== null;
  }

  currentPositionSeconds(): number {
    if (!this.source) return this.startOffsetSeconds;
    const elapsed = (this.context.currentTime - this.startedAtContextTime) * this.rate;
    const pos = this.startOffsetSeconds + elapsed;
    return this.loop ? this.wrapIntoLoop(pos) : Math.min(pos, this.duration);
  }

  private wrapIntoLoop(pos: number): number {
    if (!this.loop || !this.buffer) return pos;
    const start = this.loop.start * this.buffer.duration;
    const end = this.loop.end * this.buffer.duration;
    const len = end - start || this.buffer.duration;
    if (pos < end) return pos;
    return start + ((pos - start) % len);
  }
}
