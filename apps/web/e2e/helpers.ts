import { expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

export const DB_NAME = "synchropage-reader";
export const LS_KEYS = [
  "synchropage.lastWorkspaceId.v1",
  "synchropage.uiPreferences.v1",
  "synchropage.quizWeakPoints.v1",
  "synchropage.generationWindow.v1",
  "synchropage.annotationColor.v1",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The Vite proxy forwards /api and /auth to whatever listens on 127.0.0.1:8765.
 * A developer's running backend (desktop app, manual server) must never leak
 * its real provider config or OAuth state into the tests, so the two requests
 * the app makes on load are answered with an empty object before the first
 * navigation. Test-specific api route handlers registered later take
 * precedence for everything else.
 */
async function isolateBackendOnLoad(page: Page) {
  await page.route("**/api/model-config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/auth/openai/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

/** Drop IndexedDB and clear localStorage before each test. */
export async function resetStorage(page: Page) {
  await isolateBackendOnLoad(page);
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
  const documentTitle = fileName.replace(/\.pdf$/i, "");
  await expect(page.locator(".document-item").filter({ hasText: documentTitle })).toBeVisible({ timeout: 10_000 });
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
