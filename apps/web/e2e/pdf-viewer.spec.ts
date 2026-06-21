import { test, expect } from "@playwright/test";
import { resetStorage, uploadPdfFromRail } from "./helpers";

test.describe("PDF Viewer", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("page navigator exists in DOM", async ({ page }) => {
    // Page navigator shows in topbar even without a loaded PDF
    const pageNav = page.locator(".page-navigator, .page-nav");
    const navCount = await pageNav.count();
    // Navigator should exist in the layout
    expect(navCount).toBeGreaterThan(0);
  });

  test("pdf pane is present in layout", async ({ page }) => {
    const pdfPane = page.locator(".pdf-pane");
    // PDF pane should exist in the DOM
    const paneCount = await pdfPane.count();
    expect(paneCount).toBeGreaterThan(0);
  });

  test("uploading a PDF renders pages", async ({ page }) => {
    await uploadPdfFromRail(page);

    await expect(page.locator(".pdf-js-viewer")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".pdf-page-stack")).toBeVisible();
    await expect(page.locator(".pdf-page-shell")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 10_000 });
  });

  test("prev/next page buttons exist in topbar", async ({ page }) => {
    const prevBtn = page.getByRole("button", { name: /上一页|prev/i });
    const nextBtn = page.getByRole("button", { name: /下一页|next/i });

    await expect(prevBtn.first()).toBeVisible();
    await expect(nextBtn.first()).toBeVisible();
  });

  test("next page navigation scrolls and updates the active page number", async ({ page }) => {
    await uploadPdfFromRail(page);
    await expect(page.locator(".topbar-page-nav output")).toContainText("1 / 2", { timeout: 10_000 });

    await page.locator(".topbar-page-nav").getByRole("button", { name: /下一页|Next page/i }).click();

    await expect(page.locator(".topbar-page-nav output")).toContainText("2 / 2", { timeout: 10_000 });
  });
});
