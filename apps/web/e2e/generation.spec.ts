import { test, expect } from "@playwright/test";
import { resetStorage, mockApi, uploadPdfFromRail } from "./helpers";

type TeachingRequestBody = {
  reasoningEffort?: string;
  qualityPlan?: { attachPdf?: boolean; reasoningEffort?: string };
  page?: { page_no?: number };
  pages?: Array<{ page_no?: number }>;
};

/** Plain-text page pack that routes one-click generation through the batch endpoint. */
function buildTextPack(id: string, title: string, pageCount = 3) {
  return {
    document: { id, title, source_pdf_url: "", page_count: pageCount },
    pages: Array.from({ length: pageCount }, (_, index) => {
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
}

async function loadTextPack(page: import("@playwright/test").Page, pack: ReturnType<typeof buildTextPack>) {
  await page.locator('input[type="file"][accept="application/json,.json"]').first().setInputFiles({
    name: "text-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(pack)),
  });
  await expect(page.locator(".brand")).toContainText(pack.document.title, { timeout: 10_000 });
}

/** Long enough that generatedTeachingNeedsRetry() never fires on the mock. */
function mockNotes(label: string, pageNo: number) {
  return `${label} for page ${pageNo}. These mocked notes are deliberately long enough to stay above the weak-output retry threshold so the test exercises only the path it is about.`;
}

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
    // The page header carries the slide title and the concept tags.
    await expect(notes.locator(".note-title")).toContainText(/Mocked/);
    await expect(notes.locator(".note-concept").first()).toBeVisible();
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

  test("batch response without any page falls back to single-page generation", async ({ page }) => {
    test.setTimeout(20_000);
    await loadTextPack(page, buildTextPack("batch-text-doc", "Batch Text Fixture"));
    // Only shortens the informational "still generating" notice now; it no
    // longer aborts the request.
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

  test("rate-limited page request is retried after the Retry-After cooldown", async ({ page }) => {
    test.setTimeout(60_000);
    await loadTextPack(page, buildTextPack("rate-limit-doc", "Rate Limit Fixture", 2));
    await page.unroute("**/api/**");

    const pageCalls = new Map<number, number>();
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/pages")) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "network_error", message: "upstream reset" }),
        });
        return;
      }
      if (url.includes("/api/generate/page")) {
        const body = JSON.parse(route.request().postData() || "{}") as TeachingRequestBody;
        const pageNo = Number(body.page?.page_no || 1);
        const calls = (pageCalls.get(pageNo) || 0) + 1;
        pageCalls.set(pageNo, calls);
        if (calls === 1) {
          // Typed 429: no "rate limit" words anywhere in the payload, so this can
          // only be retried by classifying on status + code.
          await route.fulfill({
            status: 429,
            contentType: "application/json",
            headers: { "Retry-After": "1" },
            body: JSON.stringify({ error: "rate_limited", message: "slow down" }),
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
                slide_title: `Cooled Page ${pageNo}`,
                speaker_notes_md: mockNotes("Recovered after rate limit", pageNo),
                confidence: 0.9,
                concepts: [`cooled-${pageNo}`],
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

    await expect(page.locator(".notes-content")).toContainText(/Recovered after rate limit/i, { timeout: 45_000 });
    await expect.poll(() => pageCalls.get(1) || 0).toBeGreaterThan(1);
  });

  test("partially parsed batch regenerates only the missing pages", async ({ page }) => {
    test.setTimeout(30_000);
    await loadTextPack(page, buildTextPack("partial-batch-doc", "Partial Batch Fixture"));
    await page.unroute("**/api/**");

    let batchCalls = 0;
    const pageCalls = new Map<number, number>();
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/pages")) {
        batchCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            pages: [
              {
                page_no: 1,
                teaching: {
                  slide_title: "Batch Page 1",
                  speaker_notes_md: mockNotes("Batch committed notes", 1),
                  confidence: 0.9,
                  concepts: ["batch-1"],
                  output_language: "zh-CN",
                },
                status: "completed",
              },
            ],
            missing: [2, 3],
          }),
        });
        return;
      }
      if (url.includes("/api/generate/page")) {
        const body = JSON.parse(route.request().postData() || "{}") as TeachingRequestBody;
        const pageNo = Number(body.page?.page_no || 1);
        pageCalls.set(pageNo, (pageCalls.get(pageNo) || 0) + 1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            page: {
              page_no: pageNo,
              teaching: {
                slide_title: `Single Page ${pageNo}`,
                speaker_notes_md: mockNotes("Regenerated missing notes", pageNo),
                confidence: 0.9,
                concepts: [`missing-${pageNo}`],
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

    await expect(page.locator(".notes-content")).toContainText(/Batch committed notes for page 1/i, { timeout: 15_000 });
    await expect.poll(() => pageCalls.get(2) || 0, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => pageCalls.get(3) || 0, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(batchCalls).toBe(1);
    // The page the batch did return must never be re-requested singly.
    expect(pageCalls.get(1) || 0).toBe(0);
  });

  test("transport failure retries with the same plan instead of escalating to a PDF request", async ({ page }) => {
    test.setTimeout(30_000);
    await loadTextPack(page, buildTextPack("no-escalation-doc", "No Escalation Fixture", 2));
    await page.unroute("**/api/**");

    const pageRequests: TeachingRequestBody[] = [];
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/pages")) {
        await route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({ error: "upstream_timeout", message: "gateway deadline" }),
        });
        return;
      }
      if (url.includes("/api/generate/page")) {
        const body = JSON.parse(route.request().postData() || "{}") as TeachingRequestBody;
        pageRequests.push(body);
        const pageNo = Number(body.page?.page_no || 1);
        const attempts = pageRequests.filter((item) => Number(item.page?.page_no || 1) === pageNo).length;
        if (attempts === 1) {
          await route.fulfill({
            status: 504,
            contentType: "application/json",
            body: JSON.stringify({ error: "upstream_timeout", message: "gateway deadline" }),
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
                slide_title: `Steady Page ${pageNo}`,
                speaker_notes_md: mockNotes("Steady retry notes", pageNo),
                confidence: 0.9,
                concepts: [`steady-${pageNo}`],
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

    await expect(page.locator(".notes-content")).toContainText(/Steady retry notes/i, { timeout: 25_000 });
    const pageOneRequests = pageRequests.filter((item) => Number(item.page?.page_no || 1) === 1);
    expect(pageOneRequests.length).toBeGreaterThan(1);
    const [first, second] = pageOneRequests;
    expect(second.qualityPlan?.attachPdf).toBe(false);
    expect(second.reasoningEffort).toBe(first.reasoningEffort);
  });

  test("stopping generation leaves in-flight pages as drafts, not failures", async ({ page }) => {
    test.setTimeout(30_000);
    await loadTextPack(page, buildTextPack("stop-doc", "Stop Fixture"));
    await page.unroute("**/api/**");

    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/generate/")) {
        // Never answers: the run is still in flight when the user presses Stop.
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => undefined);
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    const generateButton = page.locator(".generate-main-button");
    await generateButton.click();
    await expect(generateButton).toContainText(/停止|Stop/i, { timeout: 10_000 });
    await page.locator(".generation-progress-trigger").click();
    await expect(page.locator(".generation-details-popover")).toContainText(/生成中|Running/i, { timeout: 10_000 });

    await generateButton.click();
    await expect(generateButton).not.toContainText(/停止|Stop/i, { timeout: 10_000 });

    const popover = page.locator(".generation-details-popover");
    await expect(popover).toContainText(/待生成|Pending/i);
    await expect(popover).not.toContainText(/失败|Failed/i);
    await expect(page.locator(".notes-content")).not.toContainText(/本页讲解生成失败|Page notes generation failed/i);
  });

  test("structure and JSON tabs only appear in Debug mode", async ({ page }) => {
    await expect(page.locator(".tab-group")).toBeVisible();
    // 讲解 / 笔记
    await expect(page.locator(".tab-button")).toHaveCount(2);

    await page.locator(".rail-settings-button").click();
    await page.locator(".settings-nav-item").filter({ hasText: /高级|Advanced/ }).click();
    const debugRow = page.locator(".settings-row").filter({ hasText: /Debug 模式|Debug mode/ });
    await debugRow.getByRole("switch").click();
    await expect(debugRow.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-dialog")).toHaveCount(0);
    // 讲解 / 笔记 / 结构 / JSON
    await expect(page.locator(".tab-button")).toHaveCount(4);
    await page.locator(".tab-button").filter({ hasText: /结构|Struct/ }).click();
    await expect(page.locator(".structure-grid")).toBeVisible();

    // Leaving Debug mode takes the reader back to the notes.
    await page.locator(".rail-settings-button").click();
    await page.locator(".settings-nav-item").filter({ hasText: /高级|Advanced/ }).click();
    await debugRow.getByRole("switch").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".tab-button")).toHaveCount(2);
    await expect(page.locator(".tab-button.active")).toHaveText(/讲解|Notes/);
    await expect(page.locator(".structure-grid")).toHaveCount(0);
  });

  test("generation details popover opens from the progress control", async ({ page }) => {
    await page.locator(".generation-progress-trigger").click();
    await expect(page.locator(".generation-details-popover")).toBeVisible();
    await expect(page.locator(".generation-details-popover")).toContainText(/生成情况|Generation status/i);
  });
});
