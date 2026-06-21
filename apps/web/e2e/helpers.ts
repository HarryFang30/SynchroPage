import { type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

export const DB_NAME = "pagepair-reader";
export const LS_KEYS = ["pagepair.lastWorkspaceId.v1", "pagepair.uiPreferences.v1"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Drop IndexedDB and clear localStorage before each test. */
export async function resetStorage(page: Page) {
  await page.goto("/");
  await page.evaluate(
    ({ dbName, lsKeys }) => {
      for (const key of lsKeys) {
        window.localStorage.removeItem(key);
      }
      return new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    },
    { dbName: DB_NAME, lsKeys: LS_KEYS },
  );
  await page.reload();
  await page.waitForSelector(".app-shell", { timeout: 10_000 });
}

/** Mock all /api/* calls to return a controlled response. */
export async function mockApi(page: Page, handlers?: Record<string, object>) {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (handlers) {
      for (const [apiPath, response] of Object.entries(handlers)) {
        if (url.includes(apiPath)) {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
          return;
        }
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

/** Read a fixture file as a Buffer for upload. */
export function fixturePath(name: string): string {
  return path.resolve(__dirname, "fixtures", name);
}

export function readFixture(name: string): Buffer {
  return fs.readFileSync(fixturePath(name));
}
