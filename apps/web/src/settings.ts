export type ThemeMode = "system" | "light" | "dark";
export type AccentColor = "clay" | "graphite" | "sage";
export type PdfBackground = "paper" | "plain" | "soft";
export type PdfViewMode = "continuous" | "single-page";
export type FontScale = "compact" | "default" | "large";
export type ScrollbarStyle = "thin" | "subtle" | "native";
export type Language = "zh-CN" | "en-US";
export type ExplanationLanguage = "auto" | Language;
export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type AgentAnswerMode = "concise" | "guided" | "detailed";
export type ApiProviderType = "codex-oauth" | "openai-compatible" | "openai-responses";

export type ModelRef = {
  providerId: string;
  model: string;
};

export type ModelApiProvider = {
  id: string;
  name: string;
  type: ApiProviderType;
  apiHost: string;
  apiKey?: string;
  hasApiKey?: boolean;
  apiKeyRequired: boolean;
  enabled: boolean;
  models: string[];
};

export type ModelApiConfig = {
  version: number;
  selectedProviderId: string;
  providers: ModelApiProvider[];
  defaults: {
    assistant: ModelRef;
    teachingFast: ModelRef;
    teachingBalanced: ModelRef;
    teachingQuality: ModelRef;
  };
};

export type UiPreferences = {
  language: Language;
  explanationLanguage: ExplanationLanguage;
  modelReasoningEffort: ModelReasoningEffort;
  agentAnswerMode: AgentAnswerMode;
  autoSaveSession: boolean;
  theme: ThemeMode;
  accentColor: AccentColor;
  pdfBackground: PdfBackground;
  pdfViewMode: PdfViewMode;
  fontScale: FontScale;
  compactMode: boolean;
  showSourcePills: boolean;
  pageAwareSuggestions: boolean;
  pdfContextFullPageLimit: number;
  pdfContextEdgePageCount: number;
  scrollbarStyle: ScrollbarStyle;
  debugMode: boolean;
};

export const uiPreferencesStorageKey = "synchropage.uiPreferences.v1";

export const defaultUiPreferences: UiPreferences = {
  language: "zh-CN",
  explanationLanguage: "auto",
  modelReasoningEffort: "medium",
  agentAnswerMode: "concise",
  autoSaveSession: true,
  theme: "dark",
  accentColor: "clay",
  pdfBackground: "paper",
  pdfViewMode: "continuous",
  fontScale: "default",
  compactMode: false,
  showSourcePills: true,
  pageAwareSuggestions: true,
  pdfContextFullPageLimit: 50,
  pdfContextEdgePageCount: 10,
  scrollbarStyle: "thin",
  debugMode: false,
};

export const defaultModelApiConfig: ModelApiConfig = {
  version: 1,
  selectedProviderId: "codex_oauth",
  providers: [
    {
      id: "codex_oauth",
      name: "OpenAI OAuth",
      type: "codex-oauth",
      apiHost: "https://chatgpt.com/backend-api/codex/",
      apiKeyRequired: false,
      enabled: true,
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    },
    {
      id: "openai_api",
      name: "OpenAI API Key",
      type: "openai-responses",
      apiHost: "https://api.openai.com/v1",
      apiKeyRequired: true,
      enabled: false,
      models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      type: "openai-compatible",
      apiHost: "https://api.deepseek.com",
      apiKeyRequired: true,
      enabled: false,
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      type: "openai-compatible",
      apiHost: "https://openrouter.ai/api/v1",
      apiKeyRequired: true,
      enabled: false,
      models: ["openai/gpt-4.1", "anthropic/claude-sonnet-4", "deepseek/deepseek-chat"],
    },
    {
      id: "siliconflow",
      name: "SiliconFlow",
      type: "openai-compatible",
      apiHost: "https://api.siliconflow.cn/v1",
      apiKeyRequired: true,
      enabled: false,
      models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
    },
    {
      id: "ollama",
      name: "Ollama",
      type: "openai-compatible",
      apiHost: "http://127.0.0.1:11434/v1",
      apiKeyRequired: false,
      enabled: false,
      models: ["llama3.1", "qwen2.5"],
    },
  ],
  defaults: {
    assistant: { providerId: "codex_oauth", model: "gpt-5.5" },
    teachingFast: { providerId: "codex_oauth", model: "gpt-5.4-mini" },
    teachingBalanced: { providerId: "codex_oauth", model: "gpt-5.4" },
    teachingQuality: { providerId: "codex_oauth", model: "gpt-5.5" },
  },
};

