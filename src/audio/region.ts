import { validateAudio } from "./limits.js";

/** A half-open sample interval covering the requested times, without resampling. */
export function regionSamples(length: number, sampleRate: number, start: number, end: number): { start: number; end: number } {
  validateAudio(length, sampleRate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > length / sampleRate) {
    throw new Error("Enter a start and end within the clip, with the end after the start.");
  }
  return { start: Math.floor(start * sampleRate), end: Math.min(length, Math.ceil(end * sampleRate)) };
}
