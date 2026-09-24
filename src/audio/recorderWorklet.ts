/**
 * AudioWorkletProcessor that simply forwards raw mono PCM frames to the main
 * thread. Recording this way (rather than MediaRecorder + decodeAudioData)
 * avoids a lossy Opus/AAC round-trip, which matters for pitch tracking: any
 * amount of a browser's speech-codec bitrate reduction slightly disturbs the
 * fine harmonic structure YIN and MPM lean on. This file is loaded via
 * `audioContext.audioWorklet.addModule(...)`, not imported normally - it
 * runs on the audio rendering thread, isolated from the rest of the app.
 */

class RecorderProcessor extends AudioWorkletProcessor {
  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const channel = input?.[0];
    if (channel && channel.length > 0) {
      // Copy: the underlying buffer is reused by the audio thread next call.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
