export interface PlaybackState {
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
}

/** Web Audio playback with a source-time cursor and optional prepared slow audio.
 * Both buffers play at native rate; half speed uses twice-length, same-pitch PCM.
 */
export class ClipPlayer {
  private context: AudioContext;
  private buffer: AudioBuffer | null = null;
  private slowBuffer: AudioBuffer | null = null;
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
    this.slowBuffer = null;
    this.rate = 1;
  }

  get hasHalfSpeedBuffer(): boolean { return this.slowBuffer !== null; }

  loadHalfSpeed(pcm: Float32Array): void {
    if (!this.buffer || pcm.length !== this.buffer.length * 2 || !pcm.every(Number.isFinite)) {
      throw new Error("The slow playback preview does not match the current clip.");
    }
    const buffer = this.context.createBuffer(1, pcm.length, this.buffer.sampleRate);
    buffer.getChannelData(0).set(pcm);
    this.slowBuffer = buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  setHalfSpeed(half: boolean): void {
    const next = half ? 0.5 : 1;
    if (next === this.rate) return;
    if (half && !this.slowBuffer) throw new Error("Prepare same-pitch audio before enabling half-speed.");
    const position = this.currentPositionSeconds();
    const playing = this.isPlaying;
    const ended = this.onEnded;
    this.rate = next;
    if (playing) this.play(position, ended ?? undefined);
    else this.startOffsetSeconds = position;
  }

  setLoopRegion(region: { start: number; end: number } | null): void {
    this.startOffsetSeconds = this.currentPositionSeconds();
    this.startedAtContextTime = this.context.currentTime;
    this.loop = region;
    if (this.source && this.buffer) {
      this.startOffsetSeconds = this.loopEntryPosition(this.startOffsetSeconds);
      if (region) {
        this.source.loop = true;
        this.source.loopStart = region.start * this.source.buffer!.duration;
        this.source.loopEnd = region.end * this.source.buffer!.duration;
      } else {
        this.source.loop = false;
      }
    }
  }

  play(fromSeconds = 0, onEnded?: () => void): void {
    if (!this.buffer) return;
    this.stop();
    const source = this.context.createBufferSource();
    source.buffer = this.rate === 0.5 ? this.slowBuffer! : this.buffer;
    source.playbackRate.value = 1;
    if (this.loop) {
      source.loop = true;
      source.loopStart = this.loop.start * source.buffer.duration;
      source.loopEnd = this.loop.end * source.buffer.duration;
    }
    source.connect(this.context.destination);
    this.onEnded = onEnded ?? null;
    source.onended = () => {
      if (this.source === source) {
        source.disconnect();
        this.source = null;
        this.startOffsetSeconds = this.duration;
        this.onEnded?.();
      }
    };
    const offset = this.loopEntryPosition(fromSeconds);
    source.start(0, offset / this.rate);
    this.source = source;
    this.startedAtContextTime = this.context.currentTime;
    this.startOffsetSeconds = offset;
  }

  pause(): number {
    const pos = this.currentPositionSeconds();
    this.stop();
    this.startOffsetSeconds = pos;
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
    this.startOffsetSeconds = 0;
    this.onEnded = null;
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

  private loopEntryPosition(pos: number): number {
    // Native playback enters at loopStart when started beyond loopEnd, or
    // when a loop is moved behind the playing position. Only subsequent
    // elapsed playback wraps with a remainder. Leave invalid offsets to
    // AudioBufferSourceNode.start's validation.
    if (this.loop && this.buffer && Number.isFinite(pos) && pos >= this.loop.end * this.buffer.duration) {
      return this.loop.start * this.buffer.duration;
    }
    return pos;
  }
}
