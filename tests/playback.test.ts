import { describe, expect, it, vi } from "vitest";
import { ClipPlayer } from "../src/audio/playback.js";

function setup() {
  const sources: ReturnType<typeof source>[] = [];
  function source() {
    return {
      buffer: null, playbackRate: { value: 1 }, loop: false, loopStart: 0, loopEnd: 0,
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      onended: null as (() => void) | null,
    };
  }
  const context = {
    currentTime: 0, destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => ({ length, sampleRate: rate, duration: length / rate, copyToChannel: vi.fn(), getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => { const node = source(); sources.push(node); return node; },
  };
  const player = new ClipPlayer(context as unknown as AudioContext);
  player.load(new Float32Array(1000), 100);
  player.loadHalfSpeed(new Float32Array(2000));
  return { context, sources, player };
}

describe("playback timeline", () => {
  it("uses the prepared samples at native rate while offsets and loops keep source time", () => {
    const { player, sources, context } = setup();
    player.setHalfSpeed(true);
    player.setLoopRegion({ start: 0.2, end: 0.4 });
    player.play(3);
    expect(sources[0]!.playbackRate.value).toBe(1);
    expect(sources[0]!.start).toHaveBeenCalledWith(0, 6);
    expect(sources[0]!.loopStart).toBe(4);
    expect(sources[0]!.loopEnd).toBe(8);
    context.currentTime = 3;
    expect(player.currentPositionSeconds()).toBe(2.5);
    player.setHalfSpeed(false);
    expect(sources[1]!.start).toHaveBeenCalledWith(0, 2.5);
    expect(sources[1]!.loopStart).toBe(2);
    expect(sources[1]!.loopEnd).toBe(4);
  });

  it("does not reuse prepared audio after a different clip is loaded", () => {
    const { player } = setup();
    player.setHalfSpeed(true);
    player.load(new Float32Array(1000), 100);
    expect(player.hasHalfSpeedBuffer).toBe(false);
    expect(() => player.setHalfSpeed(true)).toThrow("Prepare");
    expect(() => player.loadHalfSpeed(new Float32Array(1000))).toThrow("does not match");
  });
  it("preserves the paused position until resumed and resets on stop", () => {
    const { context, sources, player } = setup();
    player.play();
    context.currentTime = 3;
    expect(player.pause()).toBe(3);
    context.currentTime = 100;
    expect(player.currentPositionSeconds()).toBe(3);
    player.play(player.currentPositionSeconds());
    expect(sources[1]!.start).toHaveBeenCalledWith(0, 3);
    context.currentTime = 102;
    expect(player.currentPositionSeconds()).toBe(5);
    player.stop();
    expect(player.currentPositionSeconds()).toBe(0);
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[1]!.disconnect).toHaveBeenCalledOnce();
  });

  it("applies rate changes only to time played after the change", () => {
    const { context, player } = setup();
    player.play();
    context.currentTime = 2;
    player.setHalfSpeed(true);
    expect(player.currentPositionSeconds()).toBe(2);
    context.currentTime = 4;
    expect(player.currentPositionSeconds()).toBe(3);
    player.setHalfSpeed(false);
    expect(player.currentPositionSeconds()).toBe(3);
    context.currentTime = 5;
    expect(player.currentPositionSeconds()).toBe(4);
  });

  it("retains the end position and disconnects on natural completion", () => {
    const { sources, player } = setup();
    const ended = vi.fn();
    player.play(0, ended);
    sources[0]!.onended!();
    expect(player.isPlaying).toBe(false);
    expect(player.currentPositionSeconds()).toBe(10);
    expect(ended).toHaveBeenCalledOnce();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the cursor inside a loop through rate changes, then clears the loop", () => {
    const { context, sources, player } = setup();
    player.setLoopRegion({ start: 0.2, end: 0.4 });
    player.play();
    context.currentTime = 5;
    expect(player.currentPositionSeconds()).toBe(3);
    player.setHalfSpeed(true);
    context.currentTime = 8;
    expect(player.currentPositionSeconds()).toBe(2.5);
    player.setLoopRegion(null);
    expect(sources.at(-1)!.loop).toBe(false);
    expect(player.currentPositionSeconds()).toBe(2.5);
    context.currentTime = 10;
    expect(player.currentPositionSeconds()).toBe(3.5);
  });

  it.each([0, 1, 4, 5, 7, 10])("resumes at loop start when the paused position is %s seconds", (offset) => {
    const { context, sources, player } = setup();
    player.play();
    context.currentTime = offset;
    player.pause();
    player.setLoopRegion({ start: 0.2, end: 0.4 });
    // Selecting a region while paused does not move the paused cursor.
    expect(player.currentPositionSeconds()).toBe(offset);
    player.play(player.currentPositionSeconds());
    expect(sources[1]!.start).toHaveBeenCalledWith(0, 2);
    expect(player.currentPositionSeconds()).toBe(2);
    context.currentTime += 1;
    expect(player.currentPositionSeconds()).toBe(3);
    player.setHalfSpeed(true);
    context.currentTime += 3;
    expect(player.currentPositionSeconds()).toBe(2.5);
  });

  it.each([null, { start: 0.2, end: 0.8 }])("restarts at loop entry when a playing region moves behind the cursor (%j)", (oldLoop) => {
    const { context, sources, player } = setup();
    player.setLoopRegion(oldLoop);
    player.play(5);
    context.currentTime = 0.5;
    player.setLoopRegion({ start: 0.2, end: 0.4 });
    expect(player.currentPositionSeconds()).toBe(2);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[1]!.start).toHaveBeenCalledWith(0, 2);
    context.currentTime = 1;
    expect(player.currentPositionSeconds()).toBe(2.5);
    player.setLoopRegion(null);
    context.currentTime = 3;
    expect(player.currentPositionSeconds()).toBe(4.5);
  });

  it.each([false, true])("skips pre-roll when selecting a passage during playback (half speed: %s)", (half) => {
    const { context, sources, player } = setup();
    const ended = vi.fn();
    player.setHalfSpeed(half);
    player.play(0, ended);
    context.currentTime = 0.5;
    player.setLoopRegion({ start: 0.2, end: 0.4 });
    expect(player.currentPositionSeconds()).toBe(2);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(sources[1]!.start).toHaveBeenCalledWith(0, half ? 4 : 2);
    expect(sources[1]!.loopStart).toBe(half ? 4 : 2);
    context.currentTime = 1;
    expect(player.currentPositionSeconds()).toBe(half ? 2.25 : 2.5);
    player.setLoopRegion(null);
    sources[1]!.onended!();
    expect(ended).toHaveBeenCalledOnce();
  });

  it.each([false, true])("starts the first playback within its selection (half speed: %s)", (half) => {
    const { player, sources } = setup();
    player.setHalfSpeed(half);
    player.setLoopRegion({ start: 0.2, end: 0.4 });
    expect(player.currentPositionSeconds()).toBe(0);
    player.play(player.currentPositionSeconds());
    expect(sources[0]!.start).toHaveBeenCalledWith(0, half ? 4 : 2);
    expect(player.currentPositionSeconds()).toBe(2);
  });
});
