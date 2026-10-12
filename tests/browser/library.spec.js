import { test, expect } from "@playwright/test";

async function seedLegacy(page, hold = false) {
  await page.route("**/_library-seed.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Storage fixture</title>",
    }),
  );
  await page.goto("./_library-seed.html");
  await page.evaluate(async (hold) => {
    const db = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open("tonemirror", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("references", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("references", "readwrite");
      for (const [i, name] of [
        "First recording",
        "Second recording",
      ].entries()) {
        const pcm = new Float32Array(22050 / 2);
        for (let n = 0; n < pcm.length; n++)
          pcm[n] = 0.2 * Math.sin((2 * Math.PI * (180 + i * 20) * n) / 22050);
        tx.objectStore("references").put({
          id: String(i),
          name,
          category: "user",
          synthetic: true,
          pcmBuffer: pcm.buffer,
          sampleRate: 22050,
          createdAt: i,
        });
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    if (hold) window.legacyConnection = db;
    else db.close();
  }, hold);
}

async function holdReads(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = window.indexedDB.open("tonemirror");
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction("references", "readwrite");
    let hold = true;
    const keep = () => {
      const r = tx.objectStore("references").count();
      r.onsuccess = () => {
        if (hold) keep();
      };
    };
    keep();
    window.releaseLibraryReads = () => {
      hold = false;
    };
    tx.oncomplete = () => db.close();
  });
}

const item = (page, name) =>
  page.locator(".tm-library-item").filter({ hasText: name });
const label = (page) => page.locator(".tm-clip-label");

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("libraryPageErrors", () => errors);
  await page.addInitScript(() => {
    window.audioReads = [];
    for (const method of ["get", "getAll"]) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        const r = original.apply(this, args);
        r.addEventListener("success", () => {
          const rows = Array.isArray(r.result) ? r.result : [r.result];
          window.audioReads.push({
            method,
            bytes: rows.reduce(
              (sum, row) => sum + (row?.pcmBuffer?.byteLength ?? 0),
              0,
            ),
          });
        });
        return r;
      };
    }
  });
});
test.afterEach(async ({ page }) =>
  expect(await page.evaluate(() => window.libraryPageErrors())).toEqual([]),
);

test("upgraded legacy references browse without PCM reads and load only the chosen recording offline", async ({
  page,
  context,
}) => {
  await seedLegacy(page);
  await page.goto("./");
  await expect(page.locator(".tm-library-item")).toHaveCount(2);
  expect(await page.evaluate(() => window.audioReads)).toEqual([]);
  await context.setOffline(true);
  await item(page, "First recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await expect(label(page)).toContainText("First recording (synthetic)");
  expect(await page.evaluate(() => window.audioReads)).toEqual([
    { method: "get", bytes: 44100 },
  ]);
  await item(page, "Second recording")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.locator(".tm-library-item")).toHaveCount(1);
  expect(await page.evaluate(() => window.audioReads)).toEqual([
    { method: "get", bytes: 44100 },
  ]);
});

test("cancel and a newer Use selection cannot receive an older queued read", async ({
  page,
}) => {
  await seedLegacy(page);
  await page.goto("./");
  await item(page, "First recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await expect(label(page)).toContainText("First recording");
  await holdReads(page);
  await item(page, "Second recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel work", exact: true }).click();
  await page.evaluate(() => window.releaseLibraryReads());
  await expect(page.locator(".tm-status")).toContainText("Cancelled");
  await expect(label(page)).toContainText("First recording");
  await holdReads(page);
  await item(page, "First recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await item(page, "Second recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await page.evaluate(() => window.releaseLibraryReads());
  await expect(label(page)).toContainText("Second recording");
});

test("a recording deleted elsewhere preserves the previous clip and exposes a library refresh", async ({
  page,
}) => {
  await seedLegacy(page);
  await page.goto("./");
  await item(page, "First recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await expect(label(page)).toContainText("First recording");
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = window.indexedDB.open("tonemirror");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("references", "readwrite");
      tx.objectStore("references").delete("1");
      tx.oncomplete = resolve;
    });
    db.close();
  });
  await item(page, "Second recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await expect(page.locator(".tm-status")).toContainText("no longer available");
  await expect(label(page)).toContainText("First recording");
  await page
    .getByRole("button", { name: "Retry saved references", exact: true })
    .click();
  await expect(page.locator(".tm-library-item")).toHaveCount(1);
});

test("a legacy connection blocks the upgrade honestly and retry preserves recordings after it closes", async ({
  page,
  context,
}) => {
  const old = await context.newPage();
  await seedLegacy(old, true);
  await page.goto("./");
  await expect(
    page.getByRole("button", { name: "Retry saved references", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/reference library is busy in another tab/),
  ).toBeVisible();
  await old.evaluate(() => window.legacyConnection.close());
  await page
    .getByRole("button", { name: "Retry saved references", exact: true })
    .click();
  await expect(page.locator(".tm-library-item")).toHaveCount(2);
  await item(page, "First recording")
    .getByRole("button", { name: "Use", exact: true })
    .click();
  await expect(label(page)).toContainText("First recording");
  await old.close();
});
