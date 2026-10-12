import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBDatabase, IDBFactory, IDBIndex, IDBObjectStore } from "fake-indexeddb";
import { deleteReference, getReference, listReferences, saveReference, type StoredReference } from "../src/storage/db.js";

const reference: StoredReference = {
  id: "first", name: "A reference", category: "user", synthetic: false,
  pcm: new Float32Array([0.25, -0.5]), sampleRate: 22050, createdAt: 1,
};

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("local reference storage", () => {
  it("round-trips owned PCM, orders recent references first, and deletes", async () => {
    await saveReference(reference);
    await saveReference({ ...reference, id: "second", createdAt: 2 });
    const records = await listReferences();
    expect(records.map((record) => record.id)).toEqual(["second", "first"]);
    expect(records[1]).toEqual({ id: "first", name: "A reference", category: "user", createdAt: 1 });
    const first = await getReference("first");
    expect(first!.pcm).toEqual(reference.pcm);
    first!.pcm.fill(0);
    expect((await getReference("first"))!.pcm).toEqual(reference.pcm);
    await deleteReference("first");
    expect((await listReferences()).map((record) => record.id)).toEqual(["second"]);
    expect(await getReference("first")).toBeNull();
  });

  it("rejects an aborted save and closes the connection without persisting it", async () => {
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    // The wrapper deliberately supplies the receiving store with .call below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown) {
      const request = put.call(this, value);
      this.transaction.abort();
      return request;
    });
    await expect(saveReference(reference)).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
    expect(await listReferences()).toEqual([]);
  });

  it("rejects aborted reads even after the metadata cursor succeeded", async () => {
    await saveReference(reference);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const openKeyCursor = IDBIndex.prototype.openKeyCursor;
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    vi.spyOn(IDBIndex.prototype, "openKeyCursor").mockImplementation(function (this: IDBIndex) {
      const request = openKeyCursor.call(this);
      request.addEventListener("success", () => this.objectStore.transaction.abort());
      return request;
    });
    await expect(listReferences()).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the database if starting a transaction throws", async () => {
    await saveReference(reference);
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => { throw new Error("transaction unavailable"); });
    await expect(deleteReference("first")).rejects.toThrow("transaction unavailable");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports denied storage rather than leaving the operation pending", async () => {
    vi.spyOn(IDBFactory.prototype, "open").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    await expect(listReferences()).rejects.toMatchObject({ name: "SecurityError" });
  });
});

async function legacy(records = [reference]): Promise<IDBDatabase> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tonemirror", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("references", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Fixture open failed"));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("references", "readwrite");
    for (const { pcm, ...metadata } of records) tx.objectStore("references").put({ ...metadata, pcmBuffer: new Float32Array(pcm).buffer });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Fixture write failed"));
  });
  return db;
}

it("upgrades existing recordings without rewriting their records or loading PCM to list them", async () => {
  (await legacy([reference, { ...reference, id: "second", synthetic: true, createdAt: 2 }])).close();
  const put = vi.spyOn(IDBObjectStore.prototype, "put");
  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  const get = vi.spyOn(IDBObjectStore.prototype, "get");
  expect((await listReferences()).map(r => r.id)).toEqual(["second", "first"]);
  expect(put).not.toHaveBeenCalled();
  expect(getAll).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(await getReference("first")).toEqual(reference);
  expect((await getReference("second"))!.synthetic).toBe(true);
  expect(get).toHaveBeenCalledTimes(2);
});

it("an aborted upgrade keeps version-1 audio intact and can be retried", async () => {
  (await legacy()).close();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const createIndex = IDBObjectStore.prototype.createIndex;
  const fail = vi.spyOn(IDBObjectStore.prototype, "createIndex").mockImplementation(function (this: IDBObjectStore, ...args) {
    const index = createIndex.apply(this, args);
    this.transaction.abort();
    return index;
  });
  await expect(listReferences()).rejects.toThrow();
  fail.mockRestore();
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tonemirror", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Fixture open failed"));
  });
  expect(old.version).toBe(1);
  old.close();
  expect(await getReference("first")).toEqual(reference);
  expect(await listReferences()).toHaveLength(1);
});

it("a blocked upgrade rejects, closes its abandoned open, and allows a later retry", async () => {
  const old = await legacy();
  await expect(listReferences()).rejects.toThrow("another tab");
  old.close();
  expect(await listReferences()).toHaveLength(1);
  expect(await getReference("first")).toEqual(reference);
});

it("missing indexable metadata cannot silently hide a stored recording", async () => {
  (await legacy([{ ...reference, createdAt: NaN }])).close();
  await expect(listReferences()).rejects.toThrow("stored recordings have been kept");
  expect((await getReference("first"))!.pcm).toEqual(reference.pcm);
});

it("malformed stored audio rejects the read without hanging or hiding the library entry", async () => {
  const db = await legacy();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("references", "readwrite");
    const { pcm: _pcm, ...metadata } = reference;
    tx.objectStore("references").put({ ...metadata, pcmBuffer: new ArrayBuffer(3) });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Fixture write failed"));
  });
  db.close();
  expect(await listReferences()).toHaveLength(1);
  await expect(getReference("first")).rejects.toBeInstanceOf(RangeError);
});

it("a cancelled single-record read returns no audio and leaves the stored recording available", async () => {
  await saveReference(reference);
  const controller = new AbortController();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const get = IDBObjectStore.prototype.get;
  const delayed = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = get.call(this, key);
    request.addEventListener("success", () => controller.abort());
    return request;
  });
  await expect(getReference("first", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  delayed.mockRestore();
  expect(await getReference("first")).toEqual(reference);
});

it("cancellation before opening the library does not touch storage", async () => {
  const open = vi.spyOn(IDBFactory.prototype, "open");
  const controller = new AbortController();
  controller.abort();
  await expect(getReference("first", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(open).not.toHaveBeenCalled();
});
