/** Attribution travels with a recording, including decoded and cropped copies.
 * Imported metadata is a credit supplied by the file, not proof of authorship.
 */
export interface AudioCredit {
  title: string;
  creator: string;
  sourceUrl: string;
  licenseName: string;
  licenseUrl: string;
  /** Seconds in the credited source, before any further sample-rate conversion. */
  excerpt?: { start: number; end: number };
}

export const CREDIT_COMMENT_PREFIX = "ToneMirror audio credit v1: ";

/** Optional WAV metadata must not introduce active markup or arbitrary URL schemes. */
export function parseAudioCredit(text: string): AudioCredit | undefined {
  if (!text.startsWith(CREDIT_COMMENT_PREFIX) || text.length > 4096) return undefined;
  let value: unknown;
  try { value = JSON.parse(text.slice(CREDIT_COMMENT_PREFIX.length)); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const field = (name: string): string | undefined => {
    const v = data[name];
    return typeof v === "string" && v.trim().length > 0 && v.length <= 1024 && ![...v].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ? v : undefined;
  };
  const title = field("title"), creator = field("creator"), sourceUrl = field("sourceUrl"), licenseName = field("licenseName"), licenseUrl = field("licenseUrl");
  if (!title || !creator || !sourceUrl || !licenseName || !licenseUrl) return undefined;
  for (const link of [sourceUrl, licenseUrl]) {
    try { const url = new URL(link); if (url.protocol !== "https:" || url.username || url.password) return undefined; }
    catch { return undefined; }
  }
  const credit: AudioCredit = { title, creator, sourceUrl, licenseName, licenseUrl };
  if (data.excerpt !== undefined) {
    const span = data.excerpt;
    if (typeof span !== "object" || span === null) return undefined;
    const { start, end } = span as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return undefined;
    credit.excerpt = { start, end };
  }
  return credit;
}

/** Compose a new crop with an earlier crop retained by a saved or imported clip. */
export function excerptCredit(credit: AudioCredit | undefined, start: number, end: number): AudioCredit | undefined {
  if (!credit) return undefined;
  const offset = credit.excerpt?.start ?? 0;
  return { ...credit, excerpt: { start: offset + start, end: offset + end } };
}
