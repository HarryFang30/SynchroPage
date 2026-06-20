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

export const uiPreferencesStorageKey = "pagepair.uiPreferences.v1";

export const defaultUiPreferences: UiPreferences = {
  language: "zh-CN",
  explanationLanguage: "auto",
  modelReasoningEffort: "medium",
  agentAnswerMode: "concise",
  autoSaveSession: true,
  theme: "system",
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

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}
