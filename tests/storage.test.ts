import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { deleteReference, listReferences, saveReference, type StoredReference } from "../src/storage/db.js";

const reference: StoredReference = {
  id: "first", name: "A reference", category: "user", synthetic: false,
  pcm: new Float32Array([0.25, -0.5]), sampleRate: 22050, createdAt: 1,
};

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("local reference storage", () => {
  it("round-trips owned PCM, orders recent references first, and deletes", async () => {
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    await saveReference(reference);
    await saveReference({ ...reference, id: "second", createdAt: 2 });
    const records = await listReferences();
    expect(records.map((record) => record.id)).toEqual(["second", "first"]);
    expect(records[1]!.pcm).toEqual(reference.pcm);
    records[1]!.pcm.fill(0);
    expect((await listReferences())[1]!.pcm).toEqual(reference.pcm);
    await deleteReference("first");
    expect((await listReferences()).map((record) => record.id)).toEqual(["second"]);
    expect(close).toHaveBeenCalledTimes(6);
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

  it("rejects aborted reads even after getAll succeeded", async () => {
    await saveReference(reference);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getAll = IDBObjectStore.prototype.getAll;
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore) {
      const request = getAll.call(this);
      request.addEventListener("success", () => this.transaction.abort());
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
