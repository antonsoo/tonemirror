/**
 * Minimal IndexedDB wrapper for the local reference library. No dependency -
 * everything stays on-device, nothing is uploaded anywhere.
 */

export type ReferenceCategory = "user" | "mandarin" | "greek" | "japanese";

export interface StoredReference {
  id: string;
  name: string;
  category: ReferenceCategory;
  /** True for the built-in generated references (always labeled as such in the UI). */
  synthetic: boolean;
  pcm: Float32Array;
  sampleRate: number;
  createdAt: number;
}

const DB_NAME = "tonemirror";
const DB_VERSION = 1;
const STORE = "references";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
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
    sampleRate: ref.sampleRate,
    createdAt: ref.createdAt,
    pcmBuffer: new Float32Array(ref.pcm).buffer,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to save reference"));
  });
  db.close();
}

export async function listReferences(): Promise<StoredReference[]> {
  const db = await openDb();
  const records = await new Promise<StoredRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredRecord[]);
    req.onerror = () => reject(req.error ?? new Error("Failed to list references"));
  });
  db.close();
  return records
    .map((r) => ({ ...r, pcm: new Float32Array(r.pcmBuffer) }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteReference(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to delete reference"));
  });
  db.close();
}
