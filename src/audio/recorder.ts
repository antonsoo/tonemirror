/**
 * Microphone capture via getUserMedia + an AudioWorklet that streams raw
 * PCM frames back to this thread (see recorderWorklet.ts for why we avoid
 * MediaRecorder's lossy codecs here).
 */
// `?worker&url` (Vite) compiles the worklet module and gives us its final
// built URL, so addModule() gets real transpiled JS in both dev and prod.
import workletUrl from "./recorderWorklet.ts?worker&url";

export interface RecordedAudio {
  pcm: Float32Array;
  sampleRate: number;
}

export class MicRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private recording = false;

  async start(): Promise<void> {
    if (this.recording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule(workletUrl);

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "recorder-processor", { numberOfInputs: 1, numberOfOutputs: 0 });
    this.chunks = [];
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.chunks.push(event.data);
    };
    source.connect(this.node);
    this.recording = true;
  }

  async stop(): Promise<RecordedAudio> {
    if (!this.recording || !this.context) {
      return { pcm: new Float32Array(0), sampleRate: this.context?.sampleRate ?? 48000 };
    }
    this.recording = false;
    const sampleRate = this.context.sampleRate;

    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.context.close();

    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.context = null;
    this.node = null;
    this.stream = null;
    return { pcm, sampleRate };
  }

  isRecording(): boolean {
    return this.recording;
  }
}
