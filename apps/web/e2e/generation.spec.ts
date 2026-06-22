import { test, expect } from "@playwright/test";
import { resetStorage, mockApi, uploadPdfFromRail } from "./helpers";

test.describe("Teaching Generation (mocked)", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
    // Mock all API calls including generation endpoints
    await mockApi(page, {
      "/api/generate/page": {
        page: {
          page_no: 1,
          teaching: {
            slide_title: "Mocked Slide",
            speaker_notes_md: "These are mocked teaching notes for page 1.",
            confidence: 0.9,
            concepts: ["concept A", "concept B"],
            output_language: "zh-CN",
          },
          status: "completed",
        },
      },
      "/api/generate/pages": {
        pages: [
          {
            page_no: 1,
            teaching: {
              slide_title: "Mocked Page 1",
              speaker_notes_md: "Mocked notes for page 1.",
              confidence: 0.85,
              concepts: ["concept 1"],
              output_language: "zh-CN",
            },
            status: "completed",
          },
          {
            page_no: 2,
            teaching: {
              slide_title: "Mocked Page 2",
              speaker_notes_md: "Mocked notes for page 2.",
              confidence: 0.88,
              concepts: ["concept 2"],
              output_language: "zh-CN",
            },
            status: "completed",
          },
        ],
      },
    });
  });

  test("generate button exists in toolbar", async ({ page }) => {
    await expect(page.locator(".generate-main-button")).toBeVisible();
    await expect(page.locator(".generate-menu-button")).toBeVisible();
  });

  test("notes pane exists in layout", async ({ page }) => {
    await expect(page.locator(".notes-pane")).toBeVisible();
    await expect(page.locator(".notes-content")).toBeVisible();
  });

  test("upload PDF then mock generate updates notes content", async ({ page }) => {
    await uploadPdfFromRail(page);

    await page.locator(".generate-main-button").click();

    const notes = page.locator(".notes-content");
    await expect(notes).toContainText(/Mocked notes|mocked teaching notes/i, { timeout: 10_000 });
    await page.locator(".generation-progress-trigger").click();
    await expect(page.locator(".generation-details-popover")).toContainText(/1\/2|1\s*\/\s*2/, { timeout: 10_000 });
    await expect(page.locator(".generation-details-popover")).toContainText(/已生成|Generated/i);
  });

  test("transient single-page failure is auto-retried", async ({ page }) => {
    await uploadPdfFromRail(page);
    await page.unroute("**/api/**");

    const pageCalls = new Map<number, number>();
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/pages")) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ message: "HTTP 502" }),
        });
        return;
      }
      if (url.includes("/api/generate/page")) {
        const body = JSON.parse(route.request().postData() || "{}") as { page?: { page_no?: number } };
        const pageNo = Number(body.page?.page_no || 1);
        const calls = (pageCalls.get(pageNo) || 0) + 1;
        pageCalls.set(pageNo, calls);
        if (calls === 1) {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ message: "HTTP 502" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            page: {
              page_no: pageNo,
              teaching: {
                slide_title: `Recovered Page ${pageNo}`,
                speaker_notes_md: `Recovered notes for page ${pageNo}.`,
                confidence: 0.9,
                concepts: [`retry-${pageNo}`],
                output_language: "zh-CN",
              },
              status: "completed",
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator(".generate-main-button").click();

    await expect(page.locator(".notes-content")).toContainText(/Recovered notes for page/i, { timeout: 15_000 });
    await expect.poll(() => Math.max(...pageCalls.values())).toBeGreaterThan(1);
  });

  test("stalled single-page request is aborted and retried", async ({ page }) => {
    test.setTimeout(45_000);
    await uploadPdfFromRail(page);
    await page.unroute("**/api/**");

    const pageCalls = new Map<number, number>();
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/pages")) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ message: "HTTP 502" }),
        });
        return;
      }
      if (url.includes("/api/generate/page")) {
        const body = JSON.parse(route.request().postData() || "{}") as { page?: { page_no?: number } };
        const pageNo = Number(body.page?.page_no || 1);
        const calls = (pageCalls.get(pageNo) || 0) + 1;
        pageCalls.set(pageNo, calls);
        if (pageNo === 1 && calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 21_500));
          await route.abort("timedout").catch(() => undefined);
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            page: {
              page_no: pageNo,
              teaching: {
                slide_title: `Recovered Page ${pageNo}`,
                speaker_notes_md: `Recovered after stall for page ${pageNo}.`,
                confidence: 0.9,
                concepts: [`stall-retry-${pageNo}`],
                output_language: "zh-CN",
              },
              status: "completed",
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator(".generate-main-button").click();

    await expect(page.locator(".notes-content")).toContainText(/Recovered after stall for page 1/i, { timeout: 35_000 });
    await expect.poll(() => pageCalls.get(1) || 0).toBeGreaterThan(1);
  });

  test("structure panel tab exists", async ({ page }) => {
    await expect(page.locator(".tab-group")).toBeVisible();
    await expect(page.locator(".tab-button")).toHaveCount(3);
  });

  test("generation details popover opens from the progress control", async ({ page }) => {
    await page.locator(".generation-progress-trigger").click();
    await expect(page.locator(".generation-details-popover")).toBeVisible();
    await expect(page.locator(".generation-details-popover")).toContainText(/生成情况|Generation status/i);
  });
});
