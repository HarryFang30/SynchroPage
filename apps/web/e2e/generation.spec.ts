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

  test("stalled batch request falls back to single-page generation", async ({ page }) => {
    test.setTimeout(15_000);
    const textPack = {
      document: {
        id: "batch-text-doc",
        title: "Batch Text Fixture",
        source_pdf_url: "",
        page_count: 3,
      },
      pages: Array.from({ length: 3 }, (_, index) => {
        const pageNo = index + 1;
        return {
          page_no: pageNo,
          source: {
            pdf_page_ref: `#page=${pageNo}`,
            text_md: `Batch text source page ${pageNo}. This page has enough plain text to use the fast text generation path. It avoids diagrams, tables, code, and formulas so the batch endpoint is selected during one-click generation.`,
            ocr_used: false,
            parser: "test",
          },
          teaching: {
            output_language: "zh-CN",
            slide_title: "",
            speaker_notes_md: "",
            concepts: [],
            visual_explanations: [],
            prerequisites: [],
            contextual_bridge: "",
            formula_explanations: [],
            evidence: [],
            needs_review: false,
            needs_parser_fallback: false,
            confidence: 0,
          },
          status: "draft",
        };
      }),
    };
    await page.locator('input[type="file"][accept="application/json,.json"]').first().setInputFiles({
      name: "batch-text-fixture.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(textPack)),
    });
    await expect(page.locator(".brand")).toContainText("Batch Text Fixture", { timeout: 10_000 });
    await page.evaluate(() => {
      (window as Window & { __SYNCHROPAGE_GENERATION_BATCH_STALL_TIMEOUT_MS?: number }).__SYNCHROPAGE_GENERATION_BATCH_STALL_TIMEOUT_MS = 250;
    });
    await page.unroute("**/api/**");

    let batchCalls = 0;
    const pageCalls = new Map<number, number>();
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/pages")) {
        batchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ pages: [] }),
        }).catch(() => undefined);
        return;
      }
      if (url.includes("/api/generate/page")) {
        const body = JSON.parse(route.request().postData() || "{}") as { page?: { page_no?: number } };
        const pageNo = Number(body.page?.page_no || 1);
        pageCalls.set(pageNo, (pageCalls.get(pageNo) || 0) + 1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            page: {
              page_no: pageNo,
              teaching: {
                slide_title: `Fallback Page ${pageNo}`,
                speaker_notes_md: `Fallback single-page notes for page ${pageNo}. The batch request stalled, so this page was generated individually with enough detail to avoid weak-output retry.`,
                confidence: 0.9,
                concepts: [`fallback-${pageNo}`],
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

    await expect(page.locator(".notes-content")).toContainText(/Fallback single-page notes for page/i, { timeout: 10_000 });
    await expect.poll(() => batchCalls).toBe(1);
    await expect.poll(() => Array.from(pageCalls.values()).reduce((sum, calls) => sum + calls, 0)).toBeGreaterThan(0);
  });

  test("slow successful single-page request is not aborted at the old stall threshold", async ({ page }) => {
    test.setTimeout(40_000);
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
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            page: {
              page_no: pageNo,
              teaching: {
                slide_title: `Slow Page ${pageNo}`,
                speaker_notes_md: `Slow successful notes for page ${pageNo}. This response intentionally arrives after the old twenty second stall threshold, but it is still a healthy generation result with enough detail to avoid the weak-output retry path.`,
                confidence: 0.9,
                concepts: [`slow-${pageNo}`],
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

    await expect(page.locator(".notes-content")).toContainText(/Slow successful notes for page 1/i, { timeout: 30_000 });
    await expect.poll(() => pageCalls.get(1) || 0).toBe(1);
  });

  test("network-aborted single-page request is retried", async ({ page }) => {
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
