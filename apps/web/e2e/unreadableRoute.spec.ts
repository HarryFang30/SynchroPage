import { test, expect } from "@playwright/test";
import { providerModelReadsImages, unreadableTextRoute } from "../src/lib/generation/teachingGeneration";
import { normalizeModelApiConfig, type ModelApiConfig, type ModelApiProvider, type ModelRef } from "../src/settings";

// Pure-function checks for how a page with an unreadable text layer reaches a
// model that can see it, given the provider configuration.

function provider(overrides: Partial<ModelApiProvider> & { id: string }): ModelApiProvider {
  return {
    name: overrides.id,
    type: "openai-compatible",
    apiHost: `https://${overrides.id}.example`,
    apiKeyRequired: true,
    enabled: true,
    models: [],
    ...overrides,
  } as ModelApiProvider;
}

function config(providers: ModelApiProvider[], quality: ModelRef, extra: Partial<ModelApiConfig["defaults"]> = {}): ModelApiConfig {
  return normalizeModelApiConfig({
    version: 1,
    selectedProviderId: providers[0].id,
    providers,
    defaults: { assistant: quality, teachingFast: quality, teachingBalanced: quality, teachingQuality: quality, ...extra },
  });
}

const flash: ModelRef = { providerId: "deepseek", model: "deepseek-flash" };
const v4pro: ModelRef = { providerId: "deepseek", model: "deepseek-v4-pro" };
const deepseek = provider({ id: "deepseek", models: ["deepseek-flash", "deepseek-v4-pro"] });

test.describe("unreadable text route", () => {
  test("flash reads images, v4-pro does not, flags override the list", () => {
    expect(providerModelReadsImages(deepseek, "deepseek-flash")).toBe(true);
    expect(providerModelReadsImages(deepseek, "deepseek-v4-pro")).toBe(false);
    expect(providerModelReadsImages(provider({ id: "silicon", models: ["deepseek-ai/DeepSeek-OCR"] }), "deepseek-ai/DeepSeek-OCR")).toBe(true);
    expect(providerModelReadsImages(provider({ id: "x", apiFeatures: { visionModels: ["v4-pro"] } }), "deepseek-v4-pro")).toBe(true);
    expect(providerModelReadsImages(provider({ id: "x", apiFeatures: { models: { "deepseek-flash": { imageInput: false } } } }), "deepseek-flash")).toBe(false);
    expect(providerModelReadsImages(provider({ id: "x", enabled: false }), "deepseek-flash")).toBe(false);
  });

  test("the quality model sees the page itself when it can", () => {
    expect(unreadableTextRoute(config([deepseek], flash))).toEqual({ mode: "attach", input: "image" });
    const codex = provider({ id: "codex_oauth", type: "codex-oauth", models: ["gpt-5.5"], apiKeyRequired: false });
    expect(unreadableTextRoute(config([codex], { providerId: "codex_oauth", model: "gpt-5.5" }))).toEqual({ mode: "attach", input: "pdf" });
  });

  test("a text-only quality model falls back to OCR, then to a transcribing model", () => {
    const ocrProvider = provider({ id: "silicon", models: ["deepseek-ai/DeepSeek-OCR"] });
    const ocr: ModelRef = { providerId: "silicon", model: "deepseek-ai/DeepSeek-OCR" };
    expect(unreadableTextRoute(config([deepseek, ocrProvider], v4pro, { ocr }))).toEqual({ mode: "ocr", ref: ocr });
    // No OCR model: the first enabled model that reads images transcribes.
    expect(unreadableTextRoute(config([deepseek], v4pro))).toEqual({ mode: "transcribe", ref: flash, input: "image" });
    // A configured transcription model wins over the list.
    const configured: ModelRef = { providerId: "silicon", model: "deepseek-ai/DeepSeek-OCR" };
    expect(unreadableTextRoute(config([deepseek, ocrProvider], v4pro, { transcription: configured }))).toEqual({ mode: "transcribe", ref: configured, input: "image" });
    // A disabled OCR provider does not count.
    expect(unreadableTextRoute(config([deepseek, provider({ id: "silicon", enabled: false, models: ["deepseek-ai/DeepSeek-OCR"] })], v4pro, { ocr }))).toEqual({ mode: "transcribe", ref: flash, input: "image" });
  });

  test("nothing that can see the page means none", () => {
    const textOnly = provider({ id: "deepseek", models: ["deepseek-v4-pro"] });
    expect(unreadableTextRoute(config([textOnly], v4pro))).toEqual({ mode: "none" });
  });
});