export function loadUiPreferences() {
  if (typeof window === "undefined") return defaultUiPreferences;
  try {
    const stored = window.localStorage.getItem(uiPreferencesStorageKey);
    if (!stored) return defaultUiPreferences;
    const merged = { ...defaultUiPreferences, ...(JSON.parse(stored) as Partial<UiPreferences>) };
    const pdfViewMode: PdfViewMode = merged.pdfViewMode === "single-page" ? "single-page" : "continuous";
    return {
      ...merged,
      language: normalizeLanguage(merged.language),
      explanationLanguage: normalizeExplanationLanguage(merged.explanationLanguage),
      modelReasoningEffort: normalizeModelReasoningEffort(merged.modelReasoningEffort),
      agentAnswerMode: normalizeAgentAnswerMode(merged.agentAnswerMode),
      pdfViewMode,
      pdfContextFullPageLimit: clampNumber(merged.pdfContextFullPageLimit, defaultUiPreferences.pdfContextFullPageLimit, 1, 500),
      pdfContextEdgePageCount: clampNumber(merged.pdfContextEdgePageCount, defaultUiPreferences.pdfContextEdgePageCount, 1, 100),
    };
  } catch {
    return defaultUiPreferences;
  }
}

export function normalizeLanguage(value: unknown): Language {
  return value === "en-US" ? "en-US" : "zh-CN";
}

export function normalizeExplanationLanguage(value: unknown): ExplanationLanguage {
  return value === "zh-CN" || value === "en-US" ? value : "auto";
}

export function normalizeModelReasoningEffort(value: unknown): ModelReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "medium";
}

export function normalizeAgentAnswerMode(value: unknown): AgentAnswerMode {
  return value === "guided" || value === "detailed" ? value : "concise";
}

export function normalizeModelApiConfig(value: unknown): ModelApiConfig {
  const source = (value && typeof value === "object" ? value : {}) as Partial<ModelApiConfig>;
  const providers = Array.isArray(source.providers) && source.providers.length
    ? source.providers.map((provider, index) => normalizeModelApiProvider(provider, index))
    : defaultModelApiConfig.providers;
  const selectedProviderId = providers.some((provider) => provider.id === source.selectedProviderId)
    ? String(source.selectedProviderId)
    : providers[0]?.id || defaultModelApiConfig.selectedProviderId;
  return {
    version: 1,
    selectedProviderId,
    providers,
    defaults: {
      assistant: normalizeModelRef(source.defaults?.assistant, providers, defaultModelApiConfig.defaults.assistant),
      teachingFast: normalizeModelRef(source.defaults?.teachingFast, providers, defaultModelApiConfig.defaults.teachingFast),
      teachingBalanced: normalizeModelRef(source.defaults?.teachingBalanced, providers, defaultModelApiConfig.defaults.teachingBalanced),
      teachingQuality: normalizeModelRef(source.defaults?.teachingQuality, providers, defaultModelApiConfig.defaults.teachingQuality),
    },
  };
}

export function modelRefLabel(config: ModelApiConfig, ref: ModelRef) {
  const provider = config.providers.find((item) => item.id === ref.providerId);
  return provider ? `${ref.model} | ${provider.name}` : ref.model;
}

export function providerForModelRef(config: ModelApiConfig, ref: ModelRef) {
  return config.providers.find((provider) => provider.id === ref.providerId) || config.providers[0];
}

function normalizeModelApiProvider(value: unknown, index: number): ModelApiProvider {
  const provider = (value && typeof value === "object" ? value : {}) as Partial<ModelApiProvider>;
  const type = provider.type === "codex-oauth" || provider.type === "openai-responses" ? provider.type : "openai-compatible";
  const fallback = defaultModelApiConfig.providers[index] || defaultModelApiConfig.providers[0];
  const id = cleanProviderId(provider.id) || fallback.id || `provider_${index + 1}`;
  return {
    id,
    name: cleanString(provider.name) || fallback.name || id,
    type,
    apiHost: cleanString(provider.apiHost) || fallback.apiHost || "",
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined,
    hasApiKey: Boolean(provider.hasApiKey),
    apiKeyRequired: typeof provider.apiKeyRequired === "boolean" ? provider.apiKeyRequired : type !== "codex-oauth",
    enabled: typeof provider.enabled === "boolean" ? provider.enabled : type === "codex-oauth",
    models: normalizeModelList(provider.models).length ? normalizeModelList(provider.models) : fallback.models,
  };
}

function normalizeModelRef(value: unknown, providers: ModelApiProvider[], fallback: ModelRef): ModelRef {
  const ref = (value && typeof value === "object" ? value : {}) as Partial<ModelRef>;
  const providerId = providers.some((provider) => provider.id === ref.providerId) ? String(ref.providerId) : fallback.providerId;
  const provider = providers.find((item) => item.id === providerId) || providers[0];
  return {
    providerId: provider?.id || fallback.providerId,
    model: cleanString(ref.model) || provider?.models[0] || fallback.model,
  };
}

function normalizeModelList(value: unknown) {
  const raw = typeof value === "string" ? value.split(/[\n,]+/) : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  return raw
    .map((item) => cleanString(item))
    .filter((item): item is string => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function cleanProviderId(value: unknown) {
  return cleanString(value)?.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "";
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}
