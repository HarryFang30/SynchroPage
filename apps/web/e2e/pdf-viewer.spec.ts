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

test.describe("PDF Viewer keeps its place when the pane resizes", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("opening and closing the assistant panel does not move the reader to another page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await uploadPdfFromRail(page, "eight-page.pdf");
    await expect(page.locator(".pdf-page-shell")).toHaveCount(8, { timeout: 15_000 });
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);

    // Put the 50% line three quarters of the way down page 3.
    const measure = async () => page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".pdf-js-viewer")!;
      const rootRect = root.getBoundingClientRect();
      const anchorY = rootRect.top + rootRect.height * 0.5;
      const shells = Array.from(document.querySelectorAll<HTMLElement>(".pdf-page-shell"));
      const hit = shells.find((shell) => {
        const rect = shell.getBoundingClientRect();
        return rect.top <= anchorY && rect.bottom >= anchorY;
      });
      const rect = hit?.getBoundingClientRect();
      return {
        reported: document.querySelector(".topbar-page-nav output")?.textContent?.trim() || "",
        scrollTop: root.scrollTop,
        anchorPage: Number(hit?.dataset.pageContainerNumber || 0),
        fraction: rect ? (anchorY - rect.top) / rect.height : -1,
        pageHeight: rect?.height || 0,
      };
    });
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".pdf-js-viewer")!;
      const shell = document.querySelector<HTMLElement>('.pdf-page-shell[data-page-container-number="3"]')!;
      const rootRect = root.getBoundingClientRect();
      const rect = shell.getBoundingClientRect();
      root.scrollTop = root.scrollTop + rect.top - rootRect.top + rect.height * 0.75 - rootRect.height * 0.5;
    });
    await expect(page.locator(".topbar-page-nav output")).toContainText("3 / 8", { timeout: 10_000 });
    await page.waitForTimeout(400);
    const before = await measure();
    expect(before.anchorPage).toBe(3);

    await page.getByRole("button", { name: /显示助手|Show assistant/ }).click();
    await page.waitForTimeout(1_200);
    const shown = await measure();
    expect(shown.reported).toBe("3 / 8");
    expect(shown.anchorPage).toBe(3);
    expect(shown.pageHeight).toBeLessThan(before.pageHeight);
    expect(Math.abs(shown.fraction - before.fraction)).toBeLessThan(0.05);

    await page.getByRole("button", { name: /隐藏助手|Hide assistant/ }).click();
    await page.waitForTimeout(1_200);
    const hidden = await measure();
    expect(hidden.reported).toBe("3 / 8");
    expect(Math.abs(hidden.scrollTop - before.scrollTop)).toBeLessThan(3);
  });

  test("a page jump that is still animating lands on the requested page when the assistant opens", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await uploadPdfFromRail(page, "eight-page.pdf");
    await expect(page.locator(".pdf-page-shell")).toHaveCount(8, { timeout: 15_000 });
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);

    await page.locator(".pdf-js-viewer").focus();
    await page.keyboard.press("End");
    await page.waitForTimeout(120);
    await page.getByRole("button", { name: /显示助手|Show assistant/ }).click();
    await expect(page.locator(".topbar-page-nav output")).toContainText("8 / 8", { timeout: 10_000 });
    await page.waitForTimeout(800);
    await expect(page.locator(".topbar-page-nav output")).toContainText("8 / 8");
  });

  test("the saved page is restored after a reload even if a panel opens during the restore", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await uploadPdfFromRail(page, "eight-page.pdf");
    await expect(page.locator(".pdf-page-shell")).toHaveCount(8, { timeout: 15_000 });
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);
    for (let step = 0; step < 4; step += 1) {
      await page.locator(".topbar-page-nav").getByRole("button", { name: /下一页|Next page/i }).click();
      await page.waitForTimeout(700);
    }
    await expect(page.locator(".topbar-page-nav output")).toContainText("5 / 8", { timeout: 10_000 });
    await page.waitForTimeout(1_500);

    await page.reload();
    await expect(page.locator(".pdf-page-shell").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: /显示助手|Show assistant/ }).click();
    await page.waitForTimeout(1_500);
    await expect(page.locator(".topbar-page-nav output")).toContainText("5 / 8");
    const anchorPage = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".pdf-js-viewer")!;
      const rootRect = root.getBoundingClientRect();
      const anchorY = rootRect.top + rootRect.height * 0.5;
      const hit = Array.from(document.querySelectorAll<HTMLElement>(".pdf-page-shell")).find((shell) => {
        const rect = shell.getBoundingClientRect();
        return rect.top <= anchorY && rect.bottom >= anchorY;
      });
      return Number(hit?.dataset.pageContainerNumber || 0);
    });
    expect(anchorPage).toBe(5);
  });
});
