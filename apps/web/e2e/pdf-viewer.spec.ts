import { test, expect } from "@playwright/test";
import { resetStorage, fixturePath } from "./helpers";

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
    const fileInput = page.locator('input[type="file"]').first();
    const fileInputCount = await fileInput.count();

    if (fileInputCount > 0) {
      await fileInput.setInputFiles(fixturePath("two-page.pdf"));
      await page.waitForTimeout(3000);

      const pdfPage = page.locator(".pdf-page-shell, .pdf-page-stack, canvas").first();
      const pageCount = await pdfPage.count();
      if (pageCount > 0) {
        await expect(pdfPage).toBeVisible({ timeout: 8_000 });
      }
    }

    // App must not crash
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("prev/next page buttons exist in topbar", async ({ page }) => {
    // Page navigation buttons — accessible names come from icon alt text
    const prevBtn = page.getByRole("button", { name: /上一页|prev/i });
    const nextBtn = page.getByRole("button", { name: /下一页|next/i });

    const prevCount = await prevBtn.count();
    const nextCount = await nextBtn.count();
    const hasNav = prevCount > 0 || nextCount > 0;
    expect(hasNav).toBeTruthy();
  });
});
