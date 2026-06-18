export type WorkspaceMode = "full" | "pdf-agent" | "pdf-only";
export type ThemeMode = "system" | "light" | "dark";
export type AccentColor = "clay" | "graphite" | "sage";
export type PdfBackground = "paper" | "plain" | "soft";
export type FontScale = "compact" | "default" | "large";
export type ResponseStyle = "concise" | "teaching" | "socratic";
export type ScrollbarStyle = "thin" | "subtle" | "native";

export type UiPreferences = {
  language: "auto" | "zh-CN" | "en";
  workspaceMode: WorkspaceMode;
  autoSaveSession: boolean;
  theme: ThemeMode;
  accentColor: AccentColor;
  pdfBackground: PdfBackground;
  fontScale: FontScale;
  compactMode: boolean;
  defaultModel: "gpt-5.5" | "gpt-5.1" | "local-preview";
  responseStyle: ResponseStyle;
  autoUseSelectedContext: boolean;
  showSourcePills: boolean;
  pageAwareSuggestions: boolean;
  defaultZoom: "auto" | "100" | "125";
  pageFitMode: "width" | "page" | "height";
  scrollbarStyle: ScrollbarStyle;
  showPageSummaryHint: boolean;
  enableSelectionToolbar: boolean;
  outputFormat: "markdown" | "json" | "markdown-json";
  notesStyle: "teaching" | "concise" | "exam";
  includeCitations: boolean;
  quizOptions: boolean;
  debugMode: boolean;
};

export const uiPreferencesStorageKey = "pagepair.uiPreferences.v1";

export const defaultUiPreferences: UiPreferences = {
  language: "auto",
  workspaceMode: "full",
  autoSaveSession: true,
  theme: "system",
  accentColor: "clay",
  pdfBackground: "paper",
  fontScale: "default",
  compactMode: false,
  defaultModel: "gpt-5.5",
  responseStyle: "teaching",
  autoUseSelectedContext: true,
  showSourcePills: true,
  pageAwareSuggestions: true,
  defaultZoom: "auto",
  pageFitMode: "width",
  scrollbarStyle: "thin",
  showPageSummaryHint: true,
  enableSelectionToolbar: true,
  outputFormat: "markdown-json",
  notesStyle: "teaching",
  includeCitations: true,
  quizOptions: false,
  debugMode: false,
};

export function loadUiPreferences() {
  if (typeof window === "undefined") return defaultUiPreferences;
  try {
    const stored = window.localStorage.getItem(uiPreferencesStorageKey);
    if (!stored) return defaultUiPreferences;
    return { ...defaultUiPreferences, ...(JSON.parse(stored) as Partial<UiPreferences>) };
  } catch {
    return defaultUiPreferences;
  }
}
