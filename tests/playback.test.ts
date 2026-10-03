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
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: vi.fn() }),
    createBufferSource: () => { const node = source(); sources.push(node); return node; },
  };
  const player = new ClipPlayer(context as unknown as AudioContext);
  player.load(new Float32Array(1000), 100);
  return { context, sources, player };
}

describe("playback timeline", () => {
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
    expect(sources[0]!.loop).toBe(false);
    expect(player.currentPositionSeconds()).toBe(2.5);
    context.currentTime = 10;
    expect(player.currentPositionSeconds()).toBe(3.5);
  });
});
