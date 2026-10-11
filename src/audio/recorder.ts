/** Raw, on-device microphone capture. Each start owns its resources, including
 * permission requests that finish after the user has cancelled. */
import workletSource from "./recorderWorklet.js?raw";
import { MAX_AUDIO_SECONDS, validateAudio } from "./limits.js";

export interface RecordedAudio {
  pcm: Float32Array;
  sampleRate: number;
}

interface RecordingSession {
  ready: Promise<void>;
  context: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  chunks: Float32Array[];
  recording: boolean;
  samples: number;
  sampleRate: number;
  onLimit: (() => void) | undefined;
}

export class MicRecorder {
  private session: RecordingSession | null = null;

  start(onLimit?: () => void): Promise<void> {
    if (this.session) return this.session.ready;
    const session: RecordingSession = {
      ready: Promise.resolve(), context: null, stream: null, source: null,
      node: null, chunks: [], recording: false, samples: 0, sampleRate: 48000, onLimit,
    };
    this.session = session;
    session.ready = this.initialize(session);
    return session.ready;
  }

  private assertCurrent(session: RecordingSession): void {
    if (this.session !== session) throw new DOMException("Recording cancelled", "AbortError");
  }

  private async initialize(session: RecordingSession): Promise<void> {
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      this.assertCurrent(session);
      const context = new AudioContext();
      session.sampleRate = context.sampleRate;
      session.context = context;
      validateAudio(1, context.sampleRate);
      // Each context registers its own processor. Bundle the small, typechecked
      // JavaScript source so the first recording needs no post-load fetch.
      const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      this.assertCurrent(session);
      await context.resume();
      this.assertCurrent(session);
      session.source = context.createMediaStreamSource(session.stream);
      const node = new AudioWorkletNode(context, "recorder-processor", { numberOfInputs: 1, numberOfOutputs: 0 });
      session.node = node;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (this.session !== session || !session.recording) return;
        const remaining = Math.floor(session.sampleRate * MAX_AUDIO_SECONDS) - session.samples;
        const chunk = event.data.length <= remaining ? event.data : event.data.slice(0, remaining);
        session.chunks.push(chunk);
        session.samples += chunk.length;
        if (session.samples >= session.sampleRate * MAX_AUDIO_SECONDS) {
          // release stops the tracks synchronously; stop() can still retrieve the bounded capture.
          void this.release(session);
          session.onLimit?.();
        }
      };
      session.source.connect(node);
      session.recording = true;
    } catch (error) {
      if (this.session === session) this.session = null;
      await this.release(session);
      throw error;
    }
  }

  private async release(session: RecordingSession): Promise<void> {
    // Stop capture synchronously, before closing the context (which can reject).
    session.recording = false;
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = null;
    session.source?.disconnect();
    session.source = null;
    if (session.node) {
      session.node.port.onmessage = null;
      session.node.port.close();
      session.node.disconnect();
      session.node = null;
    }
    const context = session.context;
    session.context = null;
    if (context && context.state !== "closed") {
      try { await context.close(); } catch { /* Capture has already stopped. */ }
    }
  }

  async cancel(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) {
      session.chunks = [];
      await this.release(session);
    }
  }

  async stop(): Promise<RecordedAudio> {
    const session = this.session;
    this.session = null;
    const sampleRate = session?.sampleRate ?? 48000;
    const chunks = session?.chunks ?? [];
    if (session) {
      session.chunks = [];
      await this.release(session);
    }
    const pcm = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    return { pcm, sampleRate };
  }

  isRecording(): boolean {
    return this.session?.recording ?? false;
  }
}
