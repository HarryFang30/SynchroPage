export type ThemeMode = "system" | "light" | "dark";
export type AccentColor = "clay" | "graphite" | "sage";
export type PdfBackground = "paper" | "plain" | "soft";
export type FontScale = "compact" | "default" | "large";
export type ScrollbarStyle = "thin" | "subtle" | "native";
export type Language = "zh-CN" | "en-US";

export type UiPreferences = {
  language: Language;
  autoSaveSession: boolean;
  theme: ThemeMode;
  accentColor: AccentColor;
  pdfBackground: PdfBackground;
  fontScale: FontScale;
  compactMode: boolean;
  showSourcePills: boolean;
  pageAwareSuggestions: boolean;
  scrollbarStyle: ScrollbarStyle;
  showPageSummaryHint: boolean;
  debugMode: boolean;
};

export const uiPreferencesStorageKey = "pagepair.uiPreferences.v1";

export const defaultUiPreferences: UiPreferences = {
  language: "zh-CN",
  autoSaveSession: true,
  theme: "system",
  accentColor: "clay",
  pdfBackground: "paper",
  fontScale: "default",
  compactMode: false,
  showSourcePills: true,
  pageAwareSuggestions: true,
  scrollbarStyle: "thin",
  showPageSummaryHint: true,
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
