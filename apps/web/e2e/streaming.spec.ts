import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type Page } from "@playwright/test";
import { activateAgent, resetStorage, uploadPdfFromRail } from "./helpers";

const sse = (...events: Record<string, unknown>[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

async function openDocument(page: Page) {
  await uploadPdfFromRail(page);
  await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
  return activateAgent(page);
}

async function send(page: Page, question: string) {
  const composer = page.locator(".aui-composer-input");
  await composer.click();
  await composer.fill(question);
  await page.keyboard.press("Enter");
}

/** Every other API call is answered with `{}`; the chat call is left to `chat`. */
async function mockApi(page: Page, chat: Parameters<Page["route"]>[1]) {
  await page.route("**/api/**", async (route, request) => {
    if (request.url().includes("/api/agent/chat")) return chat(route, request);
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

/**
 * A chat backend that really streams: it writes what the test tells it to,
 * when the test tells it to, and reports when the browser hangs up.
 */
async function startStreamingBackend() {
  let response: ServerResponse | null = null;
  let resolveRequest: () => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => (resolveRequest = resolve));
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "close" });
    response = res;
    res.on("close", () => resolveClosed());
    resolveRequest();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/agent/chat`,
    requested,
    closed,
    write: (...events: Record<string, unknown>[]) => response?.write(sse(...events)),
    end: () => response?.end(),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test.describe("Assistant answers stream", () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test("the answer appears while it is being written, and the finished answer is saved", async ({ page }) => {
    const backend = await startStreamingBackend();
    let payload: Record<string, unknown> = {};
    await mockApi(page, async (route, request) => {
      payload = request.postDataJSON() as Record<string, unknown>;
      await route.continue({ url: backend.url });
    });
    await openDocument(page);
    await send(page, "什么是经验风险");
    await backend.requested;
    expect(payload.stream).toBe(true);

    backend.write({ type: "start" }, { type: "thinking" });
    await expect(page.locator(".assistant-thinking")).toBeVisible();
    backend.write({ type: "delta", text: "经验风险是训练集上" }, { type: "delta", text: "损失的平均值" });
    // Shown while the request is still open: nothing has ended the stream yet.
    const answer = page.locator(".assistant-message").last();
    await expect(answer).toContainText("经验风险是训练集上损失的平均值", { timeout: 10_000 });
    await expect(page.locator(".composer-stop")).toBeVisible();

    backend.write({ type: "delta", text: "，$\\hat R(\\theta)$。" }, { type: "done", message: { content: "经验风险是训练集上损失的平均值，$\\hat R(\\theta)$。" } });
    backend.end();
    await expect(page.locator(".composer-stop")).toHaveCount(0, { timeout: 10_000 });
    await expect(answer).toContainText("经验风险是训练集上损失的平均值，");
    await expect(answer.locator(".katex").first()).toBeVisible();
    await backend.stop();

    await page.reload();
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await activateAgent(page);
    await expect(page.locator(".assistant-message").last()).toContainText("经验风险是训练集上损失的平均值，", { timeout: 10_000 });
  });

  test("stop ends the request at the backend and keeps what was written", async ({ page }) => {
    const backend = await startStreamingBackend();
    await mockApi(page, (route) => route.continue({ url: backend.url }));
    await openDocument(page);
    await send(page, "推导正规方程");
    await backend.requested;
    backend.write({ type: "start" }, { type: "delta", text: "令梯度为零，" });
    await expect(page.locator(".assistant-message").last()).toContainText("令梯度为零，", { timeout: 10_000 });

    await page.locator(".composer-stop").click();
    // The browser hung up: the backend can stop the model.
    await backend.closed;
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await backend.stop();

    await page.reload();
    await expect(page.locator(".pdf-page-shell").first().locator("canvas")).toBeVisible({ timeout: 15_000 });
    await activateAgent(page);
    await expect(page.locator(".assistant-message").last()).toContainText("令梯度为零，", { timeout: 10_000 });
  });

  test("a failure in the middle of an answer keeps the text that had arrived", async ({ page }) => {
    await mockApi(page, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse(
          { type: "start" },
          { type: "delta", text: "岭回归在损失后面" },
          { type: "error", error: "upstream_error", message: "upstream went away", status: 502 },
        ),
      }),
    );
    await openDocument(page);
    await send(page, "岭回归是什么");
    const answer = page.locator(".assistant-message").last();
    await expect(answer).toContainText("岭回归在损失后面", { timeout: 10_000 });
    await expect(answer).toContainText("upstream went away");
  });

  test("an answer cut off at the output limit says so", async ({ page }) => {
    await mockApi(page, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse(
          { type: "delta", text: "第一步，" },
          { type: "done", message: { content: "第一步，" }, truncated: true },
        ),
      }),
    );
    await openDocument(page);
    await send(page, "完整推导一遍");
    const answer = page.locator(".assistant-message").last();
    await expect(answer).toContainText("第一步，", { timeout: 10_000 });
    await expect(answer).toContainText(/回答在这里中断了|The answer was cut off here/);
  });

  test("a request that fails before the answer starts is reported as before", async ({ page }) => {
    await mockApi(page, (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited", message: "slow down" }) }),
    );
    await openDocument(page);
    await send(page, "你好");
    await expect(page.locator(".assistant-message").last()).toContainText("slow down", { timeout: 10_000 });
  });
});
