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
