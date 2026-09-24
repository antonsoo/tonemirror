/**
 * Small, labeled set of pitch-accent target shapes for two well-documented
 * systems. These are pedagogical simplifications, not phonetic ground truth -
 * real speech varies by speaker, dialect, sentence position, and (for
 * Ancient Greek) is entirely reconstruction-based since no audio survives.
 * Both are called out as such in the UI and here.
 *
 * Ancient Greek: acute/circumflex realized as pitch movement, following the
 * reconstruction in W. S. Allen, "Vox Graeca: A Guide to the Pronunciation
 * of Classical Greek," 3rd ed., Cambridge University Press, 1987 - the
 * acute is described as a rise in pitch on the accented mora, the
 * circumflex as a rise followed by a fall within a single long
 * vowel/diphthong (rise on the first mora, fall on the second).
 *
 * Japanese: the four standard word-accent patterns distinguished by *where*
 * the pitch drop falls relative to the word's morae and a following
 * particle - heiban (no drop in the word; a particle after it stays high),
 * atamadaka (drop after the first mora), nakadaka (drop somewhere inside
 * the word, after the first mora and before the last), odaka (the word
 * itself stays high through its last mora; the drop appears only on a
 * following particle). This four-way classification is standard in
 * Japanese phonology teaching, e.g. T. Vance, "The Sounds of Japanese,"
 * Cambridge University Press, 2008.
 */

export interface ControlPoint {
  /** Position within the templated span, 0 (start) to 1 (end). */
  fraction: number;
  /** Target pitch in semitones relative to the speaker's median. */
  semitone: number;
}

export type GreekAccent = "acute" | "circumflex";

const HIGH = 4;
const LOW = -3;

const GREEK_TEMPLATES: Record<GreekAccent, { label: string; points: ControlPoint[] }> = {
  acute: {
    label: "Acute (´) - rise",
    points: [
      { fraction: 0, semitone: LOW },
      { fraction: 1, semitone: HIGH },
    ],
  },
  circumflex: {
    label: "Circumflex (=) - rise then fall on a long vowel",
    points: [
      { fraction: 0, semitone: LOW },
      { fraction: 0.5, semitone: HIGH },
      { fraction: 1, semitone: LOW },
    ],
  },
};

export function greekAccentContour(accent: GreekAccent): ControlPoint[] {
  return GREEK_TEMPLATES[accent].points;
}

export function greekAccentLabel(accent: GreekAccent): string {
  return GREEK_TEMPLATES[accent].label;
}

export type JapanesePattern = "heiban" | "atamadaka" | "nakadaka" | "odaka";

/** Per-mora level (H/L) for the word's own morae, plus one trailing entry for
 * a following grammatical particle - the particle is what distinguishes
 * heiban from odaka, which are otherwise identical over the bare word. */
function moraLevels(pattern: JapanesePattern, moraCount: number): number[] {
  const n = Math.max(1, moraCount);
  const levels: number[] = new Array<number>(n + 1); // + particle
  switch (pattern) {
    case "heiban":
      levels[0] = LOW;
      for (let i = 1; i <= n; i++) levels[i] = HIGH; // includes particle: stays high
      break;
    case "atamadaka":
      levels[0] = HIGH;
      for (let i = 1; i <= n; i++) levels[i] = LOW; // drop right after mora 1, incl. particle
      break;
    case "odaka":
      levels[0] = LOW;
      for (let i = 1; i < n + 1; i++) levels[i] = HIGH; // word stays high through its last mora
      levels[n] = LOW; // ...then drops on the particle
      break;
    case "nakadaka": {
      levels[0] = LOW;
      // Drop before the word's last mora; needs >= 3 morae to be distinct
      // from atamadaka (drop at 1) and odaka (drop at n, i.e. on the particle).
      const dropAt = Math.max(2, n - 1);
      for (let i = 1; i < dropAt; i++) levels[i] = HIGH;
      for (let i = dropAt; i <= n; i++) levels[i] = LOW;
      break;
    }
  }
  return levels;
}

const JAPANESE_LABELS: Record<JapanesePattern, string> = {
  heiban: "Heiban (平板) - flat: no drop in the word, stays high onto a particle",
  atamadaka: "Atamadaka (頭高) - head-high: drops after the first mora",
  nakadaka: "Nakadaka (中高) - middle-high: drops inside the word",
  odaka: "Odaka (尾高) - tail-high: word stays high, drops only on a following particle",
};

/** Control points spanning the word's morae plus one trailing particle mora,
 * fractions normalized over that whole span (moraCount + 1 segments). */
export function japaneseAccentContour(pattern: JapanesePattern, moraCount: number): ControlPoint[] {
  const levels = moraLevels(pattern, moraCount);
  const segments = levels.length - 1;
  return levels.map((semitone, i) => ({ fraction: segments === 0 ? 0 : i / segments, semitone }));
}

export function japaneseAccentLabel(pattern: JapanesePattern): string {
  return JAPANESE_LABELS[pattern];
}

/** Linear interpolation of a control-point contour at one fraction in [0, 1]. */
export function evalControlPoints(points: ControlPoint[], t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  let lo = 0;
  while (lo < points.length - 2 && points[lo + 1]!.fraction < clamped) lo++;
  const a = points[lo]!;
  const b = points[Math.min(lo + 1, points.length - 1)]!;
  if (b.fraction === a.fraction) return a.semitone;
  const frac = (clamped - a.fraction) / (b.fraction - a.fraction);
  return a.semitone + frac * (b.semitone - a.semitone);
}

/** Linear interpolation of a control-point contour at N evenly spaced
 * fractions in [0, 1]. Shared by the synthetic-reference generator and any
 * UI code that wants to plot a template. */
export function sampleControlPoints(points: ControlPoint[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push(evalControlPoints(points, t));
  }
  return out;
}
