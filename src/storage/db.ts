/**
 * Minimal IndexedDB wrapper for the local reference library. No dependency -
 * everything stays on-device, nothing is uploaded anywhere.
 */
import { CREDIT_COMMENT_PREFIX, parseAudioCredit, type AudioCredit } from "../audio/credit.js";

export type ReferenceCategory = "user" | "mandarin" | "greek" | "japanese";

export interface StoredReference {
  id: string;
  name: string;
  category: ReferenceCategory;
  /** True for the built-in generated references (always labeled as such in the UI). */
  synthetic: boolean;
  credit?: AudioCredit | undefined;
  pcm: Float32Array;
  sampleRate: number;
  createdAt: number;
}

const DB_NAME = "tonemirror";
const DB_VERSION = 2;
const STORE = "references";
const LIBRARY_INDEX = "library-metadata";

/** Browsing the library must not deserialize every recording's PCM buffer. */
export type ReferenceSummary = Pick<StoredReference, "id" | "name" | "category" | "createdAt">;

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Reading the recording was cancelled.", "AbortError");
}

function openDb(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) throw abortError(signal);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let abandoned = false;
    const fail = (error: Error): void => {
      abandoned = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = (): void => {
      fail(abortError(signal));
      req.transaction?.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    req.onupgradeneeded = () => {
      // A blocked or cancelled open must not upgrade later behind a failed UI operation.
      if (abandoned) { req.transaction!.abort(); return; }
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction!.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: "id" });
      if (!store.indexNames.contains(LIBRARY_INDEX)) {
        // The existing records stay in place. IndexedDB builds the index atomically;
        // key cursors expose these small fields without cloning the audio values.
        store.createIndex(LIBRARY_INDEX, ["createdAt", "id", "name", "category"]);
      }
    };
    req.onsuccess = () => {
      signal?.removeEventListener("abort", abort);
      if (abandoned) { req.result.close(); return; }
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => fail(req.error ?? new Error("Failed to open IndexedDB"));
    req.onblocked = () => {
      fail(new Error("The reference library is busy in another tab. Close it and retry."));
    };
  });
}

interface StoredRecord extends Omit<StoredReference, "pcm"> {
  pcmBuffer: ArrayBuffer;
}

export async function saveReference(ref: StoredReference): Promise<void> {
  const db = await openDb();
  const record: StoredRecord = {
    id: ref.id,
    name: ref.name,
    category: ref.category,
    synthetic: ref.synthetic,
    ...(ref.credit ? { credit: ref.credit } : {}),
    sampleRate: ref.sampleRate,
    createdAt: ref.createdAt,
    pcmBuffer: new Float32Array(ref.pcm).buffer,
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save reference"));
      tx.onabort = () => reject(tx.error ?? new Error("Saving the reference was cancelled"));
    });
  } finally {
    db.close();
  }
}

export async function listReferences(): Promise<ReferenceSummary[]> {
  const db = await openDb();
  try {
    return await new Promise<ReferenceSummary[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const count = store.count();
      const req = store.index(LIBRARY_INDEX).openKeyCursor();
      const records: ReferenceSummary[] = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const [createdAt, id, name, category] = cursor.key as [number, string, string, ReferenceCategory];
        records.push({ createdAt, id, name, category });
        cursor.continue();
      };
      tx.oncomplete = () => {
        // Invalid legacy metadata can be omitted by an index. Never silently hide
        // such recordings or present their absence as an empty library.
        if (records.length !== count.result) {
          reject(new Error("Some saved reference metadata cannot be listed. The stored recordings have been kept."));
        } else resolve(records.sort((a, b) => b.createdAt - a.createdAt));
      };
      req.onerror = () => reject(req.error ?? new Error("Failed to list references"));
      tx.onabort = () => reject(tx.error ?? new Error("Reading references was cancelled"));
    });
  } finally {
    db.close();
  }
}

/** Load just the explicitly selected recording, preserving its owned PCM bytes. */
export async function getReference(id: string, signal?: AbortSignal): Promise<StoredReference | null> {
  const db = await openDb(signal);
  let abort = (): void => {};
  try {
    if (signal?.aborted) throw abortError(signal);
    const record = await new Promise<StoredRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      abort = () => tx.abort();
      signal?.addEventListener("abort", abort, { once: true });
      tx.oncomplete = () => resolve(req.result as StoredRecord | undefined);
      req.onerror = () => reject(req.error ?? new Error("Failed to read reference"));
      tx.onabort = () => reject(signal?.aborted ? abortError(signal) : tx.error ?? new Error("Reading the recording was cancelled"));
    });
    if (!record) return null;
    const { pcmBuffer, ...metadata } = record;
    // Decode outside the event callback so malformed bytes reject this operation.
    if (!(pcmBuffer instanceof ArrayBuffer)) throw new Error("The saved recording has unreadable audio data.");
    if (metadata.credit !== undefined) {
      const credit = parseAudioCredit(`${CREDIT_COMMENT_PREFIX}${JSON.stringify(metadata.credit)}`);
      if (!credit) throw new Error("The saved recording has unreadable audio credit metadata. Its stored audio has been kept.");
      metadata.credit = credit;
    }
    return { ...metadata, pcm: new Float32Array(pcmBuffer) };
  } finally {
    signal?.removeEventListener("abort", abort);
    db.close();
  }
}

export async function deleteReference(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to delete reference"));
      tx.onabort = () => reject(tx.error ?? new Error("Deleting the reference was cancelled"));
    });
  } finally {
    db.close();
  }
}
