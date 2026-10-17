import { validateAudio } from "./limits.js";
import { CREDIT_COMMENT_PREFIX, parseAudioCredit, type AudioCredit } from "./credit.js";

// Standard RIFF INFO fields let other editors inspect the provenance too.
export const WAV_SOFTWARE = "ToneMirror";
export const WAV_SYNTHETIC_COMMENT = "ToneMirror synthetic pitch reference; not recorded speech.";

/** Lossless export of the app's decoded mono samples, not the original encoded file.
 * WAVE_FORMAT_IEEE_FLOAT uses an 18-byte fmt chunk and a fact sample count.
 * https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex
 */
export function encodeWav(pcm: Float32Array, sampleRate: number, synthetic = false, credit?: AudioCredit): ArrayBuffer {
  validateAudio(pcm.length, sampleRate);
  if (pcm.some(value => !Number.isFinite(value))) throw new Error("This clip contains invalid audio samples.");
  const creditText = credit ? `${CREDIT_COMMENT_PREFIX}${JSON.stringify(credit)}` : undefined;
  if (creditText && (!parseAudioCredit(creditText) || new TextEncoder().encode(creditText).length >= 4096)) throw new Error("The audio credit cannot be exported without losing information.");
  const info = [
    ["ISFT", WAV_SOFTWARE],
    ["ICMT", synthetic ? WAV_SYNTHETIC_COMMENT : "ToneMirror decoded mono audio; normal speed."],
    ...(credit && creditText ? [["IART", credit.creator], ["ICOP", creditText]] : []),
  ].map(([tag, text]) => ({ tag: tag!, bytes: new TextEncoder().encode(`${text}\0`) }));
  const infoSize = 4 + info.reduce((size, field) => size + 8 + field.bytes.length + field.bytes.length % 2, 0);
  const dataOffset = 50 + 8 + infoSize + 8;
  const buffer = new ArrayBuffer(dataOffset + pcm.length * 4);
  const view = new DataView(buffer);
  const tag = (at: number, text: string): void => { for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 18, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true); view.setUint16(36, 0, true);
  tag(38, "fact"); view.setUint32(42, 4, true); view.setUint32(46, pcm.length, true);
  tag(50, "LIST"); view.setUint32(54, infoSize, true); tag(58, "INFO");
  let offset = 62;
  for (const field of info) {
    tag(offset, field.tag); view.setUint32(offset + 4, field.bytes.length, true);
    new Uint8Array(buffer, offset + 8, field.bytes.length).set(field.bytes);
    offset += 8 + field.bytes.length + field.bytes.length % 2;
  }
  tag(offset, "data"); view.setUint32(offset + 4, pcm.length * 4, true);
  // DataView specifies little endian even on a host with another byte order.
  for (let i = 0; i < pcm.length; i++) view.setFloat32(dataOffset + i * 4, pcm[i]!, true);
  return buffer;
}

export function wavFilename(label: string, role: "reference" | "attempt", synthetic: boolean): string {
  const cleaned = label.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[<>:"/\\|?*\p{Cc}]/gu, "-").trim();
  // Fifty complete code points leave room for the prefix under a 255-byte filename limit.
  const name = Array.from(cleaned).slice(0, 50).join("").replace(/[. ]+$/, "");
  return `tonemirror-${synthetic ? "synthetic-" : ""}${role}-${name || "clip"}.wav`;
}
