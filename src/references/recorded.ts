import audioUrl from "./FourMandarinTones.ogg?inline";
import type { AudioCredit } from "../audio/credit.js";

/** Original bytes are bundled in the startup module: first use works offline. */
export const RECORDED_CREDIT: AudioCredit = {
  title: "FourMandarinTones.ogg",
  creator: "Wolfdog (2019)",
  sourceUrl: "https://commons.wikimedia.org/w/index.php?title=File:FourMandarinTones.ogg&oldid=1277043205",
  licenseName: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
};

// Bounds fall in the quiet gaps around the four isolated syllables. They are
// practice selections, not phonetic onset/offset annotations or F0 ground truth.
export const RECORDED_TONES = [
  { tone: 1, syllable: "mā", label: "level", start: 0.4, end: 1.25 },
  { tone: 2, syllable: "má", label: "rising", start: 1.7, end: 2.65 },
  { tone: 3, syllable: "mǎ", label: "dipping", start: 3.05, end: 4.05 },
  { tone: 4, syllable: "mà", label: "falling", start: 4.5, end: 5.25 },
] as const;

export function recordedAudioFile(): File {
  const encoded = audioUrl.slice(audioUrl.indexOf(",") + 1);
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new File([bytes], RECORDED_CREDIT.title, { type: "audio/ogg" });
}
