import type { AppCopy } from "../../i18n";
import {
  defaultUiPreferences,
  normalizeAgentAnswerMode,
  normalizeExplanationLanguage,
  normalizeLanguage,
  normalizeModelReasoningEffort,
  type UiPreferences,
} from "../../settings";
import type { AgentAttachment, AgentContextItem } from "../assistant/agentChatAdapter";
import {
  clampPreferenceNumber,
  normalizeTeachingOutputLanguage,
  type PageData,
  type PagePack,
} from "../generation/teachingGeneration";
import type { DocumentRecord, GeneratedPageRecord, StorageRepairResult } from "../persistence/schema";
import type { ThreadMessageLike } from "../persistence/workspaceStore";

export type ActiveTab = "notes" | "structure" | "json";
export type GeneratePageMode = "missing" | "all" | "current" | "custom";
export type PanelKey = "rail" | "notes" | "agent";
export type PanelVisibility = Record<PanelKey, boolean>;

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDraftPagePack(
  title: string,
  fileName: string,
  pageCount: number,
  documentId = createId("pdf_doc"),
): PagePack {
  const safeCount = Math.max(1, Math.floor(pageCount) || 1);
  return {
    schema: "synchropage.lecture.v1",
    document: {
      id: documentId,
      title,
      source_pdf_url: fileName,
      page_count: safeCount,
    },
    pages: Array.from({ length: safeCount }, (_, index) => {
      const pageNo = index + 1;
      return {
        page_no: pageNo,
        source: {
          pdf_page_ref: `#page=${pageNo}`,
          text_md: "",
          ocr_used: false,
          parser: "pdfjs",
        },
        teaching: {
          slide_title: `PDF p.${pageNo}`,
          speaker_notes_md: "",
          concepts: [],
          visual_explanations: [],
          prerequisites: [],
          confidence: 0,
        },
        status: "draft",
      };
    }),
  };
}

export function documentTitleFromRecord(document: DocumentRecord) {
  const fileTitle = document.fileName.replace(/\.pdf$/i, "").trim();
  if (document.mimeType === "application/pdf" && fileTitle) return fileTitle;
  return document.title || fileTitle || document.fileName || "Untitled PDF";
}

export function pagePackFromPersistence(
  document: DocumentRecord,
  generatedPages: GeneratedPageRecord[],
  copy: AppCopy,
): PagePack {
  const documentTitle = documentTitleFromRecord(document);
  const rawPages = generatedPages
    .slice()
    .sort((left, right) => left.generatedPageIndex - right.generatedPageIndex)
    .map((page) => page.json);
  if (rawPages.length) {
    return normalizePack(
      {
        schema: "synchropage.lecture.v1",
        document: {
          id: document.id,
          title: documentTitle,
          source_pdf_url: document.fileName,
          page_count: Math.max(document.pageCount || 0, rawPages.length),
        },
        pages: rawPages,
      },
      copy,
    );
  }
  return createDraftPagePack(documentTitle, document.fileName, Math.max(document.pageCount || 1, 1), document.id);
}

export function settingsRecordToPreferences(record: Partial<UiPreferences> | null | undefined): UiPreferences {
  const merged = { ...defaultUiPreferences, ...(record || {}) };
  return {
    ...merged,
    language: normalizeLanguage(merged.language),
    explanationLanguage: normalizeExplanationLanguage(merged.explanationLanguage),
    modelReasoningEffort: normalizeModelReasoningEffort(merged.modelReasoningEffort),
    agentAnswerMode: normalizeAgentAnswerMode(merged.agentAnswerMode),
    pdfContextFullPageLimit: clampPreferenceNumber(
      merged.pdfContextFullPageLimit,
      defaultUiPreferences.pdfContextFullPageLimit,
      1,
      500,
    ),
    pdfContextEdgePageCount: clampPreferenceNumber(
      merged.pdfContextEdgePageCount,
      defaultUiPreferences.pdfContextEdgePageCount,
      1,
      100,
    ),
  };
}

export function agentAnswerModeReasoningEffort(
  mode: UiPreferences["agentAnswerMode"],
): UiPreferences["modelReasoningEffort"] {
  if (mode === "detailed") return "xhigh";
  if (mode === "guided") return "high";
  return "medium";
}

export function workspaceLayoutSnapshot(input: {
  panels: PanelVisibility;
  activeTab: ActiveTab;
  query: string;
  activeProjectId: string | null;
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
}) {
  return {
    panels: input.panels,
    activeTab: input.activeTab,
    query: input.query,
    activeProjectId: input.activeProjectId || undefined,
    contexts: input.contexts,
    attachments: input.attachments,
  };
}

export function isPanelVisibility(value: unknown): value is PanelVisibility {
  const record = value as Partial<PanelVisibility> | null;
  return (
    Boolean(record) &&
    typeof record?.rail === "boolean" &&
    typeof record?.notes === "boolean" &&
    typeof record?.agent === "boolean"
  );
}

