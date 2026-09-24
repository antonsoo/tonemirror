/**
 * Target pitch contours for the four Standard Mandarin citation tones (plus
 * neutral), used to render the synthetic reference syllables. Shapes follow
 * Yuen Ren Chao's five-point pitch scale ("A system of 'tone-letters',"
 * Le Maître Phonétique, 45, 24-27, 1930): tone 1 = 55, tone 2 = 35,
 * tone 3 = 214, tone 4 = 51. Levels 1-5 are mapped linearly onto a
 * +-6 semitone range (level 3 = 0, the speaker's median) purely as a
 * pedagogical illustration; real speakers' absolute excursions vary.
 */

import type { ControlPoint } from "./accentTemplates.js";

export type MandarinToneId = 1 | 2 | 3 | 4 | "neutral";

const LEVEL_STEP = 3; // semitones per Chao pitch level, levels 1..5 around 0
const level = (n: number): number => (n - 3) * LEVEL_STEP;

const MANDARIN_TONE_TEMPLATES: Record<MandarinToneId, { label: string; chao: string; points: ControlPoint[] }> = {
  1: {
    label: "Tone 1 - high level",
    chao: "55",
    points: [
      { fraction: 0, semitone: level(5) },
      { fraction: 1, semitone: level(5) },
    ],
  },
  2: {
    label: "Tone 2 - rising",
    chao: "35",
    points: [
      { fraction: 0, semitone: level(3) },
      { fraction: 1, semitone: level(5) },
    ],
  },
  3: {
    label: "Tone 3 - low/dipping",
    chao: "214",
    points: [
      { fraction: 0, semitone: level(2) },
      { fraction: 0.45, semitone: level(1) },
      { fraction: 1, semitone: level(4) },
    ],
  },
  4: {
    label: "Tone 4 - falling",
    chao: "51",
    points: [
      { fraction: 0, semitone: level(5) },
      { fraction: 1, semitone: level(1) },
    ],
  },
  neutral: {
    label: "Neutral tone",
    chao: "(context-dependent)",
    points: [
      { fraction: 0, semitone: level(2.5) },
      { fraction: 1, semitone: level(2.5) },
    ],
  },
};

export function mandarinToneContour(tone: MandarinToneId): ControlPoint[] {
  return MANDARIN_TONE_TEMPLATES[tone].points;
}

export function mandarinToneLabel(tone: MandarinToneId): string {
  return MANDARIN_TONE_TEMPLATES[tone].label;
}

export function mandarinToneChaoNumerals(tone: MandarinToneId): string {
  return MANDARIN_TONE_TEMPLATES[tone].chao;
}

export const ALL_MANDARIN_TONES: MandarinToneId[] = [1, 2, 3, 4, "neutral"];
