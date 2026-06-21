import { expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

export const DB_NAME = "synchropage-reader";
export const LS_KEYS = ["synchropage.lastWorkspaceId.v1", "synchropage.uiPreferences.v1"];

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

export async function openRailActionMenu(page: Page) {
  const menuButton = page.locator(".rail-header-actions .rail-icon-button").first();
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await expect(page.locator(".rail-action-menu")).toBeVisible();
}

export async function createCourse(page: Page, name: string) {
  await openRailActionMenu(page);
  await page.getByRole("menuitem", { name: /新建课程|New course/i }).click();
  const dialog = page.locator(".course-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("input").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.locator(".course-item").filter({ hasText: name })).toBeVisible();
}

export async function uploadPdfFromRail(page: Page, fileName = "two-page.pdf") {
  await openRailActionMenu(page);
  const pdfInput = page.locator('.rail-action-menu input[type="file"][accept="application/pdf"]');
  await expect(pdfInput).toHaveCount(1);
  await pdfInput.setInputFiles(fixturePath(fileName));
  await expect(page.locator(".document-item").filter({ hasText: "two-page" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".pdf-pane")).toContainText(/PDF|Source|来源/i, { timeout: 10_000 });
}

export async function activateAgent(page: Page) {
  let panel = page.locator(".agent-panel");
  if ((await panel.count()) === 0) {
    await page.getByRole("button", { name: /显示助手|Show assistant/i }).click();
    panel = page.locator(".agent-panel");
  }
  await expect(panel).toBeVisible();
  await panel.hover();
  const composer = page.locator(".aui-composer-input");
  await expect(composer).toBeVisible({ timeout: 10_000 });
  return composer;
}
