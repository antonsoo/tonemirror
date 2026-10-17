import { describe, expect, it } from "vitest";
import { CREDIT_COMMENT_PREFIX, excerptCredit, parseAudioCredit, type AudioCredit } from "../src/audio/credit.js";
import { encodeWav } from "../src/audio/wav.js";

const credit: AudioCredit = {
  title: "Recorded syllable", creator: "A speaker", sourceUrl: "https://example.org/audio",
  licenseName: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
};

describe("portable recording credits", () => {
  it("composes successive crops in the original source's time", () => {
    expect(excerptCredit(undefined, 1, 2)).toBeUndefined();
    const first = excerptCredit(credit, 3.05, 4.05)!;
    const second = excerptCredit(first, 0.1, 0.4)!;
    expect(second.excerpt!.start).toBeCloseTo(3.15, 12);
    expect(second.excerpt!.end).toBeCloseTo(3.45, 12);
    expect(credit.excerpt).toBeUndefined();
    expect(first.excerpt).toEqual({ start: 3.05, end: 4.05 });
  });

  it("reads its bounded credit format without treating arbitrary optional comments as provenance", () => {
    expect(parseAudioCredit(CREDIT_COMMENT_PREFIX + JSON.stringify(credit))).toEqual(credit);
    for (const value of [null, [], {}, { ...credit, sourceUrl: "javascript:alert(1)" }, { ...credit, sourceUrl: "https://user:password@example.org/" },
      { ...credit, creator: "a\nb" }, { ...credit, title: "x".repeat(1025) }, { ...credit, excerpt: { start: 1, end: 0 } },
      { ...credit, excerpt: { start: 0, end: null } }]) {
      expect(parseAudioCredit(CREDIT_COMMENT_PREFIX + JSON.stringify(value))).toBeUndefined();
    }
    expect(parseAudioCredit("An unrelated comment")).toBeUndefined();
    expect(parseAudioCredit(CREDIT_COMMENT_PREFIX + "{" )).toBeUndefined();
  });

  it("exports author and the complete source/license/crop in standard RIFF INFO fields", () => {
    const cropped = excerptCredit(credit, 1.7, 2.65)!;
    const view = new DataView(encodeWav(new Float32Array([0.25, -0.5]), 44100, false, cropped));
    const fields = new Map<string, string>();
    for (let offset = 12; offset + 8 <= view.byteLength;) {
      const size = view.getUint32(offset + 4, true), start = offset + 8;
      if (view.getUint32(offset) === 0x4c495354) {
        for (let at = start + 4; at + 8 <= start + size;) {
          const length = view.getUint32(at + 4, true);
          const tag = String.fromCharCode(...new Uint8Array(view.buffer, at, 4));
          fields.set(tag, new TextDecoder().decode(new Uint8Array(view.buffer, at + 8, length)).replace(/\0$/, ""));
          at += 8 + length + length % 2;
        }
      }
      offset += 8 + size + size % 2;
    }
    expect(fields.get("ISFT")).toBe("ToneMirror");
    expect(fields.get("IART")).toBe(credit.creator);
    expect(parseAudioCredit(fields.get("ICOP")!)).toEqual(cropped);
    expect(fields.get("ICMT")).toBe("ToneMirror decoded mono audio; normal speed.");
  });
});
