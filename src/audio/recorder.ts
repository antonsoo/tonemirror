/** Raw, on-device microphone capture. Each start owns its resources, including
 * permission requests that finish after the user has cancelled. */
import workletUrl from "./recorderWorklet.ts?worker&url";

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
}

export class MicRecorder {
  private session: RecordingSession | null = null;

  start(): Promise<void> {
    if (this.session) return this.session.ready;
    const session: RecordingSession = {
      ready: Promise.resolve(), context: null, stream: null, source: null,
      node: null, chunks: [], recording: false,
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
      session.context = context;
      await context.audioWorklet.addModule(workletUrl);
      this.assertCurrent(session);
      await context.resume();
      this.assertCurrent(session);
      session.source = context.createMediaStreamSource(session.stream);
      const node = new AudioWorkletNode(context, "recorder-processor", { numberOfInputs: 1, numberOfOutputs: 0 });
      session.node = node;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (this.session === session && session.recording) session.chunks.push(event.data);
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
    const sampleRate = session?.context?.sampleRate ?? 48000;
    const chunks = session?.recording ? session.chunks : [];
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
