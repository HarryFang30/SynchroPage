import { test, expect } from "@playwright/test";
import { resetStorage } from "./helpers";

test.describe("Smoke", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("app shell renders", async ({ page }) => {
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("topbar is visible with brand", async ({ page }) => {
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.locator(".brand")).toBeVisible();
  });

  test("settings button opens settings dialog", async ({ page }) => {
    await page.locator(".rail-settings-button").click();
    await expect(page.locator(".settings-overlay")).toBeVisible();
    await expect(page.locator(".settings-dialog")).toBeVisible();
    await expect(page.locator(".settings-nav-item")).toHaveCount(9);
    await expect(page.locator(".settings-nav")).toContainText(/Provider|模型|Models|服务/i);
  });

  test("desktop save folder settings stay inside the dialog with long paths", async ({ page }) => {
    await page.setViewportSize({ width: 1220, height: 720 });
    await page.addInitScript(() => {
      const config = {
        available: true,
        currentDataDir: "/Users/harry/Library/Application Support/synchropage-current-data-folder-with-a-very-long-name",
        configuredDataDir: "/Users/harry/Library/Application Support/SynchroPage Next Workspace Folder",
        pendingDataDir: "/Users/harry/Library/Application Support/SynchroPage Next Workspace Folder",
        backendDataDir: "/Users/harry/Library/Application Support/synchropage-current-data-folder-with-a-very-long-name/backend",
        oauthStoragePath: "/Users/harry/Library/Application Support/synchropage-current-data-folder-with-a-very-long-name/backend/openai_oauth.json",
        configPath: "/Users/harry/Library/Application Support/SynchroPage/desktop-config.json",
        dataDirManagedByEnv: false,
        restartRequired: true,
      };
      (window as unknown as {
        synchropageDesktop: {
          getStorageConfig: () => Promise<typeof config>;
          chooseDataDirectory: () => Promise<typeof config>;
          resetDataDirectory: () => Promise<typeof config>;
          restart: () => Promise<{ ok: true }>;
        };
      }).synchropageDesktop = {
        getStorageConfig: async () => config,
        chooseDataDirectory: async () => config,
        resetDataDirectory: async () => config,
        restart: async () => ({ ok: true }),
      };
    });
    await resetStorage(page);

    await page.locator(".rail-settings-button").click();
    await page.locator(".settings-nav-item").filter({ hasText: /存储|Storage/i }).click();

    const dialog = page.locator(".settings-dialog");
    const directoryRow = page.locator(".settings-row-directory");
    await expect(directoryRow).toBeVisible();
    await expect(directoryRow).toContainText(/当前目录|Current folder/i);
    await expect(directoryRow).toContainText(/重启后目录|After restart/i);
    await expect(page.getByRole("button", { name: /重启应用|Restart app/i })).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    const rowBox = await directoryRow.boundingBox();
    const actionsBox = await directoryRow.locator(".settings-directory-actions").boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1);
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1);
  });

  test("command menu opens and shows actions", async ({ page }) => {
    await page.locator(".command-menu > .mini-button").click();
    const menu = page.locator(".command-menu-popover");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button")).toHaveCount(4);
    await expect(menu).toContainText(/OpenAI|OAuth/i);
  });

  test("theme data attributes are initialized", async ({ page }) => {
    const html = page.locator("html");
    const initialTheme = await html.getAttribute("data-synchropage-resolved-theme");
    expect(["light", "dark"]).toContain(initialTheme);
  });
});
