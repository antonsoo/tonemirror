/** Browser presets bound the analysis-window cost; the core API stays configurable. */
export const PITCH_FLOORS = [40, 60, 90] as const;
export type PitchFloor = typeof PITCH_FLOORS[number];
export const DEFAULT_PITCH_FLOOR: PitchFloor = 60;

export function validatePitchFloor(value: number): PitchFloor {
  if (!PITCH_FLOORS.some(floor => floor === value)) throw new Error("Choose a pitch search floor of 40, 60 or 90 Hz.");
  return value as PitchFloor;
}