export function isActiveTab(value: unknown): value is ActiveTab {
  return value === "notes" || value === "structure" || value === "json";
}

export function asPersistedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function upsertThreadMessage(messages: ThreadMessageLike[], next: ThreadMessageLike) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

export function storageRepairCount(result: StorageRepairResult) {
  return (
    result.orphanFileBlobs +
    result.orphanGeneratedPages +
    result.orphanChatThreads +
    result.orphanChatMessages +
    result.orphanSelectedContexts +
    result.workspacesRepaired +
    result.documentsMarkedMissing
  );
}

export function normalizePack(raw: unknown, copy: AppCopy): PagePack {
  const source = raw as Partial<PagePack> & { pages?: unknown[]; title?: string };
  const pages = Array.isArray(source) ? source : source.pages;
  if (!Array.isArray(pages)) throw new Error(copy.errors.jsonNeedsPages);

  return {
    schema: source.schema || "synchropage.lecture.v1",
    document: {
      id: source.document?.id || "imported_document",
      title: source.document?.title || source.title || copy.errors.importedDocument,
      source_pdf_url: source.document?.source_pdf_url || "",
      page_count: pages.length,
    },
    pages: pages.map((rawPage, index) => {
      const page = rawPage as Partial<PageData> & {
        page_text?: string;
        title?: string;
        notes?: string;
        concepts?: string[];
        visual_explanations?: string[];
        formula_explanations?: string[];
        prerequisites?: string[];
        contextual_bridge?: string;
        evidence?: PageData["teaching"]["evidence"];
        needs_review?: boolean;
        needs_parser_fallback?: boolean;
        confidence?: number;
      };
      const teaching = (page.teaching || page) as Partial<PageData["teaching"]> & {
        title?: string;
        notes?: string;
      };
      return {
        page_no: Number(page.page_no || index + 1),
        source: {
          pdf_page_ref: page.source?.pdf_page_ref || `#page=${page.page_no || index + 1}`,
          text_md: page.source?.text_md || page.page_text || "",
          ocr_used: Boolean(page.source?.ocr_used),
          parser: page.source?.parser || "imported",
          page_type: page.source?.page_type,
        },
        teaching: {
          output_language: normalizeTeachingOutputLanguage(teaching.output_language),
          slide_title: teaching.slide_title || teaching.title || copy.errors.importedPageTitle(index),
          speaker_notes_md: teaching.speaker_notes_md || teaching.notes || "",
          concepts: Array.isArray(teaching.concepts) ? teaching.concepts : [],
          visual_explanations: Array.isArray(teaching.visual_explanations)
            ? teaching.visual_explanations
            : [],
          prerequisites: Array.isArray(teaching.prerequisites) ? teaching.prerequisites : [],
          contextual_bridge: teaching.contextual_bridge || "",
          formula_explanations: Array.isArray(teaching.formula_explanations) ? teaching.formula_explanations : [],
          evidence: Array.isArray(teaching.evidence) ? teaching.evidence : [],
          needs_review: Boolean(teaching.needs_review),
          needs_parser_fallback: Boolean(teaching.needs_parser_fallback),
          confidence: Number(teaching.confidence ?? 0.72),
        },
        status: page.status || "ready",
      };
    }),
  };
}

export function compactText(value: string, max = 120) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function formatPageRanges(pages: number[]) {
  const sorted = Array.from(new Set(pages)).sort((left, right) => left - right);
  const ranges: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  for (const pageNo of sorted) {
    if (start === null || previous === null || pageNo !== previous + 1) {
      if (start !== null && previous !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
      start = pageNo;
    }
    previous = pageNo;
  }
  if (start !== null && previous !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(", ");
}

export function parsePageRangeInput(value: string, pageCount: number) {
  const text = value.trim();
  if (!text) return null;
  const pages = new Set<number>();
  const tokens = text.split(/[\s,，、;；]+/).filter(Boolean);
  for (const token of tokens) {
    const range = token.match(/^(\d+)\s*[-~—–]\s*(\d+)$/);
    const single = token.match(/^\d+$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) return null;
      for (let pageNo = start; pageNo <= end; pageNo += 1) pages.add(pageNo);
      continue;
    }
    if (single) {
      const pageNo = Number(token);
      if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > pageCount) return null;
      pages.add(pageNo);
      continue;
    }
    return null;
  }
  return Array.from(pages).sort((left, right) => left - right);
}

export function generateTargetPageNumbers(
  mode: GeneratePageMode,
  rangeDraft: string,
  currentPageNo: number,
  pageCount: number,
) {
  const total = Math.max(1, pageCount);
  if (mode === "current") return [Math.min(Math.max(currentPageNo, 1), total)];
  if (mode === "custom") return parsePageRangeInput(rangeDraft, total);
  return Array.from({ length: total }, (_, index) => index + 1);
}

export function assistantContentText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = part as { text?: unknown };
      return typeof value.text === "string" ? value.text : "";
    })
    .join("\n")
    .trim();
}
