/** Narrow declarations for the pinned upstream Emscripten module we use. */
export interface StretchModule {
  HEAP8: Int8Array;
  _presetDefault(channels: number, sampleRate: number): void;
  _reset(): void;
  _inputLatency(): number;
  _outputLatency(): number;
  _setBuffers(channels: number, capacity: number): number;
  _process(inputSamples: number, outputSamples: number): void;
}
export default function createStretch(): Promise<StretchModule>;
