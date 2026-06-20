import {
  Archive,
  Check,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns3,
  Copy,
  ExternalLink,
  FileInput,
  FileJson,
  Image,
  Lock,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  NotebookText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Settings2,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  type ChangeEvent,
  type ComponentType,
  createContext,
  forwardRef,
  lazy,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  Suspense,
} from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { getAppCopy, type AppCopy } from "./i18n";
import {
  defaultUiPreferences,
  loadUiPreferences,
  normalizeAgentAnswerMode,
  normalizeExplanationLanguage,
  normalizeLanguage,
  normalizeModelReasoningEffort,
  type ExplanationLanguage,
  type UiPreferences,
  uiPreferencesStorageKey,
} from "./settings";
import {
  chatMessageToThreadMessageLike,
  clearSelectedContext as clearPersistedSelectedContext,
  clearWorkspace,
  classifyPersistenceError,
  createChatThread,
  createCourseProject,
  deleteCourseProject,
  deleteWorkspaceDocument,
  estimateStorage,
  exportWorkspace,
  importWorkspace,
  loadCourseProjects,
  loadLastWorkspace,
  loadWorkspaceDocument,
  loadWorkspaceDocuments,
  loadWorkspaceProject,
  requestPersistentStorage,
  repairWorkspaceStorage,
  saveChatMessage,
  saveDocumentPatch,
  saveGeneratedPage,
  saveGeneratedPagesFromPack,
  saveImportedPagePack,
  savePdfBlob,
  saveSelectedContext,
  saveSettings,
  saveWorkspacePatch,
  updateStreamingMessage,
  type ChatMessageRecord,
  type ChatMessageStatus,
  type CourseProjectRecord,
  type DocumentSidebarItem,
  type DocumentRecord,
  type ExportedWorkspace,
  type GeneratedPageRecord,
  type LoadedWorkspace,
  type SaveStatusKind,
  type StorageEstimate,
  type StorageRepairResult,
  type ThreadMessageLike,
} from "./lib/persistence";

const AppCopyContext = createContext<AppCopy>(getAppCopy("zh-CN"));
type SettingsSection =
  | "general"
  | "appearance"
  | "agent"
  | "pdf"
  | "account"
  | "storage"
  | "advanced";
type ThreadAssistantMessagePart = { type: "text"; text: string };
type ChatModelMessage = {
  id?: string;
  role: string;
  content?: unknown[];
  createdAt?: Date;
};
type ChatModelRunOptions = {
  messages: ChatModelMessage[];
  unstable_assistantMessageId?: string;
  abortSignal: AbortSignal;
};
type ChatModelAdapter = {
  run(options: ChatModelRunOptions): AsyncGenerator<{
    content: ThreadAssistantMessagePart[];
    status: unknown;
  }>;
};
type AssistantPrimitiveGroup = Record<string, ComponentType<any>>;
type AssistantThreadRuntime = {
  append: (message: unknown) => void;
  composer: {
    reset: () => void | Promise<void>;
    setQuote: (quote?: { text: string; messageId: string }) => void;
    setText: (text: string) => void;
    send: () => void;
  };
};
type AssistantUiRuntime = {
  AssistantRuntimeProvider: ComponentType<{ runtime: unknown; children?: ReactNode }>;
  ThreadPrimitive: AssistantPrimitiveGroup;
  MessagePrimitive: AssistantPrimitiveGroup;
  ActionBarPrimitive: AssistantPrimitiveGroup;
  BranchPickerPrimitive: AssistantPrimitiveGroup;
  ErrorPrimitive: AssistantPrimitiveGroup;
  ComposerPrimitive: AssistantPrimitiveGroup;
  useLocalRuntime: (adapter: ChatModelAdapter, options: { initialMessages: ThreadMessageLike[] }) => {
    thread: {
      reset: () => void;
      composer: { reset: () => void | Promise<void> };
    };
  };
  useThreadRuntime: () => AssistantThreadRuntime;
  useAuiState: <T>(selector: (state: {
    message: {
      role: string;
      status?: { type?: string; reason?: string };
      content: unknown[];
    };
    part: { type?: string; text?: string };
  }) => T) => T;
};
const AssistantUiContext = createContext<AssistantUiRuntime | null>(null);
const SettingsModal = lazy(() => import("./SettingsModal").then((module) => ({ default: module.SettingsModal })));
const MarkdownRenderer = lazy(() => import("./components/MarkdownRenderer"));
let assistantUiRuntimePromise: Promise<AssistantUiRuntime> | null = null;
let pdfJsRuntimePromise: Promise<typeof import("./lib/pdf/pdfjs")> | null = null;

function useAppCopy() {
  return useContext(AppCopyContext);
}

function useAssistantUi() {
  const runtime = useContext(AssistantUiContext);
  if (!runtime) throw new Error("assistant-ui runtime is not loaded");
  return runtime;
}

function loadAssistantUiRuntime() {
  assistantUiRuntimePromise ??= import("./lib/assistant/assistantUiRuntime") as unknown as Promise<AssistantUiRuntime>;
  return assistantUiRuntimePromise;
}

function useAssistantUiRuntime(shouldLoad: boolean, deferUntilIdle: boolean) {
  const [runtime, setRuntime] = useState<AssistantUiRuntime | null>(null);

  useEffect(() => {
    if (!shouldLoad || runtime) return undefined;
    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    const loadRuntime = () => {
      void loadAssistantUiRuntime().then((loadedRuntime) => {
        if (!cancelled) setRuntime(loadedRuntime);
      });
    };
    if (deferUntilIdle && "requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(loadRuntime, { timeout: 1800 });
    } else if (deferUntilIdle) {
      timeoutHandle = window.setTimeout(loadRuntime, 900);
    } else {
      loadRuntime();
    }
    return () => {
      cancelled = true;
      if (idleHandle !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    };
  }, [deferUntilIdle, runtime, shouldLoad]);

  return runtime;
}

function useDeferredAssistantRuntime(shouldLoadImmediately: boolean) {
  const [requested, setRequested] = useState(false);
  const assistantUi = useAssistantUiRuntime(true, !requested && !shouldLoadImmediately);
  const requestAssistantUi = useCallback(() => {
    setRequested(true);
  }, []);
  useEffect(() => {
    if (shouldLoadImmediately) setRequested(true);
  }, [shouldLoadImmediately]);
  return { assistantUi, requestAssistantUi };
}

function loadPdfJsRuntime() {
  pdfJsRuntimePromise ??= import("./lib/pdf/pdfjs");
  return pdfJsRuntimePromise;
}

type PagePack = {
  schema: string;
  document: {
    id: string;
    title: string;
    source_pdf_url: string;
    page_count: number;
  };
  pages: PageData[];
};

type TeachingOutputLanguage = Exclude<ExplanationLanguage, "auto">;

type PageData = {
  page_no: number;
  source: {
    pdf_page_ref: string;
    text_md: string;
    ocr_used: boolean;
    parser: string;
    page_type?: string;
  };
  teaching: {
    output_language?: TeachingOutputLanguage;
    slide_title: string;
    speaker_notes_md: string;
    concepts: string[];
    visual_explanations: string[];
    prerequisites: string[];
    contextual_bridge?: string;
    formula_explanations?: string[];
    evidence?: Array<{
      kind: string;
      quote_or_reference: string;
    }>;
    needs_review?: boolean;
    needs_parser_fallback?: boolean;
    confidence: number;
  };
  status: string;
};

type PdfContextPage = {
  page_no: number;
  title?: string;
  text_md: string;
};

type PdfContextPayload = {
  documentId: string;
  documentTitle: string;
  pageCount: number;
  truncated: boolean;
  truncationPolicy: "all-pages" | "first-last-edge";
  fullPageLimit: number;
  edgePageCount: number;
  includedPageNumbers: number[];
  pages: PdfContextPage[];
};

type PdfDirectFileInput = {
  filename: string;
  mimeType: string;
  size: number;
  sha256?: string;
  fileData: string;
};

type GenerationPageStatus = "done" | "running" | "failed" | "pending";
type GeneratePageMode = "missing" | "all" | "current" | "custom";

type PdfViewMode = "continuous" | "single-page";

type PdfScrollViewerHandle = {
  scrollToPage: (pageNumber: number, behavior?: ScrollBehavior) => void;
};

type AgentContextItem = {
  id: string;
  type: "page" | "selection" | "formula" | "pdf_reference";
  title: string;
  source: string;
  page_no: number;
  text: string;
};

type AgentAttachment = {
  id: string;
  type: "image";
  name: string;
  mime: string;
  size: number;
  data_url: string;
};

type SelectedContextSourceType =
  | "pdf-page"
  | "generated-explanation"
  | "assistant-message"
  | "page"
  | "unknown";

type SelectedPdfSource = {
  pageNumber: number;
  title?: string;
  text?: string;
  ref?: string;
  parser?: string;
};

type SelectedContext = {
  id: string;
  text: string;
  sourceType: SelectedContextSourceType;
  documentTitle?: string;
  pageNumber?: number;
  pdfPageNumber?: number;
  generatedPageNumber?: number;
  sectionTitle?: string;
  messageId?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  selectionRects?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  viewportScale?: number;
  viewportRotation?: number;
  pdfSource?: SelectedPdfSource;
  createdAt: number;
};

type SelectionToolbarState = {
  context: SelectedContext;
  x: number;
  y: number;
};

type QuickSelectionPrompt = {
  id: string;
  prompt: string;
  context: SelectedContext;
};

type AgentSnapshot = {
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  pdfContext: PdfContextPayload | null;
  answerMode: UiPreferences["agentAnswerMode"];
  reasoningEffort: UiPreferences["modelReasoningEffort"];
};

type ChatPersistInput = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: ChatMessageStatus;
  createdAt?: number;
  selectedContext?: Record<string, unknown> | null;
  sourceRefs?: Record<string, unknown>[];
};

type SaveState = {
  kind: SaveStatusKind;
  message?: string;
  updatedAt?: number;
};

type PersistentStorageState = "unknown" | "persisted" | "best-effort" | "unsupported";

type OAuthMode = "unknown" | "ready" | "connected" | "polling" | "offline" | "mock";
type PanelKey = "rail" | "notes" | "agent";
type PanelVisibility = Record<PanelKey, boolean>;
type OAuthDevicePrompt = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  expires_at_ms: number;
};

const fullPanelVisibility: PanelVisibility = {
  rail: true,
  notes: true,
  agent: true,
};

const samplePack: PagePack = {
  schema: "lecture_pairpack.v1",
  document: {
    id: "demo_course_pdf",
    title: "课程 PDF 逐页讲解",
    source_pdf_url: "",
    page_count: 3,
  },
  pages: [
    {
      page_no: 1,
      source: {
        pdf_page_ref: "#page=1",
        text_md: "课程目标：把 PDF 课件转换为逐页讲解。核心约束是页级对齐、结构化输出、可重跑。",
        ocr_used: false,
        parser: "docling",
      },
      teaching: {
        output_language: "zh-CN",
        slide_title: "从讲解 PDF 改为双栏工作台",
        speaker_notes_md:
          "## 从讲解 PDF 改为双栏工作台\n\n这一页建立产品方向：系统不再把讲解重新排成 PDF，而是保留原始 PDF 页面作为左侧参照，在右侧生成可编辑的讲解内容。\n\n### 讲课口径\n\n- 先强调原 PDF 是事实来源，讲解只是对当前页的教学化展开。\n- 再说明 PagePair JSON 会把页号、解析文本、讲解稿和置信度绑定在一起。\n- 最后指出这种格式更适合校对、重跑和版本管理。",
        concepts: ["PagePair JSON", "左右对照", "页级对齐"],
        visual_explanations: ["左侧保留原页面语境，右侧只承载可编辑讲解。"],
        prerequisites: ["课程 PDF 已完成页级解析"],
        confidence: 0.94,
      },
      status: "ready",
    },
    {
      page_no: 2,
      source: {
        pdf_page_ref: "#page=2",
        text_md: "系统流程：上传 PDF -> 解析 Page JSON -> 全局摘要 -> 逐页生成 -> JSON 校验 -> Web 展示。",
        ocr_used: false,
        parser: "docling",
      },
      teaching: {
        output_language: "zh-CN",
        slide_title: "最优技术路径",
        speaker_notes_md:
          "## 最优技术路径\n\n解析层使用 Docling 或 PyMuPDF 生成稳定 Page JSON；生成层通过 OpenAI Gateway 调用 Responses API；展示层读取 lecture_pairpack.v1.json。\n\n### 讲课口径\n\n- 解析和生成分离，避免把整份 PDF 直接塞给模型。\n- OpenAI Gateway 是唯一模型入口，前端只关心任务状态和结果数据。\n- 如果遇到扫描件或公式密集页，再通过 fallback 路由切换 OCR 或专业解析器。",
        concepts: ["OpenAI Gateway", "Docling", "PyMuPDF", "Structured Outputs"],
        visual_explanations: ["流程图应突出 parser、generator、validator 三个边界。"],
        prerequisites: ["已确认不生成讲解 PDF"],
        confidence: 0.91,
      },
      status: "ready",
    },
    {
      page_no: 3,
      source: {
        pdf_page_ref: "#page=3",
        text_md: "认证：前端走 OAuth 登录，模型请求走后端代理。输出：JSON 与 Markdown，而非 PDF。",
        ocr_used: false,
        parser: "docling",
      },
      teaching: {
        output_language: "zh-CN",
        slide_title: "OAuth 与输出格式",
        speaker_notes_md:
          "## OAuth 与输出格式\n\n浏览器不应直接持有模型 API 凭据。用户通过 OpenAI OAuth 或应用会话进入系统，后端再统一代理模型调用。\n\n### 讲课口径\n\n- OAuth 负责用户身份和授权入口。\n- OpenAI Gateway 负责模型调用、限流、日志和缓存。\n- 最终展示格式是 JSON 加 Markdown 渲染，必要时再导出 Markdown 或 PPTX。",
        concepts: ["OAuth", "后端代理", "Markdown 渲染"],
        visual_explanations: ["认证链路应从浏览器指向后端，再由后端进入模型 API。"],
        prerequisites: ["已有后端 session 设计"],
        confidence: 0.88,
      },
      status: "ready",
    },
  ],
};

const englishSamplePack: PagePack = {
  schema: "lecture_pairpack.v1",
  document: {
    id: "demo_course_pdf",
    title: "Course PDF Page-by-Page Notes",
    source_pdf_url: "",
    page_count: 3,
  },
  pages: [
    {
      page_no: 1,
      source: {
        pdf_page_ref: "#page=1",
        text_md: "Course goal: convert PDF slides into page-by-page teaching notes. Core constraints are page alignment, structured output, and repeatable runs.",
        ocr_used: false,
        parser: "docling",
      },
      teaching: {
        output_language: "en-US",
        slide_title: "From Notes PDF to Split Workspace",
        speaker_notes_md:
          "## From Notes PDF to Split Workspace\n\nThis page sets the product direction: instead of regenerating an explanation PDF, the app keeps the original PDF page as the reference and places editable teaching notes beside it.\n\n### Teaching Line\n\n- Emphasize that the original PDF remains the source of truth, while notes are a teaching-oriented expansion of the current page.\n- Explain that PagePair JSON binds page number, parsed text, notes, and confidence together.\n- Close by pointing out why this format is easier to review, rerun, and version.",
        concepts: ["PagePair JSON", "Side-by-side review", "Page alignment"],
        visual_explanations: ["The left side preserves page context; the right side carries editable notes only."],
        prerequisites: ["The course PDF has been parsed at page level"],
        confidence: 0.94,
      },
      status: "ready",
    },
    {
      page_no: 2,
      source: {
        pdf_page_ref: "#page=2",
        text_md: "System flow: upload PDF -> parse Page JSON -> global summary -> page-by-page generation -> JSON validation -> web display.",
        ocr_used: false,
        parser: "docling",
      },
      teaching: {
        output_language: "en-US",
        slide_title: "Recommended Technical Path",
        speaker_notes_md:
          "## Recommended Technical Path\n\nUse Docling or PyMuPDF in the parsing layer to generate stable Page JSON; use OpenAI Gateway and the Responses API in the generation layer; render lecture_pairpack.v1.json in the web layer.\n\n### Teaching Line\n\n- Keep parsing and generation separate instead of sending the full PDF directly to the model.\n- Treat OpenAI Gateway as the only model entry point, while the frontend only tracks task status and result data.\n- For scanned or formula-heavy pages, route through OCR or a specialized parser fallback.",
        concepts: ["OpenAI Gateway", "Docling", "PyMuPDF", "Structured Outputs"],
        visual_explanations: ["The flow diagram should emphasize the parser, generator, and validator boundaries."],
        prerequisites: ["The team has confirmed it will not generate a notes PDF"],
        confidence: 0.91,
      },
      status: "ready",
    },
    {
      page_no: 3,
      source: {
        pdf_page_ref: "#page=3",
        text_md: "Authentication: the frontend uses OAuth sign-in; model requests go through the backend proxy. Output is JSON and Markdown, not PDF.",
        ocr_used: false,
        parser: "docling",
      },
      teaching: {
        output_language: "en-US",
        slide_title: "OAuth and Output Format",
        speaker_notes_md:
          "## OAuth and Output Format\n\nThe browser should not hold model API credentials directly. The user enters through OpenAI OAuth or an app session, and the backend proxies model calls in one place.\n\n### Teaching Line\n\n- OAuth handles user identity and authorization entry.\n- OpenAI Gateway handles model calls, rate limits, logs, and caching.\n- The final display format is JSON plus Markdown rendering, with optional export to Markdown or PPTX later.",
        concepts: ["OAuth", "Backend proxy", "Markdown rendering"],
        visual_explanations: ["The authentication path should point from browser to backend, then from backend to the model API."],
        prerequisites: ["A backend session design already exists"],
        confidence: 0.88,
      },
      status: "ready",
    },
  ],
};

const samplePacks: Record<UiPreferences["language"], PagePack> = {
  "zh-CN": samplePack,
  "en-US": englishSamplePack,
};

function normalizeTeachingOutputLanguage(value: unknown): TeachingOutputLanguage | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

function resolveTeachingOutputLanguage(preferences: UiPreferences): TeachingOutputLanguage {
  return preferences.explanationLanguage === "zh-CN" || preferences.explanationLanguage === "en-US"
    ? preferences.explanationLanguage
    : preferences.language;
}

function teachingOutputLanguageName(language: TeachingOutputLanguage) {
  return language === "en-US" ? "English" : "Simplified Chinese";
}

function generationFailureMarkdown(message: string, language: TeachingOutputLanguage) {
  if (language === "en-US") {
    return `## Page notes generation failed\n\n${message}`;
  }
  return `## 本页讲解生成失败\n\n${message}`;
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDraftPagePack(title: string, fileName: string, pageCount: number, documentId = createId("pdf_doc")): PagePack {
  const safeCount = Math.max(1, Math.floor(pageCount) || 1);
  return {
    schema: "lecture_pairpack.v1",
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

function documentTitleFromRecord(document: DocumentRecord) {
  const fileTitle = document.fileName.replace(/\.pdf$/i, "").trim();
  if (document.mimeType === "application/pdf" && fileTitle) return fileTitle;
  return document.title || fileTitle || document.fileName || "Untitled PDF";
}

function pagePackFromPersistence(
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
        schema: "lecture_pairpack.v1",
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

function settingsRecordToPreferences(record: Partial<UiPreferences> | null | undefined): UiPreferences {
  const merged = { ...defaultUiPreferences, ...(record || {}) };
  return {
    ...merged,
    language: normalizeLanguage(merged.language),
    explanationLanguage: normalizeExplanationLanguage(merged.explanationLanguage),
    modelReasoningEffort: normalizeModelReasoningEffort(merged.modelReasoningEffort),
    agentAnswerMode: normalizeAgentAnswerMode(merged.agentAnswerMode),
    pdfContextFullPageLimit: clampPreferenceNumber(merged.pdfContextFullPageLimit, defaultUiPreferences.pdfContextFullPageLimit, 1, 500),
    pdfContextEdgePageCount: clampPreferenceNumber(merged.pdfContextEdgePageCount, defaultUiPreferences.pdfContextEdgePageCount, 1, 100),
  };
}

function agentAnswerModeReasoningEffort(mode: UiPreferences["agentAnswerMode"]): UiPreferences["modelReasoningEffort"] {
  if (mode === "detailed") return "xhigh";
  if (mode === "guided") return "high";
  return "medium";
}

function clampPreferenceNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function workspaceLayoutSnapshot(input: {
  panels: PanelVisibility;
  activeTab: "notes" | "structure" | "json";
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

function isPanelVisibility(value: unknown): value is PanelVisibility {
  const record = value as Partial<PanelVisibility> | null;
  return (
    Boolean(record) &&
    typeof record?.rail === "boolean" &&
    typeof record?.notes === "boolean" &&
    typeof record?.agent === "boolean"
  );
}

function isActiveTab(value: unknown): value is "notes" | "structure" | "json" {
  return value === "notes" || value === "structure" || value === "json";
}

function asPersistedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function upsertThreadMessage(messages: ThreadMessageLike[], next: ThreadMessageLike) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

function storageRepairCount(result: StorageRepairResult) {
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

async function requestJson<T>(path: string, options: RequestInit = {}, accountNotFoundMessage = "请先连接 OpenAI OAuth 后再发送。") {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    let parsed: { error?: string; message?: string } | null = null;
    try {
      parsed = JSON.parse(detail) as { error?: string; message?: string };
    } catch {
      parsed = null;
    }
    if (parsed?.error === "account_not_found") {
      throw new Error(accountNotFoundMessage);
    }
    throw new Error(parsed?.message || parsed?.error || detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function normalizePack(raw: unknown, copy: AppCopy): PagePack {
  const source = raw as Partial<PagePack> & { pages?: unknown[]; title?: string };
  const pages = Array.isArray(source) ? source : source.pages;
  if (!Array.isArray(pages)) throw new Error(copy.errors.jsonNeedsPages);

  return {
    schema: source.schema || "lecture_pairpack.v1",
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

function compactText(value: string, max = 120) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function contextSourceLabel(context: AgentContextItem, copy: AppCopy) {
  if (context.type === "formula") return copy.agent.contextFormula(context.page_no);
  if (context.type === "selection") return copy.agent.contextSelection(context.page_no);
  if (context.type === "pdf_reference") return copy.agent.contextPdfReference(context.page_no);
  return copy.agent.contextSource(context.page_no, compactText(context.source || context.title, 28));
}

function selectedContextSourceLabel(context: SelectedContext, copy: AppCopy) {
  if (context.sourceType === "pdf-page") return copy.agent.selectedPdfPage(context.pdfPageNumber || context.pageNumber || "?");
  if (context.sourceType === "generated-explanation") return copy.agent.selectedNotesPage(context.generatedPageNumber || context.pageNumber || "?");
  if (context.sourceType === "assistant-message") return copy.agent.assistantMessage;
  if (context.sourceType === "page") return copy.agent.pageSource(context.pageNumber || "?");
  return copy.common.selectedContent;
}

function selectedContextToAgentContext(context: SelectedContext, copy: AppCopy): AgentContextItem {
  const pageNo = context.pdfPageNumber || context.generatedPageNumber || context.pageNumber || 1;
  return {
    id: context.id,
    type: detectContextType(context.text),
    title: selectedContextSourceLabel(context, copy),
    source: context.sectionTitle || selectedContextSourceLabel(context, copy),
    page_no: pageNo,
    text: context.text,
  };
}

function selectedContextPdfSourceContext(context: SelectedContext, copy: AppCopy): AgentContextItem | null {
  const pdfSource = context.pdfSource;
  if (!pdfSource?.pageNumber || !pdfSource.text?.trim()) return null;
  return {
    id: `${context.id}:pdf-source`,
    type: "pdf_reference",
    title: copy.common.sourcePdfPage(pdfSource.pageNumber),
    source: pdfSource.title || pdfSource.ref || copy.common.sourcePdfPage(pdfSource.pageNumber),
    page_no: pdfSource.pageNumber,
    text: pdfSource.text,
  };
}

function selectedContextPayload(context: SelectedContext) {
  return {
    id: context.id,
    text: context.text,
    sourceType: context.sourceType,
    documentTitle: context.documentTitle,
    pageNumber: context.pageNumber,
    pdfPageNumber: context.pdfPageNumber,
    generatedPageNumber: context.generatedPageNumber,
    sectionTitle: context.sectionTitle,
    messageId: context.messageId,
    rect: context.rect,
    selectionRects: context.selectionRects,
    viewportScale: context.viewportScale,
    viewportRotation: context.viewportRotation,
    pdfSource: context.pdfSource,
  };
}

function selectedContextPageNumber(context: SelectedContext | null) {
  if (!context) return null;
  const pageNo = context.pdfPageNumber || context.generatedPageNumber || context.pageNumber;
  return typeof pageNo === "number" && Number.isFinite(pageNo) ? pageNo : null;
}

function formatPageRanges(pages: number[]) {
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

function parsePageRangeInput(value: string, pageCount: number) {
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

function generateTargetPageNumbers(mode: GeneratePageMode, rangeDraft: string, currentPageNo: number, pageCount: number) {
  const total = Math.max(1, pageCount);
  if (mode === "current") return [Math.min(Math.max(currentPageNo, 1), total)];
  if (mode === "custom") return parsePageRangeInput(rangeDraft, total);
  return Array.from({ length: total }, (_, index) => index + 1);
}

function buildSelectedQuestionPrompt(
  question: string,
  selectedContext: SelectedContext | null,
  pdfContext: PdfContextPayload | null,
  copy: AppCopy,
) {
  const userQuestion = question.trim() || copy.agent.continuePrompt;
  if (!selectedContext?.text.trim()) return userQuestion;
  const selectedPage = selectedContextPageNumber(selectedContext);
  const pdfSource = selectedContext.pdfSource;
  const sourceLines = [
    selectedContext.sourceType === "generated-explanation" && selectedContext.generatedPageNumber
      ? `Selected explanation page: ${selectedContext.generatedPageNumber}`
      : null,
    selectedPage
      ? selectedContext.sourceType === "generated-explanation"
        ? `Corresponding original PDF page: ${selectedPage}`
        : `PDF page: ${selectedPage}`
      : null,
    selectedContext.sectionTitle ? `Source: ${selectedContext.sectionTitle}` : null,
    pdfSource?.title ? `PDF page title: ${pdfSource.title}` : null,
    pdfSource?.ref ? `PDF page reference: ${pdfSource.ref}` : null,
  ].filter((line): line is string => Boolean(line));
  if (pdfContext?.truncated) {
    const includedPages = formatPageRanges(pdfContext.includedPageNumbers);
    const selectedIncluded = selectedPage ? pdfContext.includedPageNumbers.includes(selectedPage) : false;
    sourceLines.push(
      `PDF context is truncated: original PDF has ${pdfContext.pageCount} pages, configured full-context limit is ${pdfContext.fullPageLimit} pages, and the model received pages ${includedPages || "none"} (${pdfContext.edgePageCount} pages from each edge).`,
    );
    if (selectedPage) {
      sourceLines.push(
        selectedIncluded
          ? `The selected text is on PDF page ${selectedPage}, which is included in the truncated PDF context.`
          : `The selected text is on PDF page ${selectedPage}, which is outside the truncated PDF context; use the selected text as the exact evidence for that page.`,
      );
    }
  }
  const promptSections = [
    "Selected source:",
    ...sourceLines,
    selectedContext.sourceType === "generated-explanation" ? "Selected explanation text:" : "Selected text:",
    selectedContext.text.trim(),
  ];
  if (pdfSource?.text?.trim()) {
    promptSections.push(
      "Corresponding original PDF page text:",
      truncatePromptContext(pdfSource.text),
    );
  }
  promptSections.push("User question:", userQuestion);
  return promptSections.join("\n\n");
}

function truncatePromptContext(text: string, max = 6000) {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[Truncated to keep the selected prompt concise.]`;
}

function sanitizePdfContextSettings(settings: Pick<UiPreferences, "pdfContextFullPageLimit" | "pdfContextEdgePageCount">) {
  const fullPageLimit = Math.min(Math.max(Math.floor(Number(settings.pdfContextFullPageLimit) || 50), 1), 500);
  const edgePageCount = Math.min(Math.max(Math.floor(Number(settings.pdfContextEdgePageCount) || 10), 1), 100);
  return { fullPageLimit, edgePageCount };
}

function pdfContextPageNumbers(pageCount: number, settings: Pick<UiPreferences, "pdfContextFullPageLimit" | "pdfContextEdgePageCount">) {
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const total = Math.max(0, Math.floor(pageCount));
  if (total <= fullPageLimit) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (let pageNo = 1; pageNo <= Math.min(edgePageCount, total); pageNo += 1) {
    pages.add(pageNo);
  }
  for (let pageNo = Math.max(1, total - edgePageCount + 1); pageNo <= total; pageNo += 1) {
    pages.add(pageNo);
  }
  return Array.from(pages).sort((left, right) => left - right);
}

function textContentToPlainText(textContent: { items?: unknown[] }) {
  const lines: string[] = [];
  let current = "";
  for (const item of textContent.items || []) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const text = String((item as { str?: unknown }).str || "");
    if (!text) continue;
    current += text;
    if ((item as { hasEOL?: boolean }).hasEOL) {
      lines.push(current.trimEnd());
      current = "";
    } else {
      current += " ";
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

async function sha256ArrayBuffer(buffer: ArrayBuffer) {
  if (!window.crypto?.subtle) return undefined;
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function pdfDirectFileInputFromUrl(url: string, filename: string): Promise<PdfDirectFileInput | null> {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF file read failed: HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) return null;
  const buffer = await blob.arrayBuffer();
  const sha256 = await sha256ArrayBuffer(buffer).catch(() => undefined);
  return {
    filename: filename || "document.pdf",
    mimeType: blob.type || "application/pdf",
    size: blob.size,
    sha256,
    fileData: arrayBufferToBase64(buffer),
  };
}

async function extractPdfContextFromDocument(
  document: PDFDocumentProxy,
  documentId: string,
  documentTitle: string,
  settings: Pick<UiPreferences, "pdfContextFullPageLimit" | "pdfContextEdgePageCount">,
): Promise<PdfContextPayload> {
  const pageCount = document.numPages;
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const includedPageNumbers = pdfContextPageNumbers(pageCount, settings);
  const truncated = includedPageNumbers.length < pageCount;
  const pages: PdfContextPage[] = [];
  for (const pageNo of includedPageNumbers) {
    const page = await document.getPage(pageNo);
    const textContent = await page.getTextContent();
    pages.push({
      page_no: pageNo,
      title: `PDF p.${pageNo}`,
      text_md: textContentToPlainText(textContent),
    });
  }
  return {
    documentId,
    documentTitle,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "first-last-edge" : "all-pages",
    fullPageLimit,
    edgePageCount,
    includedPageNumbers,
    pages,
  };
}

function waitForPdfExtractionIdle(delayMs = 80) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function extractPdfPagesFromDocument(
  document: PDFDocumentProxy,
  options: {
    priorityPageNumbers?: number[];
    shouldCancel?: () => boolean;
    onProgress?: (pages: PdfContextPage[]) => void;
    progressBatchSize?: number;
    delayMs?: number;
  } = {},
): Promise<PdfContextPage[]> {
  const pages: PdfContextPage[] = [];
  let pendingProgress = 0;
  const progressBatchSize = Math.max(1, options.progressBatchSize || 6);
  for (const pageNo of pdfExtractionOrder(document.numPages, options.priorityPageNumbers)) {
    if (options.shouldCancel?.()) break;
    const page = await document.getPage(pageNo);
    if (options.shouldCancel?.()) break;
    const textContent = await page.getTextContent();
    if (options.shouldCancel?.()) break;
    pages.push({
      page_no: pageNo,
      title: `PDF p.${pageNo}`,
      text_md: textContentToPlainText(textContent),
    });
    pendingProgress += 1;
    if (options.onProgress && pendingProgress >= progressBatchSize) {
      pendingProgress = 0;
      options.onProgress(sortPdfContextPages(pages));
    }
    await waitForPdfExtractionIdle(options.delayMs);
  }
  if (options.onProgress && pendingProgress > 0) {
    options.onProgress(sortPdfContextPages(pages));
  }
  return sortPdfContextPages(pages);
}

function pdfExtractionOrder(pageCount: number, priorityPageNumbers: number[] = []) {
  const total = Math.max(0, pageCount);
  const seen = new Set<number>();
  const ordered: number[] = [];
  const add = (pageNo: number) => {
    if (!Number.isFinite(pageNo) || pageNo < 1 || pageNo > total || seen.has(pageNo)) return;
    seen.add(pageNo);
    ordered.push(pageNo);
  };
  priorityPageNumbers.forEach(add);
  for (let pageNo = 1; pageNo <= total; pageNo += 1) add(pageNo);
  return ordered;
}

function sortPdfContextPages(pages: PdfContextPage[]) {
  return [...pages].sort((left, right) => left.page_no - right.page_no);
}

function fullPdfContextForTeachingGeneration(
  pack: PagePack,
  pageCount: number,
  extractedPages: PdfContextPage[],
): PdfContextPayload {
  const extractedTextByPage = new Map(extractedPages.map((page) => [page.page_no, page.text_md]));
  const packPagesByNumber = new Map(pack.pages.map((page) => [page.page_no, page]));
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageNo = index + 1;
    const packPage = packPagesByNumber.get(pageNo);
    return {
      page_no: pageNo,
      title: packPage?.teaching.slide_title || `PDF p.${pageNo}`,
      text_md: extractedTextByPage.get(pageNo) || packPage?.source.text_md || "",
    };
  });
  return {
    documentId: pack.document.id,
    documentTitle: pack.document.title,
    pageCount,
    truncated: false,
    truncationPolicy: "all-pages",
    fullPageLimit: pageCount,
    edgePageCount: pageCount,
    includedPageNumbers: pages.map((page) => page.page_no),
    pages,
  };
}

function pdfContextFromExtractedPages(
  documentId: string,
  documentTitle: string,
  pageCount: number,
  settings: Pick<UiPreferences, "pdfContextFullPageLimit" | "pdfContextEdgePageCount">,
  extractedPages: PdfContextPage[],
): PdfContextPayload {
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const includedPageNumbers = pdfContextPageNumbers(pageCount, settings);
  const wantedPages = new Set(includedPageNumbers);
  const truncated = includedPageNumbers.length < pageCount;
  return {
    documentId,
    documentTitle,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "first-last-edge" : "all-pages",
    fullPageLimit,
    edgePageCount,
    includedPageNumbers,
    pages: extractedPages.filter((page) => wantedPages.has(page.page_no)),
  };
}

function buildPdfContextFromPack(
  pack: PagePack,
  settings: Pick<UiPreferences, "pdfContextFullPageLimit" | "pdfContextEdgePageCount">,
): PdfContextPayload {
  const pageCount = Math.max(pack.document.page_count || pack.pages.length, pack.pages.length);
  const { fullPageLimit, edgePageCount } = sanitizePdfContextSettings(settings);
  const includedPageNumbers = pdfContextPageNumbers(pageCount, settings);
  const truncated = includedPageNumbers.length < pageCount;
  const wantedPages = new Set(includedPageNumbers);
  const pages = pack.pages
    .filter((page) => wantedPages.has(page.page_no))
    .map((page) => ({
      page_no: page.page_no,
      title: page.teaching.slide_title || `PDF p.${page.page_no}`,
      text_md: page.source.text_md || page.teaching.speaker_notes_md || "",
    }));
  return {
    documentId: pack.document.id,
    documentTitle: pack.document.title,
    pageCount,
    truncated,
    truncationPolicy: truncated ? "first-last-edge" : "all-pages",
    fullPageLimit,
    edgePageCount,
    includedPageNumbers,
    pages,
  };
}

function composerContextPreview(contexts: AgentContextItem[], attachments: AgentAttachment[], copy: AppCopy) {
  if (contexts.length) {
    const first = contexts[contexts.length - 1];
    const extra = contexts.length > 1 ? ` +${contexts.length - 1}` : "";
    return `${contextSourceLabel(first, copy)}${extra}`;
  }
  if (attachments.length) {
    const first = attachments[attachments.length - 1];
    const extra = attachments.length > 1 ? ` +${attachments.length - 1}` : "";
    return `${copy.agent.imagePreview(compactText(first.name, 28))}${extra}`;
  }
  return "";
}

function pageSuggestions(page: PageData, pageAware: boolean, copy: AppCopy) {
  if (!pageAware) {
    return copy.agent.selectedFallbackSuggestions;
  }
  return copy.agent.pageSuggestions(compactText(page.teaching.slide_title, 42), page.teaching.concepts[0] || "this page");
}

function splitOAuthUserCode(value: string) {
  const compact = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (compact.length === 9) return [compact.slice(0, 4), compact.slice(4)];
  const groups = value.split("-").map((group) => group.trim()).filter(Boolean);
  return groups.length ? groups : [value];
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function detectContextType(text: string): AgentContextItem["type"] {
  return /(\$\$?[^$]+\$\$?|\\\(|\\\[|\\begin\{|[∑∫√∞≈≠≤≥πθλμ])/.test(text)
    ? "formula"
    : "selection";
}

function readFileAsDataUrl(file: File, copy: AppCopy) {
  return new Promise<AgentAttachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: createId("img"),
        type: "image",
        name: file.name || "image",
        mime: file.type || "image/png",
        size: file.size || 0,
        data_url: String(reader.result || ""),
      });
    reader.onerror = () => reject(reader.error || new Error(copy.errors.imageReadFailed));
    reader.readAsDataURL(file);
  });
}

function usePageSelection(args: {
  documentTitle: string;
  page: PageData;
  copy: AppCopy;
  setLastSelection: (context: SelectedContext | null) => void;
}) {
  const [toolbar, setToolbar] = useState<SelectionToolbarState | null>(null);

  const updateSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !text) {
      setToolbar(null);
      args.setLastSelection(null);
      return;
    }

    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement || null;
    if (!anchorElement || shouldIgnoreSelection(anchorElement)) {
      setToolbar(null);
      args.setLastSelection(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const source = detectSelectionSource(anchorElement, args.copy);
    const pdfPageLayer = anchorElement.closest<HTMLElement>(".pdf-page-layered");
    const pdfPageNumber = Number(pdfPageLayer?.dataset.pageNumber || args.page.page_no);
    const viewportScale = Number(pdfPageLayer?.dataset.viewportScale || "");
    const viewportRotation = Number(pdfPageLayer?.dataset.viewportRotation || "");
    const isPdfSelection = source.sourceType === "pdf-page" && Number.isFinite(pdfPageNumber);
    const isNotesSelection = source.sourceType === "generated-explanation";
    const sourcePdfPageNumber = isPdfSelection ? pdfPageNumber : args.page.page_no;
    const pageRect = pdfPageLayer?.getBoundingClientRect();
    const selectionRects = Array.from(range.getClientRects())
      .filter((item) => item.width > 0 && item.height > 0)
      .map((item) => ({
        x: pageRect ? item.left - pageRect.left : item.left,
        y: pageRect ? item.top - pageRect.top : item.top,
        width: item.width,
        height: item.height,
      }));
    const context: SelectedContext = {
      id: createId("selected"),
      text,
      sourceType: source.sourceType,
      documentTitle: args.documentTitle,
      pageNumber: sourcePdfPageNumber,
      pdfPageNumber: isPdfSelection || isNotesSelection ? sourcePdfPageNumber : undefined,
      generatedPageNumber: isNotesSelection ? args.page.page_no : undefined,
      sectionTitle: source.label,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      selectionRects,
      viewportScale: source.sourceType === "pdf-page" && Number.isFinite(viewportScale) ? viewportScale : undefined,
      viewportRotation: source.sourceType === "pdf-page" && Number.isFinite(viewportRotation) ? viewportRotation : undefined,
      pdfSource: isNotesSelection
        ? {
            pageNumber: sourcePdfPageNumber,
            title: args.page.teaching.slide_title || `PDF p.${sourcePdfPageNumber}`,
            text: args.page.source.text_md,
            ref: args.page.source.pdf_page_ref,
            parser: args.page.source.parser,
          }
        : undefined,
      createdAt: Date.now(),
    };

    args.setLastSelection(context);
    setToolbar({
      context,
      x: Math.min(window.innerWidth - 18, Math.max(18, rect.left + rect.width / 2)),
      y: Math.max(18, rect.top - 12),
    });
  }, [args]);

  useEffect(() => {
    const onSelectionChange = () => window.setTimeout(updateSelection, 0);
    const clearOnScroll = () => {
      const selection = window.getSelection();
      if (!selection?.toString().trim()) setToolbar(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("mouseup", onSelectionChange);
    window.addEventListener("keyup", onSelectionChange);
    window.addEventListener("scroll", clearOnScroll, true);
    window.addEventListener("resize", clearOnScroll);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("mouseup", onSelectionChange);
      window.removeEventListener("keyup", onSelectionChange);
      window.removeEventListener("scroll", clearOnScroll, true);
      window.removeEventListener("resize", clearOnScroll);
    };
  }, [updateSelection]);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    args.setLastSelection(null);
    setToolbar(null);
  }, [args]);

  return { toolbar, clearSelection };
}

function shouldIgnoreSelection(element: Element) {
  return Boolean(
    element.closest(
      "input, textarea, select, [contenteditable='true'], .aui-composer-root, .selection-toolbar",
    ),
  );
}

function detectSelectionSource(element: Element, copy: AppCopy): { sourceType: SelectedContextSourceType; label: string } {
  if (element.closest(".pdf-page-layered, .pdf-text-layer")) return { sourceType: "pdf-page", label: copy.agent.selectionSources.pdfPage };
  if (element.closest(".notes-pane")) return { sourceType: "generated-explanation", label: copy.agent.selectionSources.notes };
  if (element.closest(".assistant-message")) return { sourceType: "assistant-message", label: copy.agent.selectionSources.assistant };
  if (element.closest(".page-rail")) return { sourceType: "page", label: copy.agent.selectionSources.rail };
  return { sourceType: "unknown", label: copy.agent.selectionSources.page };
}

function messageText(message: unknown): string {
  const msg = message as { content?: unknown[]; role?: string };
  return (msg.content || [])
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === "text" ? p.text || "" : "";
    })
    .join("\n")
    .trim();
}

function createPdfAgentAdapter(args: {
  getSnapshot: () => AgentSnapshot;
  getDocumentFile?: () => Promise<PdfDirectFileInput | null>;
  getPack: () => PagePack;
  getPage: () => PageData;
  copy: AppCopy;
  isBackendOffline: () => boolean;
  clearSelectedContext: () => void;
  persistChatMessage?: (input: ChatPersistInput) => Promise<void>;
}): ChatModelAdapter {
  return {
    async *run(options: ChatModelRunOptions) {
      const snapshot = args.getSnapshot();
      const pack = args.getPack();
      const page = args.getPage();
      const selectedAgentContext = snapshot.selectedContext
        ? selectedContextToAgentContext(snapshot.selectedContext, args.copy)
        : null;
      const selectedPdfSourceContext = snapshot.selectedContext
        ? selectedContextPdfSourceContext(snapshot.selectedContext, args.copy)
        : null;
      const documentFile = await args.getDocumentFile?.().catch(() => null) || null;
      const latestUser = [...options.messages].reverse().find((message) => message.role === "user");
      const latestUserText = latestUser ? messageText(latestUser) : "";
      const promptInput = buildSelectedQuestionPrompt(latestUserText, snapshot.selectedContext, snapshot.pdfContext, args.copy);
      const latestUserMeta = latestUser as { id?: string; createdAt?: Date };
      const assistantMessageId = options.unstable_assistantMessageId || createId("assistant");
      const selectedContextRecord = snapshot.selectedContext ? asPersistedRecord(selectedContextPayload(snapshot.selectedContext)) : null;
      const sourceRefs = [
        ...(selectedAgentContext ? [asPersistedRecord(selectedAgentContext)] : []),
        ...(selectedPdfSourceContext ? [asPersistedRecord(selectedPdfSourceContext)] : []),
        ...snapshot.contexts.map((context) => asPersistedRecord(context)),
      ];
      let persistQueue = Promise.resolve();
      let lastPartialSaveAt = 0;
      const enqueuePersist = (input: ChatPersistInput) => {
        persistQueue = persistQueue
          .then(() => args.persistChatMessage?.(input))
          .catch(() => undefined);
        return persistQueue;
      };
      if (latestUserText) {
        await enqueuePersist({
          id: latestUserMeta.id || createId("user"),
          role: "user",
          content: latestUserText,
          status: "completed",
          createdAt: latestUserMeta.createdAt?.getTime?.() || Date.now(),
          selectedContext: selectedContextRecord,
          sourceRefs,
        });
      }
      await enqueuePersist({
        id: assistantMessageId,
        role: "assistant",
        content: "",
        status: "pending",
        selectedContext: selectedContextRecord,
        sourceRefs,
      });
      const persistPartial = (content: string, status: ChatMessageStatus, force = false) => {
        const now = Date.now();
        if (!force && now - lastPartialSaveAt < 420) return;
        lastPartialSaveAt = now;
        void enqueuePersist({
          id: assistantMessageId,
          role: "assistant",
          content,
          status,
          selectedContext: selectedContextRecord,
          sourceRefs,
        });
      };

      const parts = [
        promptInput ? { type: "text", text: promptInput } : null,
        selectedAgentContext
          ? {
              type: "quote",
              title: selectedAgentContext.title,
              text: selectedAgentContext.text,
              source: {
                kind: selectedAgentContext.source,
                page_no: selectedAgentContext.page_no,
                document_id: pack.document.id,
                source_type: snapshot.selectedContext?.sourceType,
                pdf_source: snapshot.selectedContext?.pdfSource || null,
              },
            }
          : null,
        selectedPdfSourceContext
          ? {
              type: "pdf_reference",
              title: selectedPdfSourceContext.title,
              text: selectedPdfSourceContext.text,
              source: {
                kind: selectedPdfSourceContext.source,
                page_no: selectedPdfSourceContext.page_no,
                document_id: pack.document.id,
                source_type: "pdf-page",
                relation: "corresponding_pdf_source_for_selected_explanation",
              },
            }
          : null,
        ...snapshot.contexts.map((context) => ({
          type: context.type === "formula" ? "quote" : "pdf_reference",
          title: context.title,
          text: context.text,
          source: {
            kind: context.source,
            page_no: context.page_no,
            document_id: pack.document.id,
          },
        })),
        ...snapshot.attachments.map((attachment) => ({
          type: "file",
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
          data_url: attachment.data_url,
        })),
      ].filter(Boolean);

      const payload = {
        model: "gpt-5.5",
        answerMode: snapshot.answerMode,
        reasoningEffort: snapshot.reasoningEffort,
        document: pack.document,
        documentFile,
        page,
        messages: options.messages.map((message) => ({
          role: message.role,
          status: "success",
          content: messageText(message),
          parts: [{ type: "text", text: messageText(message) }],
        })),
        input: promptInput,
        parts,
        attachments: snapshot.attachments,
        context: [
          ...(selectedAgentContext ? [selectedAgentContext] : []),
          ...(selectedPdfSourceContext ? [selectedPdfSourceContext] : []),
          ...snapshot.contexts,
        ],
        selectedContext: snapshot.selectedContext ? selectedContextPayload(snapshot.selectedContext) : null,
        pdfContext: snapshot.pdfContext,
      };

      try {
        const response = await requestJson<{ message?: { content?: string }; content?: string }>(
          "/api/agent/chat",
          {
            method: "POST",
            body: JSON.stringify(payload),
            signal: options.abortSignal,
          },
          args.copy.errors.accountNotFound,
        );
        const content = response.message?.content || response.content;
        if (!content) throw new Error(args.copy.errors.emptyGatewayResult);
        for await (const partial of streamAssistantText(content, options.abortSignal, args.copy.errors.generationStopped)) {
          persistPartial(partial, "streaming");
          yield {
            content: [{ type: "text", text: partial }] satisfies ThreadAssistantMessagePart[],
            status: { type: "running" },
          };
        }
        persistPartial(content, "completed", true);
        await persistQueue;
        yield {
          content: [{ type: "text", text: content }] satisfies ThreadAssistantMessagePart[],
          status: { type: "complete", reason: "stop" },
        };
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          persistPartial("", "stopped", true);
          await persistQueue;
          throw error;
        }
        if (!args.isBackendOffline()) {
          persistPartial((error as Error).message, "failed", true);
          await persistQueue;
          throw error;
        }
        try {
          const local = [
            args.copy.agent.localPreviewIntro,
            selectedAgentContext ? args.copy.agent.localPreviewSelected(selectedAgentContext.title) : "",
            snapshot.contexts.length ? args.copy.agent.localPreviewContexts(snapshot.contexts.length) : args.copy.agent.localPreviewPage(page.page_no),
            snapshot.attachments.length ? args.copy.agent.localPreviewImages(snapshot.attachments.length) : "",
            latestUserText ? args.copy.agent.localPreviewQuestion(latestUserText) : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          for await (const partial of streamAssistantText(local, options.abortSignal, args.copy.errors.generationStopped)) {
            persistPartial(partial, "streaming");
            yield {
              content: [{ type: "text", text: partial }] satisfies ThreadAssistantMessagePart[],
              status: { type: "running" },
            };
          }
          persistPartial(local, "completed", true);
          await persistQueue;
          yield {
            content: [{ type: "text", text: local }] satisfies ThreadAssistantMessagePart[],
            status: { type: "complete", reason: "stop" },
          };
        } catch (localError) {
          persistPartial((localError as Error).name === "AbortError" ? "" : (localError as Error).message, (localError as Error).name === "AbortError" ? "stopped" : "failed", true);
          await persistQueue;
          throw localError;
        }
      } finally {
        args.clearSelectedContext();
      }
    },
  };
}

async function* streamAssistantText(text: string, signal: AbortSignal, stopMessage: string) {
  const chunks = chunkAssistantText(text);
  let partial = "";
  for (const chunk of chunks) {
    if (signal.aborted) throw new DOMException(stopMessage, "AbortError");
    partial += chunk;
    yield partial;
    await new Promise((resolve) => window.setTimeout(resolve, 12));
  }
}

function chunkAssistantText(text: string) {
  const chunks = text.match(/[\s\S]{1,24}/g);
  return chunks?.length ? chunks : [text];
}

type GeneratedTeachingPageResponse = {
  page: Partial<PageData> & {
    source?: Partial<PageData["source"]>;
    teaching?: Partial<PageData["teaching"]>;
  };
  model?: string;
};

function normalizeGeneratedPage(rawPage: GeneratedTeachingPageResponse["page"], fallback: PageData, copy: AppCopy): PageData {
  const normalized = normalizePack(
    {
      schema: "lecture_pairpack.v1",
      document: { id: "generated", title: "generated", source_pdf_url: "", page_count: 1 },
      pages: [{ ...rawPage, page_no: rawPage.page_no || fallback.page_no }],
    },
    copy,
  ).pages[0];
  return {
    ...fallback,
    ...normalized,
    page_no: fallback.page_no,
    source: {
      ...fallback.source,
      ...normalized.source,
      pdf_page_ref: normalized.source.pdf_page_ref || fallback.source.pdf_page_ref || `#page=${fallback.page_no}`,
      text_md: normalized.source.text_md || fallback.source.text_md,
      ocr_used: Boolean(normalized.source.ocr_used || fallback.source.ocr_used),
      parser: normalized.source.parser || fallback.source.parser || "pdfjs",
    },
    teaching: {
      ...fallback.teaching,
      ...normalized.teaching,
      slide_title: normalized.teaching.slide_title || fallback.teaching.slide_title || `PDF p.${fallback.page_no}`,
      speaker_notes_md: normalized.teaching.speaker_notes_md || fallback.teaching.speaker_notes_md,
      concepts: normalized.teaching.concepts.length ? normalized.teaching.concepts : fallback.teaching.concepts,
      visual_explanations: normalized.teaching.visual_explanations.length ? normalized.teaching.visual_explanations : fallback.teaching.visual_explanations,
      prerequisites: normalized.teaching.prerequisites.length ? normalized.teaching.prerequisites : fallback.teaching.prerequisites,
      confidence: Number.isFinite(normalized.teaching.confidence) ? normalized.teaching.confidence : fallback.teaching.confidence,
    },
    status: normalized.status || "ready",
  };
}

function mergePageIntoPack(pack: PagePack, page: PageData): PagePack {
  const pages = pack.pages.some((item) => item.page_no === page.page_no)
    ? pack.pages.map((item) => (item.page_no === page.page_no ? page : item))
    : [...pack.pages, page];
  return {
    ...pack,
    document: {
      ...pack.document,
      page_count: Math.max(pack.document.page_count || 0, pages.length, page.page_no),
    },
    pages: pages.slice().sort((left, right) => left.page_no - right.page_no),
  };
}

function pageWithSourceText(page: PageData, sourceText: string): PageData {
  return {
    ...page,
    source: {
      ...page.source,
      text_md: sourceText || page.source.text_md,
      parser: page.source.parser || "pdfjs",
    },
  };
}

function hasCompletedTeaching(page: PageData | undefined, outputLanguage?: TeachingOutputLanguage) {
  if (!page) return false;
  if (page.status === "failed" || page.status === "running" || !page.teaching.speaker_notes_md.trim()) return false;
  return !outputLanguage || page.teaching.output_language === outputLanguage;
}

function generationPageStatus(page: PageData | undefined, outputLanguage?: TeachingOutputLanguage): GenerationPageStatus {
  if (!page) return "pending";
  if (page.status === "running") return "running";
  if (page.status === "failed") return "failed";
  if (!page.teaching.speaker_notes_md.trim()) return "pending";
  if (outputLanguage && page.teaching.output_language !== outputLanguage) return "pending";
  return "done";
}

function generationStatusLabel(status: GenerationPageStatus, copy: AppCopy) {
  if (status === "done") return copy.topbar.generationStatusDone;
  if (status === "running") return copy.topbar.generationStatusRunning;
  if (status === "failed") return copy.topbar.generationStatusFailed;
  return copy.topbar.generationStatusPending;
}

export default function App() {
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => loadUiPreferences());
  const copy = useMemo(() => getAppCopy(uiPreferences.language), [uiPreferences.language]);
  const [pack, setPack] = useState<PagePack>(() => samplePacks[uiPreferences.language]);
  const [currentPageNo, setCurrentPageNo] = useState(1);
  const [pdfUrl, setPdfUrl] = useState("");
  const [activeTab, setActiveTab] = useState<"notes" | "structure" | "json">("notes");
  const [panels, setPanels] = useState<PanelVisibility>(fullPanelVisibility);
  const [query, setQuery] = useState("");
  const [oauthMode, setOauthMode] = useState<OAuthMode>("unknown");
  const [oauthAccount, setOauthAccount] = useState<string | null>(null);
  const [oauthDevice, setOauthDevice] = useState<OAuthDevicePrompt | null>(null);
  const [oauthCodeCopied, setOauthCodeCopied] = useState(false);
  const [oauthSecondsLeft, setOauthSecondsLeft] = useState(0);
  const [jobStatus, setJobStatus] = useState(copy.status.localPrototype);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [generateMenuOpen, setGenerateMenuOpen] = useState(false);
  const [generatePageMode, setGeneratePageMode] = useState<GeneratePageMode>("missing");
  const [generateRangeDraft, setGenerateRangeDraft] = useState("");
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [contexts, setContexts] = useState<AgentContextItem[]>([]);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [selectedContext, setSelectedContext] = useState<SelectedContext | null>(null);
  const [pdfTextContext, setPdfTextContext] = useState<PdfContextPayload | null>(null);
  const [pdfExtractedPages, setPdfExtractedPages] = useState<PdfContextPage[]>([]);
  const [isGeneratingNotes, setIsGeneratingNotes] = useState(false);
  const [generationDetailsOpen, setGenerationDetailsOpen] = useState(false);
  const [pendingSelectionPrompt, setPendingSelectionPrompt] = useState<QuickSelectionPrompt | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [courseProjects, setCourseProjects] = useState<CourseProjectRecord[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentItems, setDocumentItems] = useState<DocumentSidebarItem[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [courseDialogOpen, setCourseDialogOpen] = useState(false);
  const [courseDraftName, setCourseDraftName] = useState("");
  const [isRestoringWorkspace, setIsRestoringWorkspace] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "draft", message: copy.persistence.localDraft });
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
  const [persistentStorageState, setPersistentStorageState] = useState<PersistentStorageState>("unknown");
  const [persistedMessages, setPersistedMessages] = useState<ThreadMessageLike[]>([]);
  const [agentRuntimeKey, setAgentRuntimeKey] = useState("thread:initial");
  const lastSelectionRef = useRef<SelectedContext | null>(null);
  const currentPdfObjectUrlRef = useRef("");
  const pdfDirectFileCacheRef = useRef<{ url: string; filename: string; file: PdfDirectFileInput | null } | null>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const generateMenuRef = useRef<HTMLDivElement>(null);
  const jsonImportInputRef = useRef<HTMLInputElement>(null);
  const workspaceImportInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const pdfScrollViewerRef = useRef<PdfScrollViewerHandle>(null);
  const oauthPollTimerRef = useRef<number | null>(null);
  const oauthCountdownTimerRef = useRef<number | null>(null);
  const fullscreenIntentRef = useRef(false);
  const restoredOnceRef = useRef(false);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);

  const pdfNavigationPageCount = Math.max(pdfUrl ? pdfPageCount || pack.document.page_count || pack.pages.length : pack.pages.length, 1);
  const currentPdfPageNo = Math.min(Math.max(currentPageNo, 1), pdfNavigationPageCount);
  const teachingOutputLanguage = resolveTeachingOutputLanguage(uiPreferences);
  const pageLookup = useMemo(() => {
    const pagesByNumber = new Map<number, PageData>();
    const indexesByNumber = new Map<number, number>();
    pack.pages.forEach((item, index) => {
      pagesByNumber.set(item.page_no, item);
      indexesByNumber.set(item.page_no, index);
    });
    return { pagesByNumber, indexesByNumber };
  }, [pack.pages]);
  const page =
    pageLookup.pagesByNumber.get(currentPdfPageNo) ||
    pack.pages[Math.min(Math.max(currentPdfPageNo - 1, 0), Math.max(pack.pages.length - 1, 0))] ||
    samplePacks[uiPreferences.language].pages[0];
  const currentIndex = Math.max(0, pageLookup.indexesByNumber.get(page.page_no) ?? -1);
  const generatedPageCount = useMemo(
    () => pack.pages.filter((item) => hasCompletedTeaching(item, teachingOutputLanguage)).length,
    [pack.pages, teachingOutputLanguage],
  );
  const generationProgressPages = useMemo(() => Array.from({ length: pdfNavigationPageCount }, (_, index) => {
    const pageNo = index + 1;
    const progressPage = pageLookup.pagesByNumber.get(pageNo);
    return {
      pageNo,
      status: generationPageStatus(progressPage, teachingOutputLanguage),
    };
  }), [pageLookup.pagesByNumber, pdfNavigationPageCount, teachingOutputLanguage]);
  const generationProgressSummary = useMemo(() => generationProgressPages.reduce(
    (summary, item) => ({
      done: summary.done + (item.status === "done" ? 1 : 0),
      running: summary.running + (item.status === "running" ? 1 : 0),
      failed: summary.failed + (item.status === "failed" ? 1 : 0),
      pending: summary.pending + (item.status === "pending" ? 1 : 0),
    }),
    { done: 0, running: 0, failed: 0, pending: 0 },
  ), [generationProgressPages]);
  const generateScopeSummary =
    generatePageMode === "current"
      ? copy.topbar.generateScopeCurrent(currentPdfPageNo)
      : generatePageMode === "custom"
        ? copy.topbar.generateScopeCustomSummary(generateRangeDraft.trim() || copy.topbar.generateScopeCustomPlaceholder)
        : generatePageMode === "all"
          ? copy.topbar.generateScopeAll
          : copy.topbar.generateScopeMissing;
  const pdfOnly = !panels.rail && !panels.notes && !panels.agent;
  const fullWorkbench = panels.rail && panels.notes && panels.agent;
  const sidebarDocuments: DocumentSidebarItem[] = documentItems.length
    ? documentItems
    : [
        {
          id: pack.document.id,
          workspaceId: workspaceId || "sample",
          documentId: documentId || pack.document.id,
          title: pack.document.title,
          fileName: pack.document.source_pdf_url,
          mimeType: pdfUrl ? "application/pdf" : "application/json",
          pageCount: pdfPageCount || pack.document.page_count || pack.pages.length,
          currentPdfPageNumber: currentPdfPageNo,
          generatedPageCount,
          status: "ready",
          updatedAt: 0,
          uploadedAt: 0,
          isActive: true,
        },
      ];
  const sidebarProjects: CourseProjectRecord[] = courseProjects.length
    ? courseProjects
    : [
        {
          id: activeProjectId || "sample-course",
          workspaceId: workspaceId || "sample",
          name: copy.rail.defaultCourse,
          description: "",
          color: "clay",
          icon: "book-open",
          createdAt: 0,
          updatedAt: 0,
          lastOpenedAt: 0,
          documentCount: sidebarDocuments.length,
          activeDocumentId: documentId || pack.document.id,
        },
      ];
  const currentProjectId = activeProjectId || sidebarProjects[0]?.id || null;
  const activeProject = sidebarProjects.find((item) => item.id === currentProjectId) || sidebarProjects[0] || null;
  const normalizedDocumentQuery = query.trim().toLowerCase();
  const filteredProjects = sidebarProjects.filter((project) =>
    normalizedDocumentQuery ? project.name.toLowerCase().includes(normalizedDocumentQuery) : true,
  );
  const activeProjectDocuments = currentProjectId
    ? sidebarDocuments.filter((item) => item.projectId === currentProjectId || (!item.projectId && currentProjectId === activeProject?.id))
    : sidebarDocuments;
  const documentsForSidebar = normalizedDocumentQuery
    ? sidebarDocuments.filter((item) => `${item.title} ${item.fileName}`.toLowerCase().includes(normalizedDocumentQuery))
    : activeProjectDocuments;
  const recentDocuments = sidebarDocuments
    .slice()
    .sort((left, right) => (right.lastOpenedAt || right.updatedAt) - (left.lastOpenedAt || left.updatedAt))
    .filter((item) => item.documentId !== documentId)
    .slice(0, 4);
  const visiblePaneCount = 1 + Number(panels.rail) + Number(panels.notes) + Number(panels.agent);
  const pdfViewerSrc = pdfUrl
    ? `${pdfUrl}#page=${currentPdfPageNo}&toolbar=0&navpanes=0&scrollbar=0&view=FitH`
    : "";
  const pdfViewMode: PdfViewMode = uiPreferences.pdfViewMode || "continuous";
  const { toolbar: selectionToolbar, clearSelection } = usePageSelection({
    documentTitle: pack.document.title,
    page,
    copy,
    setLastSelection: (context) => {
      lastSelectionRef.current = context;
    },
  });

  const togglePanel = useCallback((key: PanelKey) => {
    setPanels((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const exitPdfFullscreen = useCallback(async () => {
    fullscreenIntentRef.current = false;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }
    setPanels(fullPanelVisibility);
  }, []);

  const enterPdfFullscreen = useCallback(async () => {
    setPanels({ rail: false, notes: false, agent: false });
    fullscreenIntentRef.current = true;

    const target = appShellRef.current;
    if (!target?.requestFullscreen) {
      fullscreenIntentRef.current = false;
      setJobStatus("当前浏览器不支持全屏，已切换到 PDF 专注模式");
      return;
    }

    if (!document.fullscreenElement) {
      await target.requestFullscreen().catch(() => {
        fullscreenIntentRef.current = false;
        setJobStatus("浏览器未允许全屏，已切换到 PDF 专注模式");
      });
    }
  }, []);

  const togglePdfOnly = useCallback(() => {
    if (isBrowserFullscreen || pdfOnly) {
      void exitPdfFullscreen();
      return;
    }
    void enterPdfFullscreen();
  }, [enterPdfFullscreen, exitPdfFullscreen, isBrowserFullscreen, pdfOnly]);

  const openSettings = useCallback((section: SettingsSection = "general") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const closeCommandMenu = useCallback(() => {
    setCommandMenuOpen(false);
  }, []);

  const updatePreference = useCallback(<K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => {
    setUiPreferences((current) => ({ ...current, [key]: value }));
  }, []);

  const resetPreferences = useCallback(() => {
    setUiPreferences(defaultUiPreferences);
    window.localStorage.removeItem(uiPreferencesStorageKey);
    setJobStatus(getAppCopy(defaultUiPreferences.language).status.preferencesReset);
  }, []);

  const stopOAuthTimers = useCallback(() => {
    if (oauthPollTimerRef.current !== null) {
      window.clearInterval(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
    if (oauthCountdownTimerRef.current !== null) {
      window.clearInterval(oauthCountdownTimerRef.current);
      oauthCountdownTimerRef.current = null;
    }
  }, []);

  const getSnapshot = useCallback(
    () => ({
      contexts,
      attachments,
      selectedContext,
      pdfContext: pdfUrl ? pdfTextContext : buildPdfContextFromPack(pack, uiPreferences),
      answerMode: uiPreferences.agentAnswerMode,
      reasoningEffort: agentAnswerModeReasoningEffort(uiPreferences.agentAnswerMode),
    }),
    [attachments, contexts, pack, pdfTextContext, pdfUrl, selectedContext, uiPreferences],
  );
  const getDocumentFile = useCallback(async () => {
    if (!pdfUrl) return null;
    const filename = pack.document.source_pdf_url || pack.document.title || "document.pdf";
    const cached = pdfDirectFileCacheRef.current;
    if (cached?.url === pdfUrl && cached.filename === filename) return cached.file;
    const file = await pdfDirectFileInputFromUrl(pdfUrl, filename).catch(() => null);
    pdfDirectFileCacheRef.current = { url: pdfUrl, filename, file };
    return file;
  }, [pack.document.source_pdf_url, pack.document.title, pdfUrl]);
  const getPack = useCallback(() => pack, [pack]);
  const getPage = useCallback(() => page, [page]);

  const focusComposer = useCallback(() => {
    window.setTimeout(() => composerInputRef.current?.focus(), 20);
  }, []);

  const captureSelection = useCallback((context = selectionToolbar?.context || lastSelectionRef.current) => {
    if (!context) {
      setJobStatus(copy.status.noSelection);
      return;
    }
    setSelectedContext(context);
    setPanels((current) => ({ ...current, agent: true }));
    clearSelection();
    focusComposer();
    setJobStatus(copy.status.selectionAdded);
  }, [clearSelection, copy.status.noSelection, copy.status.selectionAdded, focusComposer, selectionToolbar?.context]);

  const sendSelectionPrompt = useCallback((context: SelectedContext, intent: "explain" | "summarize") => {
    const label = selectedContextSourceLabel(context, copy);
    const prompt = intent === "explain"
      ? copy.agent.quickExplainPrompt(label)
      : copy.agent.quickSummarizePrompt(label);
    setSelectedContext(context);
    setPanels((current) => ({ ...current, agent: true }));
    setPendingSelectionPrompt({ id: createId("quick_prompt"), prompt, context });
    clearSelection();
    setJobStatus(intent === "explain" ? copy.status.explainingSelection : copy.status.summarizingSelection);
  }, [clearSelection, copy]);

  const refreshStorageEstimate = useCallback(async () => {
    const estimate = await estimateStorage();
    setStorageEstimate(estimate);
    setPersistentStorageState(
      estimate.persisted === true
        ? "persisted"
        : estimate.persisted === false
          ? "best-effort"
          : "unknown",
    );
    return estimate;
  }, []);

  const persistOperation = useCallback(async <T,>(operation: () => Promise<T>, successMessage?: string) => {
    setSaveState({ kind: "saving", message: copy.persistence.saving });
    try {
      const result = await operation();
      setSaveState({ kind: "saved", message: successMessage || copy.persistence.saved, updatedAt: Date.now() });
      void refreshStorageEstimate().catch(() => undefined);
      return result;
    } catch (error) {
      const classified = classifyPersistenceError(error);
      setSaveState({
        kind: classified.kind === "quota" ? "quota" : "error",
        message: classified.kind === "quota" ? copy.persistence.quota : `${copy.persistence.failed}: ${classified.message}`,
        updatedAt: Date.now(),
      });
      throw error;
    }
  }, [copy.persistence.failed, copy.persistence.quota, copy.persistence.saved, copy.persistence.saving, refreshStorageEstimate]);

  const persistChatMessage = useCallback(async (input: ChatPersistInput) => {
    if (!workspaceId || !threadId) return;
    const now = Date.now();
    const baseRecord: ChatMessageRecord = {
      id: input.id,
      threadId,
      workspaceId,
      documentId: documentId || undefined,
      role: input.role,
      content: input.content,
      contentMarkdown: input.content,
      selectedContext: input.selectedContext ?? null,
      sourceRefs: input.sourceRefs || [],
      status: input.status,
      createdAt: input.createdAt || now,
      updatedAt: now,
    };
    await persistOperation(async () => {
      if (input.role === "assistant") {
        await updateStreamingMessage({
          id: input.id,
          threadId,
          workspaceId,
          documentId: documentId || undefined,
          content: input.content,
          status: input.status,
          selectedContext: input.selectedContext ?? null,
          sourceRefs: input.sourceRefs || [],
        });
      } else {
        await saveChatMessage(baseRecord);
      }
    });
    setPersistedMessages((messages) => upsertThreadMessage(messages, chatMessageToThreadMessageLike(baseRecord)));
  }, [documentId, persistOperation, threadId, workspaceId]);

  const replacePdfObjectUrl = useCallback((nextUrl: string) => {
    if (currentPdfObjectUrlRef.current) {
      URL.revokeObjectURL(currentPdfObjectUrlRef.current);
    }
    pdfDirectFileCacheRef.current = null;
    currentPdfObjectUrlRef.current = nextUrl;
    setPdfUrl(nextUrl);
  }, []);

  const currentLayoutState = useCallback(() => workspaceLayoutSnapshot({
    panels,
    activeTab,
    query,
    activeProjectId,
    contexts,
    attachments,
  }), [activeProjectId, activeTab, attachments, contexts, panels, query]);

  const forceSaveSnapshot = useCallback(async () => {
    await persistOperation(async () => {
      await saveSettings(uiPreferences, workspaceId || "global");
      if (!workspaceId) return;
      await saveWorkspacePatch(workspaceId, {
        activeProjectId: activeProjectId || undefined,
        currentPdfPageNumber: currentPdfPageNo,
        currentGeneratedPageIndex: currentIndex,
        layoutState: currentLayoutState(),
        settingsSnapshot: uiPreferences,
      });
      if (documentId) {
        if (pack.document.id !== documentId) return;
        await saveDocumentPatch(documentId, {
          currentPdfPageNumber: currentPdfPageNo,
          pageCount: pdfPageCount || pack.document.page_count || pack.pages.length,
        });
        await saveGeneratedPagesFromPack({ workspaceId, documentId, pack });
        if (selectedContext) {
          await saveSelectedContext({
            workspaceId,
            documentId,
            context: asPersistedRecord(selectedContextPayload(selectedContext)) as Record<string, unknown> & {
              id?: string;
              text?: string;
              sourceType?: string;
              pdfPageNumber?: number;
              generatedPageNumber?: number;
              sectionTitle?: string;
              selectionRects?: Record<string, unknown>[];
              pdfSource?: Record<string, unknown>;
            },
          });
        } else {
          await clearPersistedSelectedContext(workspaceId, documentId);
        }
      }
    }, copy.persistence.saved);
  }, [
    copy.persistence.saved,
    activeProjectId,
    currentIndex,
    currentLayoutState,
    currentPdfPageNo,
    documentId,
    pack,
    pdfPageCount,
    persistOperation,
    selectedContext,
    uiPreferences,
    workspaceId,
  ]);

  const resetLocalWorkspaceState = useCallback(() => {
    replacePdfObjectUrl("");
    setWorkspaceId(null);
    setActiveProjectId(null);
    setCourseProjects([]);
    setDocumentId(null);
    setDocumentItems([]);
    setThreadId(null);
    setPdfPageCount(null);
    setCurrentPageNo(1);
    setSelectedContext(null);
    setPdfTextContext(null);
    setPdfExtractedPages([]);
    setContexts([]);
    setAttachments([]);
    setPersistedMessages([]);
    setAgentRuntimeKey(`thread:initial:${Date.now()}`);
    setPack(samplePacks[uiPreferences.language]);
  }, [replacePdfObjectUrl, uiPreferences.language]);

  const refreshDocumentItems = useCallback(async (
    nextWorkspaceId = workspaceId,
    activeDocumentId = documentId,
    nextActiveProjectId = activeProjectId,
  ) => {
    if (!nextWorkspaceId) {
      setDocumentItems([]);
      setCourseProjects([]);
      return [];
    }
    const [projects, items] = await Promise.all([
      loadCourseProjects(nextWorkspaceId, nextActiveProjectId),
      loadWorkspaceDocuments(nextWorkspaceId, activeDocumentId),
    ]);
    setCourseProjects(projects);
    if (nextActiveProjectId) setActiveProjectId(nextActiveProjectId);
    setDocumentItems(items);
    return items;
  }, [activeProjectId, documentId, workspaceId]);

  const applyLoadedWorkspace = useCallback((
    loaded: LoadedWorkspace,
    options: { restoreLayout?: boolean } = {},
  ) => {
    const restoredPreferences = settingsRecordToPreferences(loaded.settings || loaded.workspace.settingsSnapshot);
    const restoredCopy = getAppCopy(restoredPreferences.language);
    setUiPreferences(restoredPreferences);
    setWorkspaceId(loaded.workspace.id);
    setActiveProjectId(loaded.activeProject?.id || loaded.workspace.activeProjectId || null);
    setCourseProjects(loaded.courseProjects);
    setDocumentId(loaded.document?.id || null);
    setDocumentItems(loaded.documentItems);
    setThreadId(loaded.thread?.id || null);
    setPdfTextContext(null);
    setPdfExtractedPages([]);

    if (options.restoreLayout) {
      const layout = (loaded.workspace.layoutState || {}) as {
        panels?: unknown;
        activeTab?: unknown;
        query?: unknown;
        activeProjectId?: unknown;
        contexts?: unknown;
        attachments?: unknown;
      };
      if (isPanelVisibility(layout.panels)) setPanels(layout.panels);
      if (isActiveTab(layout.activeTab)) setActiveTab(layout.activeTab);
      if (typeof layout.query === "string") setQuery(layout.query);
      if (typeof layout.activeProjectId === "string") setActiveProjectId(layout.activeProjectId);
      if (Array.isArray(layout.contexts)) setContexts(layout.contexts as AgentContextItem[]);
      if (Array.isArray(layout.attachments)) setAttachments(layout.attachments as AgentAttachment[]);
    } else {
      setContexts([]);
      setAttachments([]);
    }

    if (loaded.document) {
      const restoredPack = pagePackFromPersistence(loaded.document, loaded.generatedPages, restoredCopy);
      const pageCount = loaded.document.pageCount || restoredPack.pages.length || 1;
      setPack(restoredPack);
      setPdfPageCount(loaded.document.pageCount || null);
      setCurrentPageNo(
        Math.min(
          Math.max(loaded.workspace.currentPdfPageNumber || loaded.document.currentPdfPageNumber || 1, 1),
          Math.max(pageCount, 1),
        ),
      );
      if (loaded.pdfBlob?.blob) {
        replacePdfObjectUrl(URL.createObjectURL(loaded.pdfBlob.blob));
      } else {
        replacePdfObjectUrl("");
        if (loaded.document.pdfBlobId) {
          setJobStatus(restoredCopy.persistence.pdfMissing);
          setSaveState({ kind: "error", message: restoredCopy.persistence.pdfMissing, updatedAt: Date.now() });
        }
      }
    } else {
      replacePdfObjectUrl("");
      setPack(samplePacks[restoredPreferences.language]);
      setPdfPageCount(null);
      setPdfExtractedPages([]);
      setCurrentPageNo(1);
    }

    setSelectedContext((loaded.selectedContext?.payload as unknown as SelectedContext) || null);
    const restoredMessages = loaded.messages.map(chatMessageToThreadMessageLike);
    setPersistedMessages(restoredMessages);
    setAgentRuntimeKey(`${loaded.thread?.id || "thread"}:${restoredMessages.length}:${loaded.workspace.updatedAt}`);
  }, [replacePdfObjectUrl]);

  const handleSaveStatusClick = useCallback(() => {
    if (saveState.kind === "error" || saveState.kind === "quota") {
      void forceSaveSnapshot().catch(() => undefined);
      return;
    }
    openSettings("storage");
  }, [forceSaveSnapshot, openSettings, saveState.kind]);

  useEffect(() => {
    let cancelled = false;

    const restoreWorkspace = async () => {
      setIsRestoringWorkspace(true);
      try {
        const loaded = await loadLastWorkspace();
        if (cancelled) return;
        const persistent = await navigator.storage?.persisted?.().catch(() => null);
        if (!cancelled) {
          setPersistentStorageState(
            persistent === true
              ? "persisted"
              : persistent === false
                ? "best-effort"
                : "unsupported",
          );
        }

        if (!loaded) {
          setSaveState({ kind: "draft", message: getAppCopy(uiPreferences.language).persistence.localDraft });
          void refreshStorageEstimate().catch(() => undefined);
          return;
        }

        const restoredPreferences = settingsRecordToPreferences(loaded.settings || loaded.workspace.settingsSnapshot);
        applyLoadedWorkspace(loaded, { restoreLayout: true });
        setSaveState({ kind: "saved", message: getAppCopy(restoredPreferences.language).persistence.restored, updatedAt: Date.now() });
        void refreshStorageEstimate().catch(() => undefined);
      } catch (error) {
        if (!cancelled) {
          setSaveState({ kind: "error", message: (error as Error).message || getAppCopy(uiPreferences.language).persistence.restoreFailed, updatedAt: Date.now() });
          setJobStatus((error as Error).message || getAppCopy(uiPreferences.language).persistence.restoreFailed);
        }
      } finally {
        if (!cancelled) {
          restoredOnceRef.current = true;
          setIsRestoringWorkspace(false);
        }
      }
    };

    void restoreWorkspace();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (currentPdfObjectUrlRef.current) {
      URL.revokeObjectURL(currentPdfObjectUrlRef.current);
      currentPdfObjectUrlRef.current = "";
    }
  }, []);

  useEffect(() => {
    if (isRestoringWorkspace || !restoredOnceRef.current) return undefined;
    const timer = window.setTimeout(() => {
      void persistOperation(() => saveSettings(uiPreferences, workspaceId || "global")).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [isRestoringWorkspace, persistOperation, uiPreferences, workspaceId]);

  useEffect(() => {
    if (isRestoringWorkspace || !restoredOnceRef.current || !workspaceId) return undefined;
    const timer = window.setTimeout(() => {
      void persistOperation(async () => {
        await saveWorkspacePatch(workspaceId, {
          activeProjectId: activeProjectId || undefined,
          currentPdfPageNumber: currentPdfPageNo,
          currentGeneratedPageIndex: currentIndex,
          layoutState: currentLayoutState(),
          settingsSnapshot: uiPreferences,
        });
        if (documentId && pack.document.id === documentId) {
          await saveDocumentPatch(documentId, {
            currentPdfPageNumber: currentPdfPageNo,
            pageCount: pdfPageCount || pack.document.page_count || pack.pages.length,
          });
        }
      }).catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    currentIndex,
    currentLayoutState,
    currentPdfPageNo,
    activeProjectId,
    documentId,
    isRestoringWorkspace,
    pack.document.id,
    pack.document.page_count,
    pack.pages.length,
    pdfPageCount,
    persistOperation,
    uiPreferences,
    workspaceId,
  ]);

  useEffect(() => {
    if (isRestoringWorkspace || !restoredOnceRef.current || !workspaceId || !documentId) return undefined;
    const timer = window.setTimeout(() => {
      void persistOperation(async () => {
        if (selectedContext) {
          await saveSelectedContext({
            workspaceId,
            documentId,
            context: asPersistedRecord(selectedContextPayload(selectedContext)) as Record<string, unknown> & {
              id?: string;
              text?: string;
              sourceType?: string;
              pdfPageNumber?: number;
              generatedPageNumber?: number;
              sectionTitle?: string;
              selectionRects?: Record<string, unknown>[];
              pdfSource?: Record<string, unknown>;
            },
          });
        } else {
          await clearPersistedSelectedContext(workspaceId, documentId);
        }
      }).catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [documentId, isRestoringWorkspace, persistOperation, selectedContext, workspaceId]);

  useEffect(() => {
    if (isRestoringWorkspace || !restoredOnceRef.current || !workspaceId || !documentId || pack.document.id !== documentId) return undefined;
    const timer = window.setTimeout(() => {
      void persistOperation(() => saveGeneratedPagesFromPack({ workspaceId, documentId, pack })).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [documentId, isRestoringWorkspace, pack, persistOperation, workspaceId]);

  useEffect(() => {
    if (!documentId || pack.document.id !== documentId) return;
    setDocumentItems((items) => items.map((item) =>
      item.documentId === documentId
        ? {
            ...item,
            title: pack.document.title,
            fileName: pack.document.source_pdf_url,
            pageCount: pdfPageCount || pack.document.page_count || pack.pages.length,
            currentPdfPageNumber: currentPdfPageNo,
            generatedPageCount,
            projectId: item.projectId || activeProjectId || undefined,
            isActive: true,
          }
        : { ...item, isActive: false },
    ));
  }, [
    currentPdfPageNo,
    activeProjectId,
    documentId,
    generatedPageCount,
    pack.document.id,
    pack.document.source_pdf_url,
    pack.document.title,
    pack.document.page_count,
    pack.pages.length,
    pdfPageCount,
  ]);

  useEffect(() => {
    if (isRestoringWorkspace || !restoredOnceRef.current) return undefined;
    const flushSnapshot = () => {
      void forceSaveSnapshot().catch(() => undefined);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushSnapshot();
    };
    window.addEventListener("pagehide", flushSnapshot);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushSnapshot);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [forceSaveSnapshot, isRestoringWorkspace]);

  useEffect(() => {
    if (!commandMenuOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && commandMenuRef.current?.contains(target)) return;
      setCommandMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCommandMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [commandMenuOpen]);

  useEffect(() => {
    if (!generateMenuOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && generateMenuRef.current?.contains(target)) return;
      setGenerateMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGenerateMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [generateMenuOpen]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFullscreen = document.fullscreenElement === appShellRef.current;
      setIsBrowserFullscreen(isFullscreen);

      if (!document.fullscreenElement && fullscreenIntentRef.current) {
        fullscreenIntentRef.current = false;
        setPanels(fullPanelVisibility);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      root.dataset.pagepairTheme = uiPreferences.theme;
      root.dataset.pagepairResolvedTheme =
        uiPreferences.theme === "system" ? (media.matches ? "dark" : "light") : uiPreferences.theme;
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [uiPreferences.theme]);

  useEffect(() => {
    document.documentElement.lang = uiPreferences.language === "en-US" ? "en" : "zh-CN";
    document.documentElement.dataset.pagepairLanguage = uiPreferences.language;
  }, [uiPreferences.language]);

  useEffect(() => {
    if (pdfUrl) setPdfTextContext(null);
  }, [pdfUrl, uiPreferences.pdfContextEdgePageCount, uiPreferences.pdfContextFullPageLimit]);

  useEffect(() => {
    setPack((current) => {
      if (current.document.id !== "demo_course_pdf" || current.document.source_pdf_url) return current;
      return samplePacks[uiPreferences.language];
    });
  }, [uiPreferences.language]);

  useEffect(() => {
    if (!uiPreferences.autoSaveSession) {
      window.localStorage.setItem(uiPreferencesStorageKey, JSON.stringify({ autoSaveSession: false }));
      return;
    }
    window.localStorage.setItem(uiPreferencesStorageKey, JSON.stringify(uiPreferences));
  }, [uiPreferences]);

  const refreshOAuthStatus = async () => {
    try {
      const status = await requestJson<{
        authenticated: boolean;
        accounts?: Array<{ is_default?: boolean; login?: string; id?: string }>;
      }>("/auth/openai/status");
      const account = status.accounts?.find((item) => item.is_default) || status.accounts?.[0];
      setOauthMode(status.authenticated ? "connected" : "ready");
      setOauthAccount(account?.login || account?.id || null);
    } catch {
      setOauthMode("offline");
      setOauthAccount(null);
    }
  };

  const copyOAuthUserCode = useCallback(async () => {
    if (!oauthDevice) return;
    await navigator.clipboard?.writeText(oauthDevice.user_code).catch(() => undefined);
    setOauthCodeCopied(true);
    setJobStatus(copy.status.codeCopied(oauthDevice.user_code));
    window.setTimeout(() => setOauthCodeCopied(false), 1800);
  }, [copy, oauthDevice]);

  const openOAuthVerification = useCallback(() => {
    if (!oauthDevice) return;
    window.open(oauthDevice.verification_uri, "_blank", "noopener,noreferrer");
    setJobStatus(copy.status.enterCode(oauthDevice.user_code));
  }, [copy, oauthDevice]);

  const cancelOAuthLogin = useCallback(() => {
    stopOAuthTimers();
    setOauthDevice(null);
    setOauthSecondsLeft(0);
    setOauthCodeCopied(false);
    setOauthMode((mode) => (mode === "polling" ? "ready" : mode));
    setJobStatus(copy.status.oauthCanceled);
  }, [copy.status.oauthCanceled, stopOAuthTimers]);

  const connectOAuth = async () => {
    try {
      if (oauthMode === "polling" && oauthDevice) {
        await copyOAuthUserCode();
        return;
      }
      const status = await requestJson<{ authenticated: boolean }>("/auth/openai/status");
      if (status.authenticated) {
        stopOAuthTimers();
        await requestJson("/auth/openai/logout", { method: "POST" });
        setOauthMode("ready");
        setOauthAccount(null);
        setOauthDevice(null);
        setOauthSecondsLeft(0);
        setJobStatus(copy.status.oauthDisconnected);
        return;
      }
      stopOAuthTimers();
      const device = await requestJson<{
        user_code: string;
        device_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      }>("/auth/openai/start", { method: "POST" });
      const expiresAt = Date.now() + device.expires_in * 1000;
      const nextDevice = { ...device, expires_at_ms: expiresAt };
      setOauthDevice(nextDevice);
      setOauthSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
      setOauthCodeCopied(false);
      await navigator.clipboard?.writeText(device.user_code).catch(() => undefined);
      setOauthCodeCopied(true);
      window.setTimeout(() => setOauthCodeCopied(false), 1800);
      setOauthMode("polling");
      setJobStatus(copy.status.codeShown(device.user_code));

      oauthCountdownTimerRef.current = window.setInterval(() => {
        const secondsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        setOauthSecondsLeft(secondsLeft);
      }, 1000);

      const pollOnce = async () => {
        if (Date.now() > expiresAt) {
          stopOAuthTimers();
          setOauthMode("ready");
          setOauthDevice(null);
          setOauthSecondsLeft(0);
          setJobStatus(copy.status.codeExpired);
          return;
        }
        try {
          const account = await requestJson<{ login?: string; id?: string } | null>(
            "/auth/openai/poll",
            {
              method: "POST",
              body: JSON.stringify({ device_code: device.device_code }),
            },
          );
          if (!account) return;
          stopOAuthTimers();
          setOauthMode("connected");
          setOauthAccount(account.login || account.id || null);
          setOauthDevice(null);
          setOauthSecondsLeft(0);
          setOauthCodeCopied(false);
          setJobStatus(copy.status.oauthConnected);
        } catch (error) {
          stopOAuthTimers();
          setOauthMode("ready");
          setOauthDevice(null);
          setOauthSecondsLeft(0);
          setOauthCodeCopied(false);
          setJobStatus((error as Error).message);
        }
      };

      void pollOnce();
      oauthPollTimerRef.current = window.setInterval(pollOnce, Math.max(device.interval || 8, 8) * 1000);
    } catch {
      stopOAuthTimers();
      setOauthDevice(null);
      setOauthSecondsLeft(0);
      setOauthMode((mode) => (mode === "mock" ? "offline" : "mock"));
      setOauthAccount((account) => (account ? null : "static preview"));
      setJobStatus(copy.status.oauthBackendMock);
    }
  };

  useEffect(() => {
    void refreshOAuthStatus();
  }, []);

  useEffect(() => () => stopOAuthTimers(), [stopOAuthTimers]);

  const loadPdf = (file: File) => {
    const url = URL.createObjectURL(file);
    replacePdfObjectUrl(url);
    setDocumentId(null);
    setThreadId(null);
    setPdfPageCount(null);
    setCurrentPageNo(1);
    setSelectedContext(null);
    setPdfTextContext(null);
    setPdfExtractedPages([]);
    setContexts([]);
    setAttachments([]);
    setPersistedMessages([]);
    setDocumentItems((items) => items.map((item) => ({ ...item, isActive: false })));
    const title = file.name.replace(/\.pdf$/i, "") || file.name || "Untitled PDF";
    setPack(createDraftPagePack(title, file.name, 1));

    void persistOperation(async () => {
      const saved = await savePdfBlob({
        workspaceId,
        projectId: activeProjectId,
        file,
        settingsSnapshot: uiPreferences,
        layoutState: currentLayoutState(),
      });
      setWorkspaceId(saved.workspace.id);
      setActiveProjectId(saved.workspace.activeProjectId || saved.document.projectId || null);
      setDocumentId(saved.document.id);
      await refreshDocumentItems(saved.workspace.id, saved.document.id, saved.workspace.activeProjectId || saved.document.projectId || null);
      setThreadId(saved.thread.id);
      setPersistedMessages([]);
      setAgentRuntimeKey(`${saved.thread.id}:0:${Date.now()}`);
      setPack(createDraftPagePack(saved.document.title, saved.document.fileName, Math.max(saved.document.pageCount || 1, 1), saved.document.id));
      return saved;
    }, copy.persistence.uploadSaved).catch((error) => {
      setJobStatus((error as Error).message || copy.persistence.failed);
    });
  };

  const handlePdfDocumentReady = useCallback((pageCount: number) => {
    setPdfPageCount(pageCount);
    setCurrentPageNo((current) => Math.min(Math.max(current, 1), Math.max(pageCount, 1)));
    setPack((current) => {
      if (current.pages.every((item) => item.status === "draft" && !item.teaching.speaker_notes_md)) {
        return createDraftPagePack(current.document.title, current.document.source_pdf_url, pageCount, current.document.id);
      }
      return {
        ...current,
        document: {
          ...current.document,
          page_count: pageCount,
        },
      };
    });
    if (documentId && pack.document.id === documentId) {
      setDocumentItems((items) => items.map((item) =>
        item.documentId === documentId
          ? { ...item, pageCount, currentPdfPageNumber: currentPdfPageNo, generatedPageCount, status: "ready" }
          : item,
      ));
    }
    if (workspaceId && documentId && pack.document.id === documentId) {
      void persistOperation(async () => {
        await saveWorkspacePatch(workspaceId, { currentPdfPageNumber: currentPdfPageNo });
        await saveDocumentPatch(documentId, {
          pageCount,
          currentPdfPageNumber: currentPdfPageNo,
          status: "ready",
        });
      }).catch(() => undefined);
    }
  }, [currentPdfPageNo, documentId, generatedPageCount, pack.document.id, persistOperation, workspaceId]);

  const handlePdfContextReady = useCallback((context: PdfContextPayload) => {
    setPdfTextContext(context);
  }, []);

  const handlePdfPagesTextReady = useCallback((pages: PdfContextPage[]) => {
    setPdfExtractedPages(pages);
  }, []);

  const loadJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = normalizePack(JSON.parse(String(reader.result)), copy);
        replacePdfObjectUrl("");
        setDocumentId(null);
        setThreadId(null);
        setPdfPageCount(null);
        setPdfTextContext(null);
        setPdfExtractedPages([]);
        setCurrentPageNo(next.pages[0]?.page_no || 1);
        setSelectedContext(null);
        setContexts([]);
        setAttachments([]);
        setPersistedMessages([]);
        setDocumentItems((items) => items.map((item) => ({ ...item, isActive: false })));
        setPack(next);
        setJobStatus(copy.status.jsonImported);
        void persistOperation(async () => {
          const saved = await saveImportedPagePack({
            workspaceId,
            projectId: activeProjectId,
            pack: next,
            settingsSnapshot: uiPreferences,
            layoutState: currentLayoutState(),
          });
          setWorkspaceId(saved.workspace.id);
          setActiveProjectId(saved.workspace.activeProjectId || saved.document.projectId || null);
          setDocumentId(saved.document.id);
          await refreshDocumentItems(saved.workspace.id, saved.document.id, saved.workspace.activeProjectId || saved.document.projectId || null);
          setThreadId(saved.thread.id);
          setAgentRuntimeKey(`${saved.thread.id}:0:${Date.now()}`);
          setPack({
            ...next,
            document: {
              ...next.document,
              id: saved.document.id,
              title: saved.document.title,
              source_pdf_url: saved.document.fileName,
              page_count: saved.document.pageCount || next.document.page_count,
            },
          });
          return saved;
        }, copy.persistence.saved).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
      } catch (error) {
        setJobStatus((error as Error).message);
      }
    };
    reader.readAsText(file);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${pack.document.id || "lecture"}-pairpack.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const exportCurrentWorkspace = useCallback(() => {
    if (!workspaceId) {
      openSettings("storage");
      return;
    }
    void persistOperation(async () => {
      await forceSaveSnapshot();
      const payload = await exportWorkspace(workspaceId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${payload.workspace.title || "pagepair-workspace"}-workspace.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }, copy.persistence.workspaceExported).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [copy.persistence.failed, copy.persistence.workspaceExported, forceSaveSnapshot, openSettings, persistOperation, workspaceId]);

  const importWorkspaceBackup = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      void persistOperation(async () => {
        const payload = JSON.parse(String(reader.result)) as ExportedWorkspace;
        await importWorkspace(payload);
      }, copy.persistence.workspaceImported)
        .then(() => {
          window.setTimeout(() => window.location.reload(), 80);
        })
        .catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
    };
    reader.onerror = () => setJobStatus(reader.error?.message || copy.persistence.failed);
    reader.readAsText(file);
  }, [copy.persistence.failed, copy.persistence.workspaceImported, persistOperation]);

  const clearCurrentWorkspace = useCallback(() => {
    if (!workspaceId) return;
    void persistOperation(async () => {
      await clearWorkspace(workspaceId);
      resetLocalWorkspaceState();
    }, copy.persistence.workspaceCleared)
      .then(() => void refreshStorageEstimate().catch(() => undefined))
      .catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [copy.persistence.failed, copy.persistence.workspaceCleared, persistOperation, refreshStorageEstimate, resetLocalWorkspaceState, workspaceId]);

  const resetCurrentWorkspace = useCallback(() => {
    if (workspaceId) {
      void clearWorkspace(workspaceId).catch(() => undefined);
    }
    resetLocalWorkspaceState();
    setSaveState({ kind: "draft", message: copy.persistence.localDraft, updatedAt: Date.now() });
    void refreshStorageEstimate().catch(() => undefined);
  }, [copy.persistence.localDraft, refreshStorageEstimate, resetLocalWorkspaceState, workspaceId]);

  const enablePersistentStorage = useCallback(() => {
    void persistOperation(async () => {
      const granted = await requestPersistentStorage();
      await refreshStorageEstimate();
      setPersistentStorageState(
        granted === true
          ? "persisted"
          : granted === false
            ? "best-effort"
            : "unsupported",
      );
      setJobStatus(granted ? copy.persistence.persistentEnabled : copy.persistence.persistentUnavailable);
    }, copy.persistence.saved).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [
    copy.persistence.failed,
    copy.persistence.persistentEnabled,
    copy.persistence.persistentUnavailable,
    copy.persistence.saved,
    persistOperation,
    refreshStorageEstimate,
  ]);

  const repairLocalStorage = useCallback(() => {
    void persistOperation(async () => {
      const result = await repairWorkspaceStorage(workspaceId);
      await refreshStorageEstimate();
      setJobStatus(copy.persistence.storageRepaired(storageRepairCount(result)));
    }, copy.persistence.saved).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [copy.persistence, persistOperation, refreshStorageEstimate, workspaceId]);

  const startNewPersistedConversation = useCallback(() => {
    setPersistedMessages([]);
    setAgentRuntimeKey(`thread:local:${Date.now()}`);
    if (!workspaceId) return;
    void persistOperation(async () => {
      const thread = await createChatThread({
        workspaceId,
        documentId: documentId || undefined,
        title: "Main chat",
      });
      setThreadId(thread.id);
      setAgentRuntimeKey(`${thread.id}:0:${Date.now()}`);
      if (documentId) await clearPersistedSelectedContext(workspaceId, documentId);
    }).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [copy.persistence.failed, documentId, persistOperation, workspaceId]);

  const switchDocument = useCallback((nextDocumentId: string) => {
    if (!workspaceId || nextDocumentId === documentId) return;
    void persistOperation(async () => {
      await forceSaveSnapshot();
      const loaded = await loadWorkspaceDocument(workspaceId, nextDocumentId);
      applyLoadedWorkspace(loaded);
      return loaded;
    }, copy.persistence.restored).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [
    applyLoadedWorkspace,
    copy.persistence.failed,
    copy.persistence.restored,
    documentId,
    forceSaveSnapshot,
    persistOperation,
    workspaceId,
  ]);

  const switchProject = useCallback((nextProjectId: string) => {
    if (!workspaceId || nextProjectId === activeProjectId) return;
    void persistOperation(async () => {
      await forceSaveSnapshot();
      const loaded = await loadWorkspaceProject(workspaceId, nextProjectId);
      applyLoadedWorkspace(loaded);
      return loaded;
    }, copy.persistence.restored).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [
    activeProjectId,
    applyLoadedWorkspace,
    copy.persistence.failed,
    copy.persistence.restored,
    forceSaveSnapshot,
    persistOperation,
    workspaceId,
  ]);

  const openDocumentFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, nextDocumentId: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    switchDocument(nextDocumentId);
  }, [switchDocument]);

  const openProjectFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, nextProjectId: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    switchProject(nextProjectId);
  }, [switchProject]);

  const archiveDocumentToCurrentProject = useCallback((item: DocumentSidebarItem) => {
    if (!workspaceId || !currentProjectId || !activeProject) {
      setJobStatus(copy.rail.archiveUnavailable);
      return;
    }
    if (item.projectId === currentProjectId) {
      setJobStatus(copy.rail.alreadyArchivedToCourse(item.title, activeProject.name));
      return;
    }
    void persistOperation(async () => {
      await saveDocumentPatch(item.documentId, { projectId: currentProjectId });
      await refreshDocumentItems(workspaceId, documentId, currentProjectId);
      return item;
    }, copy.rail.archivedToCourse(item.title, activeProject.name)).catch((error) => {
      setJobStatus((error as Error).message || copy.persistence.failed);
    });
  }, [
    activeProject,
    copy.persistence.failed,
    copy.rail,
    currentProjectId,
    documentId,
    persistOperation,
    refreshDocumentItems,
    workspaceId,
  ]);

  const deleteDocumentFromRail = useCallback((item: DocumentSidebarItem) => {
    if (!workspaceId) return;
    if (!window.confirm(copy.rail.confirmDeleteDocument(item.title))) return;
    void persistOperation(async () => {
      await forceSaveSnapshot();
      const loaded = await deleteWorkspaceDocument(workspaceId, item.documentId);
      if (loaded) applyLoadedWorkspace(loaded);
      return loaded;
    }, copy.rail.documentDeleted(item.title)).catch((error) => {
      setJobStatus((error as Error).message || copy.persistence.failed);
    });
  }, [
    applyLoadedWorkspace,
    copy.persistence.failed,
    copy.rail,
    forceSaveSnapshot,
    persistOperation,
    workspaceId,
  ]);

  const deleteProjectFromRail = useCallback((project: CourseProjectRecord) => {
    if (!workspaceId) return;
    if (!window.confirm(copy.rail.confirmDeleteCourse(project.name, project.documentCount))) return;
    void persistOperation(async () => {
      await forceSaveSnapshot();
      const loaded = await deleteCourseProject(workspaceId, project.id);
      if (loaded) applyLoadedWorkspace(loaded);
      return loaded;
    }, copy.rail.courseDeleted(project.name)).catch((error) => {
      setJobStatus((error as Error).message || copy.persistence.failed);
    });
  }, [
    applyLoadedWorkspace,
    copy.persistence.failed,
    copy.rail,
    forceSaveSnapshot,
    persistOperation,
    workspaceId,
  ]);

  const createProjectFromDialog = useCallback(() => {
    const name = courseDraftName.trim();
    if (!workspaceId || !name) {
      setCourseDialogOpen(false);
      setCourseDraftName("");
      return;
    }
    void persistOperation(async () => {
      await forceSaveSnapshot();
      const project = await createCourseProject({ workspaceId, name });
      const loaded = await loadWorkspaceProject(workspaceId, project.id);
      applyLoadedWorkspace(loaded);
      setCourseDialogOpen(false);
      setCourseDraftName("");
      return project;
    }, copy.persistence.saved).catch((error) => setJobStatus((error as Error).message || copy.persistence.failed));
  }, [
    applyLoadedWorkspace,
    copy.persistence.failed,
    copy.persistence.saved,
    courseDraftName,
    forceSaveSnapshot,
    persistOperation,
    workspaceId,
  ]);

  const handleActivePdfPageChange = useCallback((pageNumber: number) => {
    setCurrentPageNo((current) => {
      const nextPage = Math.min(Math.max(pageNumber, 1), pdfNavigationPageCount);
      return current === nextPage ? current : nextPage;
    });
  }, [pdfNavigationPageCount]);

  const movePage = (delta: number) => {
    const targetPage = Math.min(Math.max(currentPdfPageNo + delta, 1), pdfNavigationPageCount);
    if (pdfUrl && pdfScrollViewerRef.current && pdfViewMode === "continuous") {
      pdfScrollViewerRef.current.scrollToPage(targetPage, "smooth");
      return;
    }
    setCurrentPageNo(targetPage);
  };

  const handleGenerateNotes = useCallback(() => {
    if (isGeneratingNotes) return;
    const pageOutputLanguage = teachingOutputLanguage;
    const pageOutputLanguageLabel = teachingOutputLanguageName(pageOutputLanguage);
    const totalPages = Math.max(pdfPageCount || pack.document.page_count || pack.pages.length || pdfExtractedPages.length, 1);
    if (pdfUrl && pdfExtractedPages.length < totalPages) {
      setJobStatus(copy.status.pdfTextExtracting(pdfExtractedPages.length, totalPages));
      return;
    }
    const sourceTextByPage = new Map<number, string>();
    for (const page of pdfExtractedPages) {
      sourceTextByPage.set(page.page_no, page.text_md);
    }
    for (const page of pack.pages) {
      if (!sourceTextByPage.has(page.page_no) && page.source.text_md) {
        sourceTextByPage.set(page.page_no, page.source.text_md);
      }
    }
    const draftPack = createDraftPagePack(pack.document.title, pack.document.source_pdf_url, totalPages, pack.document.id);
    const packPagesByNumber = new Map(pack.pages.map((item) => [item.page_no, item]));

    let workingPack: PagePack = {
      ...pack,
      document: {
        ...pack.document,
        page_count: totalPages,
      },
      pages: Array.from({ length: totalPages }, (_, index) => {
        const pageNo = index + 1;
        const existing = packPagesByNumber.get(pageNo) || draftPack.pages[index];
        return pageWithSourceText(existing, sourceTextByPage.get(pageNo) || "");
      }),
    };
    const workingPagesByNumber = new Map(workingPack.pages.map((item) => [item.page_no, item]));
    const targetPageNumbers = generateTargetPageNumbers(generatePageMode, generateRangeDraft, currentPdfPageNo, totalPages);
    if (!targetPageNumbers?.length) {
      setJobStatus(copy.status.generationInvalidPageRange(totalPages));
      return;
    }
    const targetPageSet = new Set(targetPageNumbers);
    const scopedPages = workingPack.pages.filter((item) => targetPageSet.has(item.page_no));
    const pagesToGenerate = scopedPages.filter((item) => !hasCompletedTeaching(item, pageOutputLanguage));
    const skippedPages = scopedPages.length - pagesToGenerate.length;
    if (!pagesToGenerate.length) {
      setPack(workingPack);
      setJobStatus(copy.status.generationScopeAlreadyComplete(formatPageRanges(targetPageNumbers)));
      return;
    }

    setIsGeneratingNotes(true);
    setPanels((current) => ({ ...current, notes: true }));
    setActiveTab("notes");
    setJobStatus(copy.status.generationPreparingCache(pagesToGenerate.length));
    setPack(workingPack);

    void (async () => {
      let completed = 0;
      try {
        const documentContext = fullPdfContextForTeachingGeneration(workingPack, totalPages, pdfExtractedPages);
        const documentFile = pdfUrl
          ? await pdfDirectFileInputFromUrl(pdfUrl, workingPack.document.source_pdf_url || workingPack.document.title).catch(() => null)
          : null;
        setJobStatus(copy.status.generationStarted(pagesToGenerate.length));
        for (let index = 0; index < pagesToGenerate.length; index += 1) {
          const pageNo = pagesToGenerate[index].page_no;
          const basePage = workingPagesByNumber.get(pageNo) || draftPack.pages[pageNo - 1];
          const runningPage: PageData = {
            ...basePage,
            status: "running",
            teaching: {
              ...basePage.teaching,
              output_language: pageOutputLanguage,
              speaker_notes_md:
                basePage.status === "failed" || basePage.teaching.output_language !== pageOutputLanguage
                  ? ""
                  : basePage.teaching.speaker_notes_md,
            },
          };
          workingPack = mergePageIntoPack(workingPack, runningPage);
          workingPagesByNumber.set(pageNo, runningPage);
          setPack(workingPack);
          setCurrentPageNo((current) => current || pageNo);
          setJobStatus(copy.status.generationPage(index + 1, pagesToGenerate.length, pageNo));

          try {
            const previousPage = workingPagesByNumber.get(pageNo - 1);
            const nextPage = workingPagesByNumber.get(pageNo + 1);
            const response = await requestJson<GeneratedTeachingPageResponse>(
              "/api/generate/page",
              {
                method: "POST",
                body: JSON.stringify({
                  model: "gpt-5.5",
                  reasoningEffort: uiPreferences.modelReasoningEffort,
                  document: workingPack.document,
                  documentContext,
                  documentFile,
                  outputLanguage: pageOutputLanguage,
                  outputLanguageLabel: pageOutputLanguageLabel,
                  uiLanguage: uiPreferences.language,
                  page: runningPage,
                  pageCount: totalPages,
                  previousPage: previousPage
                    ? { page_no: previousPage.page_no, title: previousPage.teaching.slide_title }
                    : null,
                  nextPage: nextPage
                    ? { page_no: nextPage.page_no, title: nextPage.teaching.slide_title }
                    : null,
                }),
              },
              copy.errors.accountNotFound,
            );
            const normalizedGeneratedPage = normalizeGeneratedPage(response.page, runningPage, copy);
            const generatedPage: PageData = {
              ...normalizedGeneratedPage,
              teaching: {
                ...normalizedGeneratedPage.teaching,
                output_language: pageOutputLanguage,
              },
            };
            workingPack = mergePageIntoPack(workingPack, generatedPage);
            workingPagesByNumber.set(pageNo, generatedPage);
            setPack(workingPack);
            completed += 1;
            if (workspaceId && documentId && workingPack.document.id === documentId) {
              await saveGeneratedPage({
                id: `${documentId}:page:${generatedPage.page_no}`,
                workspaceId,
                documentId,
                generatedPageIndex: generatedPage.page_no - 1,
                sourcePdfPageNumber: generatedPage.page_no,
                title: generatedPage.teaching.slide_title,
                markdown: generatedPage.teaching.speaker_notes_md,
                json: asPersistedRecord(generatedPage),
                confidence: generatedPage.teaching.confidence,
                status: generatedPage.status === "failed" ? "failed" : "completed",
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          } catch (error) {
            const message = (error as Error).message || copy.agent.generationFailed;
            const failedPage: PageData = {
              ...runningPage,
              status: "failed",
              teaching: {
                ...runningPage.teaching,
                output_language: pageOutputLanguage,
                slide_title: runningPage.teaching.slide_title || `PDF p.${pageNo}`,
                speaker_notes_md: generationFailureMarkdown(message, pageOutputLanguage),
                confidence: 0,
                needs_review: true,
              },
            };
            workingPack = mergePageIntoPack(workingPack, failedPage);
            workingPagesByNumber.set(pageNo, failedPage);
            setPack(workingPack);
            setJobStatus(copy.status.generationPageFailed(pageNo, message));
            if (workspaceId && documentId && workingPack.document.id === documentId) {
              await saveGeneratedPage({
                id: `${documentId}:page:${pageNo}`,
                workspaceId,
                documentId,
                generatedPageIndex: pageNo - 1,
                sourcePdfPageNumber: pageNo,
                title: failedPage.teaching.slide_title,
                markdown: failedPage.teaching.speaker_notes_md,
                json: asPersistedRecord(failedPage),
                confidence: 0,
                status: "failed",
                errorSummary: message,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          }
        }
        if (workspaceId && documentId && workingPack.document.id === documentId) {
          await saveGeneratedPagesFromPack({ workspaceId, documentId, pack: workingPack });
          await refreshDocumentItems(workspaceId, documentId, activeProjectId);
        }
        setJobStatus(copy.status.generationDone(completed, scopedPages.length, skippedPages));
      } finally {
        setIsGeneratingNotes(false);
      }
    })();
  }, [
    activeProjectId,
    copy,
    currentPdfPageNo,
    documentId,
    generatePageMode,
    generateRangeDraft,
    isGeneratingNotes,
    pack,
    pdfExtractedPages,
    pdfPageCount,
    pdfUrl,
    refreshDocumentItems,
    teachingOutputLanguage,
    uiPreferences.language,
    uiPreferences.modelReasoningEffort,
    workspaceId,
  ]);

  const authText =
    oauthMode === "connected"
      ? copy.auth.gatewayConnected(oauthAccount)
      : oauthMode === "polling"
        ? copy.auth.gatewayWaiting
        : oauthMode === "offline"
          ? copy.auth.gatewayOffline
          : copy.auth.gatewayDisconnected;
  const connectionText =
    oauthMode === "connected"
      ? copy.auth.connectionConnected
      : oauthMode === "polling"
        ? copy.auth.connectionWaiting
        : oauthMode === "offline" || oauthMode === "mock"
          ? copy.auth.connectionLocal
          : copy.auth.connectionReady;

  return (
    <AppCopyContext.Provider value={copy}>
      <div
        ref={appShellRef}
        className={`app-shell ${pdfOnly ? "pdf-focus" : ""} ${uiPreferences.compactMode ? "compact-mode" : ""}`}
        data-accent={uiPreferences.accentColor}
        data-font-scale={uiPreferences.fontScale}
        data-pdf-background={uiPreferences.pdfBackground}
        data-scrollbar-style={uiPreferences.scrollbarStyle}
        data-theme-mode={uiPreferences.theme}
        data-debug-mode={uiPreferences.debugMode}
        data-fullscreen-mode={isBrowserFullscreen}
        lang={uiPreferences.language === "en-US" ? "en" : "zh-CN"}
      >
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PP</div>
          <div>
            <h1>PagePair Reader</h1>
            <p>{pack.document.title}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className={`save-status-pill ${isRestoringWorkspace ? "saving" : saveState.kind}`}
            type="button"
            aria-label={copy.persistence.saveStatusLabel}
            title={saveState.kind === "error" || saveState.kind === "quota" ? copy.persistence.retrySave : copy.persistence.saveStatusLabel}
            onClick={handleSaveStatusClick}
          >
            {isRestoringWorkspace || saveState.kind === "saving" ? <Clock /> : saveState.kind === "saved" ? <Check /> : <span aria-hidden="true" />}
            <span>{isRestoringWorkspace ? copy.persistence.saving : saveState.message || copy.persistence.localDraft}</span>
          </button>
          <div className="layout-switcher" role="group" aria-label={copy.topbar.layoutSwitcherAria}>
            <IconButton label={copy.topbar.restoreWorkbench} active={fullWorkbench} onClick={() => setPanels(fullPanelVisibility)}>
              <Columns3 />
            </IconButton>
            <IconButton label={panels.rail ? copy.topbar.hideRail : copy.topbar.showRail} active={panels.rail} onClick={() => togglePanel("rail")}>
              {panels.rail ? <PanelLeftClose /> : <PanelLeftOpen />}
            </IconButton>
            <IconButton label={panels.notes ? copy.topbar.hideNotes : copy.topbar.showNotes} active={panels.notes} onClick={() => togglePanel("notes")}>
              <NotebookText />
            </IconButton>
            <IconButton label={panels.agent ? copy.topbar.hideAgent : copy.topbar.showAgent} active={panels.agent} onClick={() => togglePanel("agent")}>
              {panels.agent ? <PanelRightClose /> : <PanelRightOpen />}
            </IconButton>
            <IconButton label={pdfOnly ? copy.topbar.exitPdfFocus : copy.topbar.pdfOnly} active={pdfOnly || isBrowserFullscreen} onClick={togglePdfOnly}>
              {isBrowserFullscreen ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          </div>
          <FileButton label={copy.topbar.uploadPdf} accept="application/pdf" onFile={loadPdf}>
            <Upload />
          </FileButton>
          <div className="command-menu" ref={commandMenuRef}>
            <button
              className={`mini-button ${commandMenuOpen ? "active" : ""}`}
              type="button"
              aria-label={copy.topbar.moreActions}
              aria-expanded={commandMenuOpen}
              title={copy.topbar.moreActions}
              onClick={() => {
                setGenerateMenuOpen(false);
                setCommandMenuOpen((open) => !open);
              }}
            >
              <MoreHorizontal />
            </button>
            {commandMenuOpen ? (
              <div className="command-menu-popover">
                <button type="button" onClick={() => {
                  closeCommandMenu();
                  void connectOAuth();
                }}>
                  <Lock />
                  {oauthMode === "polling" ? copy.topbar.viewOpenAiCode : copy.topbar.connectOpenAi}
                </button>
                <button type="button" onClick={() => {
                  jsonImportInputRef.current?.click();
                  closeCommandMenu();
                }}>
                  <FileInput />
                  {copy.topbar.importJson}
                </button>
                <button type="button" onClick={() => {
                  closeCommandMenu();
                  exportJson();
                }}>
                  <FileJson />
                  {copy.topbar.exportJson}
                </button>
                <button type="button" onClick={() => {
                  closeCommandMenu();
                  openSettings("advanced");
                }}>
                  <Settings2 />
                  {copy.topbar.advancedSettings}
                </button>
              </div>
            ) : null}
            <input
              ref={jsonImportInputRef}
              className="command-menu-file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) loadJson(file);
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={workspaceImportInputRef}
              className="command-menu-file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importWorkspaceBackup(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
          <div className="generate-split" ref={generateMenuRef}>
            <button
              className="primary-button generate-main-button"
              type="button"
              onClick={() => {
                setGenerateMenuOpen(false);
                handleGenerateNotes();
              }}
              disabled={isGeneratingNotes}
              title={generateScopeSummary}
            >
              <Zap />
              {copy.topbar.generate}
            </button>
            <button
              className={`primary-button generate-menu-button ${generateMenuOpen ? "active" : ""}`}
              type="button"
              aria-label={copy.topbar.generateScopeLabel}
              aria-expanded={generateMenuOpen}
              title={generateScopeSummary}
              disabled={isGeneratingNotes}
              onClick={() => {
                setCommandMenuOpen(false);
                setGenerateMenuOpen((open) => !open);
              }}
            >
              <ChevronDown />
            </button>
            {generateMenuOpen ? (
              <div className="generate-menu-popover">
                <div className="generate-menu-heading">
                  <span>{copy.topbar.generateScopeLabel}</span>
                  <small>{generateScopeSummary}</small>
                </div>
                {([
                  ["missing", copy.topbar.generateScopeMissing, copy.topbar.generateScopeMissingDescription],
                  ["current", copy.topbar.generateScopeCurrent(currentPdfPageNo), copy.topbar.generateScopeCurrentDescription],
                  ["all", copy.topbar.generateScopeAll, copy.topbar.generateScopeAllDescription],
                ] as const).map(([mode, label, description]) => (
                  <button
                    key={mode}
                    className={`generate-scope-option ${generatePageMode === mode ? "active" : ""}`}
                    type="button"
                    onClick={() => {
                      setGeneratePageMode(mode);
                      setGenerateMenuOpen(false);
                    }}
                  >
                    <Check />
                    <span>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                  </button>
                ))}
                <label className={`generate-range-field ${generatePageMode === "custom" ? "active" : ""}`}>
                  <span>
                    <strong>{copy.topbar.generateScopeCustom}</strong>
                    <small>{copy.topbar.generateScopeCustomDescription}</small>
                  </span>
                  <input
                    value={generateRangeDraft}
                    placeholder={copy.topbar.generateScopeCustomPlaceholder}
                    onFocus={() => setGeneratePageMode("custom")}
                    onChange={(event) => {
                      setGeneratePageMode("custom");
                      setGenerateRangeDraft(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setGenerateMenuOpen(false);
                    }}
                  />
                </label>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {oauthDevice && (
        <OAuthDeviceDialog
          device={oauthDevice}
          secondsLeft={oauthSecondsLeft}
          copied={oauthCodeCopied}
          onCopy={copyOAuthUserCode}
          onOpen={openOAuthVerification}
          onCancel={cancelOAuthLogin}
        />
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            activeSection={settingsSection}
            onSectionChange={setSettingsSection}
            preferences={uiPreferences}
            onPreferenceChange={updatePreference}
            onResetLayout={() => {
              setPanels(fullPanelVisibility);
              setJobStatus(copy.status.layoutReset);
            }}
            onResetPreferences={resetPreferences}
            onConnectOAuth={connectOAuth}
            oauthMode={oauthMode}
            oauthAccount={oauthAccount}
            providerStatus={authText}
            jobStatus={jobStatus}
            documentTitle={pack.document.title}
            saveState={saveState}
            storageEstimate={storageEstimate}
            persistentStorageState={persistentStorageState}
            hasWorkspace={Boolean(workspaceId)}
            onRequestPersistentStorage={enablePersistentStorage}
            onExportWorkspace={exportCurrentWorkspace}
            onImportWorkspace={() => workspaceImportInputRef.current?.click()}
            onClearWorkspace={clearCurrentWorkspace}
            onRepairStorage={repairLocalStorage}
            onResetWorkspace={resetCurrentWorkspace}
          />
        </Suspense>
      )}

      <SelectionToolbar
        state={selectionToolbar}
        onAdd={(context) => captureSelection(context)}
        onExplain={(context) => sendSelectionPrompt(context, "explain")}
        onSummarize={(context) => sendSelectionPrompt(context, "summarize")}
      />

      {courseDialogOpen && (
        <div className="course-dialog-overlay" role="presentation" onMouseDown={() => setCourseDialogOpen(false)}>
          <div className="course-dialog" role="dialog" aria-modal="true" aria-label={copy.rail.courseDialogTitle} onMouseDown={(event) => event.stopPropagation()}>
            <h2>{copy.rail.courseDialogTitle}</h2>
            <input
              autoFocus
              value={courseDraftName}
              onChange={(event) => setCourseDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createProjectFromDialog();
                if (event.key === "Escape") setCourseDialogOpen(false);
              }}
              placeholder={copy.rail.courseNamePlaceholder}
            />
            <div className="course-dialog-actions">
              <button type="button" onClick={() => setCourseDialogOpen(false)}>{copy.rail.cancel}</button>
              <button type="button" disabled={!courseDraftName.trim()} onClick={createProjectFromDialog}>{copy.rail.createCourse}</button>
            </div>
          </div>
        </div>
      )}

      <main className="workspace" data-pane-count={visiblePaneCount}>
        <PanelGroup orientation="horizontal" className="workspace-panels">
          <Panel className="workspace-panel" hidden={!panels.rail} defaultSize={18} minSize={12}>
            <aside className="page-rail document-rail">
              <div className="rail-top">
                <div className="rail-header">
                  <div>
                    <strong>PagePair</strong>
                    <span>{activeProject?.name || copy.rail.defaultCourse}</span>
                  </div>
                  <div className="rail-header-actions">
                    <button
                      className="rail-icon-button"
                      type="button"
                      disabled={!workspaceId}
                      onClick={() => setCourseDialogOpen(true)}
                      title={copy.rail.newCourse}
                      aria-label={copy.rail.newCourse}
                    >
                      <Plus />
                    </button>
                    <FileButton label={copy.rail.uploadDocument} accept="application/pdf" onFile={loadPdf}>
                      <Upload />
                    </FileButton>
                  </div>
                </div>
                <div className="search-box">
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.rail.searchPlaceholder} />
                </div>
              </div>
              <div className="rail-nav">
                <section className="rail-section">
                  <div className="rail-section-label">
                    <span>{copy.rail.courses}</span>
                    <small>{sidebarProjects.length}</small>
                  </div>
                  {filteredProjects.map((project) => (
                    <div
                      className={`course-item ${project.id === currentProjectId ? "active" : ""}`}
                      key={project.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => switchProject(project.id)}
                      onKeyDown={(event) => openProjectFromKeyboard(event, project.id)}
                    >
                      <BookOpen />
                      <span>{project.name}</span>
                      <small>{copy.rail.courseDocumentCount(project.documentCount)}</small>
                      {workspaceId && (
                        <span className="rail-row-actions">
                          <button
                            className="rail-row-action rail-delete-button"
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              deleteProjectFromRail(project);
                            }}
                            title={copy.rail.deleteCourse(project.name)}
                            aria-label={copy.rail.deleteCourse(project.name)}
                          >
                            <Trash2 />
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                </section>

                <section className="rail-section">
                  <div className="rail-section-label">
                    <span>{copy.rail.documents}</span>
                    <small>{copy.rail.documentCount(documentsForSidebar.length)}</small>
                  </div>
                  <div className="document-list">
                    {documentsForSidebar.map((item) => (
                      <div
                        className={`document-item ${item.isActive ? "active" : ""}`}
                        key={item.documentId}
                        role="button"
                        tabIndex={0}
                        onClick={() => switchDocument(item.documentId)}
                        onKeyDown={(event) => openDocumentFromKeyboard(event, item.documentId)}
                      >
                        <span className="document-dot" />
                        <span className="document-copy">
                          <strong>{item.title}</strong>
                          <span>{copy.rail.documentMeta(Math.max(item.pageCount || 1, 1), item.generatedPageCount)}</span>
                        </span>
                        <span className={`document-state ${item.status === "missing-file" ? "missing" : ""}`} />
                        {workspaceId && (
                          <span className="rail-row-actions">
                            {item.projectId !== currentProjectId && (
                              <button
                                className="rail-row-action document-archive-button"
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  archiveDocumentToCurrentProject(item);
                                }}
                                title={copy.rail.archiveToCourse(activeProject?.name || copy.rail.defaultCourse)}
                                aria-label={copy.rail.archiveToCourse(activeProject?.name || copy.rail.defaultCourse)}
                              >
                                <Archive />
                              </button>
                            )}
                            <button
                              className="rail-row-action rail-delete-button"
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                deleteDocumentFromRail(item);
                              }}
                              title={copy.rail.deleteDocument(item.title)}
                              aria-label={copy.rail.deleteDocument(item.title)}
                            >
                              <Trash2 />
                            </button>
                          </span>
                        )}
                      </div>
                    ))}
                    {!documentsForSidebar.length && (
                      <div className="rail-empty">{normalizedDocumentQuery ? copy.rail.emptyDocuments : copy.rail.emptyCourseDocuments}</div>
                    )}
                  </div>
                </section>

                {!!recentDocuments.length && (
                  <section className="rail-section">
                    <div className="rail-section-label">
                      <span>{copy.rail.recents}</span>
                    </div>
                    {recentDocuments.map((item) => (
                      <div
                        className="recent-item"
                        key={item.documentId}
                        role="button"
                        tabIndex={0}
                        onClick={() => switchDocument(item.documentId)}
                        onKeyDown={(event) => openDocumentFromKeyboard(event, item.documentId)}
                      >
                        <span>{item.title}</span>
                        {workspaceId && (
                          <span className="rail-row-actions">
                            {item.projectId !== currentProjectId && (
                              <button
                                className="rail-row-action document-archive-button"
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  archiveDocumentToCurrentProject(item);
                                }}
                                title={copy.rail.archiveToCourse(activeProject?.name || copy.rail.defaultCourse)}
                                aria-label={copy.rail.archiveToCourse(activeProject?.name || copy.rail.defaultCourse)}
                              >
                                <Archive />
                              </button>
                            )}
                            <button
                              className="rail-row-action rail-delete-button"
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                deleteDocumentFromRail(item);
                              }}
                              title={copy.rail.deleteDocument(item.title)}
                              aria-label={copy.rail.deleteDocument(item.title)}
                            >
                              <Trash2 />
                            </button>
                          </span>
                        )}
                      </div>
                    ))}
                  </section>
                )}
              </div>
              <div className="rail-footer">
                <button className="rail-settings-button" type="button" onClick={() => openSettings("general")}>
                  <Settings />
                  <span>{copy.rail.settings}</span>
                  <small>{saveState.kind === "saved" ? copy.persistence.saved : saveState.message || copy.persistence.localDraft}</small>
                </button>
              </div>
            </aside>
          </Panel>

          {panels.rail && <WorkspaceResizeHandle />}

          <Panel className="workspace-panel" defaultSize={pdfOnly ? 100 : 30} minSize={24}>
            <section className="pdf-pane">
              <PaneToolbar
                title={pdfUrl ? copy.common.sourcePdfPage(currentPdfPageNo) : copy.pdf.samplePdfPage}
                right={
                  <div className="toolbar-actions">
                    <IconButton label={copy.pdf.previousPage} onClick={() => movePage(-1)} disabled={currentPdfPageNo <= 1}>
                      <ChevronLeft />
                    </IconButton>
                    <output>{currentPdfPageNo} / {pdfNavigationPageCount}</output>
                    <IconButton label={copy.pdf.nextPage} onClick={() => movePage(1)} disabled={currentPdfPageNo >= pdfNavigationPageCount}>
                      <ChevronRight />
                    </IconButton>
                    {isBrowserFullscreen && (
                      <IconButton label={copy.topbar.exitPdfFocus} onClick={togglePdfOnly}>
                        <Minimize2 />
                      </IconButton>
                    )}
                  </div>
                }
              />
              <div className={`pdf-frame ${pdfUrl ? "has-pdf" : ""}`}>
                {pdfUrl ? (
                  <PdfScrollViewer
                    ref={pdfScrollViewerRef}
                    documentId={pack.document.id}
                    documentTitle={pack.document.title}
                    fallbackSrc={pdfViewerSrc}
                    pageNumber={currentPdfPageNo}
                    url={pdfUrl}
                    viewMode={pdfViewMode}
                    pdfContextFullPageLimit={uiPreferences.pdfContextFullPageLimit}
                    pdfContextEdgePageCount={uiPreferences.pdfContextEdgePageCount}
                    onDocumentReady={handlePdfDocumentReady}
                    onActivePageChange={handleActivePdfPageChange}
                    onPdfContextReady={handlePdfContextReady}
                    onPdfPagesTextReady={handlePdfPagesTextReady}
                    onViewerScroll={clearSelection}
                  />
                ) : (
                  <SlidePreview page={page} />
                )}
              </div>
            </section>
          </Panel>

          {(panels.notes || panels.agent) && <WorkspaceResizeHandle />}

          <Panel className="workspace-panel" hidden={!panels.notes} defaultSize={27} minSize={22}>
            <section className="notes-pane">
              <PaneToolbar
                title={copy.notes.title}
                right={
                  <div className="notes-toolbar-right">
                    <div className="generation-details-control">
                      <button
                        className="source-pill generation-progress-trigger"
                        type="button"
                        aria-expanded={generationDetailsOpen}
                        aria-label={copy.topbar.generationDetailsLabel}
                        title={copy.topbar.generationDetailsLabel}
                        onClick={() => setGenerationDetailsOpen((open) => !open)}
                      >
                        <span className="generation-progress-mini" aria-hidden="true">
                          <span style={{ width: `${Math.round((currentPdfPageNo / pdfNavigationPageCount) * 100)}%` }} />
                        </span>
                        <span className="generation-progress-text">{copy.common.explanationProgress(currentPdfPageNo, pdfNavigationPageCount)}</span>
                      </button>
                      {generationDetailsOpen && (
                        <GenerationDetailsPopover
                          copy={copy}
                          currentPageNo={currentPdfPageNo}
                          pages={generationProgressPages}
                          summary={generationProgressSummary}
                        />
                      )}
                    </div>
                    <div className="tab-group">
                      {(["notes", "structure", "json"] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          className={`tab-button ${activeTab === tab ? "active" : ""}`}
                          onClick={() => setActiveTab(tab)}
                        >
                          <span className="tab-label-full">
                            {tab === "notes" ? copy.notes.tabNotes : tab === "structure" ? copy.notes.tabStructure : copy.notes.tabJson}
                          </span>
                          <span className="tab-label-short" aria-hidden="true">
                            {tab === "notes" ? copy.notes.tabNotesShort : tab === "structure" ? copy.notes.tabStructureShort : copy.notes.tabJsonShort}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                }
              />
              <div className="notes-content">
                {activeTab === "notes" && <MarkdownBlock markdown={page.teaching.speaker_notes_md} concepts={page.teaching.concepts} />}
                {activeTab === "structure" && <StructurePanel page={page} />}
                {activeTab === "json" && <pre className="json-panel">{JSON.stringify(page, null, 2)}</pre>}
              </div>
            </section>
          </Panel>

          {panels.notes && panels.agent && <WorkspaceResizeHandle />}

          <Panel className="workspace-panel" hidden={!panels.agent} defaultSize={25} minSize={22}>
            {panels.agent && (
              <AgentPanel
                key={agentRuntimeKey}
                contexts={contexts}
                attachments={attachments}
                selectedContext={selectedContext}
                initialMessages={persistedMessages}
                pendingSelectionPrompt={pendingSelectionPrompt}
                setContexts={setContexts}
                setAttachments={setAttachments}
                setSelectedContext={setSelectedContext}
                clearPendingSelectionPrompt={(id) => {
                  setPendingSelectionPrompt((current) => (current?.id === id ? null : current));
                }}
                composerInputRef={composerInputRef}
                getSnapshot={getSnapshot}
                getDocumentFile={getDocumentFile}
                getPack={getPack}
                getPage={getPage}
                backendOffline={oauthMode === "offline" || oauthMode === "mock"}
                oauthMode={oauthMode}
                showSourcePills={uiPreferences.showSourcePills}
                pageAwareSuggestions={uiPreferences.pageAwareSuggestions}
                persistChatMessage={persistChatMessage}
                onNewConversation={startNewPersistedConversation}
              />
            )}
          </Panel>
        </PanelGroup>
      </main>

      {uiPreferences.debugMode && (
        <footer className="statusbar">
          <button
            className={`connection-indicator ${oauthMode}`}
            type="button"
            title={connectionText}
            aria-label={connectionText}
            onClick={() => openSettings("account")}
          >
            <span aria-hidden="true" />
          </button>
          <span>{jobStatus}</span>
        </footer>
      )}
      </div>
    </AppCopyContext.Provider>
  );
}

function WorkspaceResizeHandle() {
  const copy = useAppCopy();
  return (
    <PanelResizeHandle className="workspace-resize-handle" aria-label={copy.topbar.resizeHandle}>
      <span />
    </PanelResizeHandle>
  );
}

type AgentPanelProps = {
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  initialMessages: ThreadMessageLike[];
  pendingSelectionPrompt: QuickSelectionPrompt | null;
  setContexts: (fn: AgentContextItem[] | ((items: AgentContextItem[]) => AgentContextItem[])) => void;
  setAttachments: (fn: AgentAttachment[] | ((items: AgentAttachment[]) => AgentAttachment[])) => void;
  setSelectedContext: (context: SelectedContext | null) => void;
  clearPendingSelectionPrompt: (id: string) => void;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  getSnapshot: () => AgentSnapshot;
  getDocumentFile: () => Promise<PdfDirectFileInput | null>;
  getPack: () => PagePack;
  getPage: () => PageData;
  backendOffline: boolean;
  oauthMode: OAuthMode;
  showSourcePills: boolean;
  pageAwareSuggestions: boolean;
  persistChatMessage?: (input: ChatPersistInput) => Promise<void>;
  onNewConversation: () => void;
};

function AgentPanel(props: AgentPanelProps) {
  const copy = useAppCopy();
  const { assistantUi, requestAssistantUi } = useDeferredAssistantRuntime(Boolean(props.pendingSelectionPrompt));
  if (!assistantUi) {
    return (
      <aside
        className="agent-panel"
        onPointerEnter={requestAssistantUi}
        onFocusCapture={requestAssistantUi}
      >
        <div className="agent-toolbar">
          <div className="toolbar-title">
            <span className="agent-dot" />
            <span>{copy.common.assistant}</span>
          </div>
          <div className="toolbar-actions">
            <span className="agent-model">{copy.agent.thinking}</span>
          </div>
        </div>
      </aside>
    );
  }
  return (
    <AssistantUiContext.Provider value={assistantUi}>
      <AgentPanelLoaded {...props} />
    </AssistantUiContext.Provider>
  );
}

function AgentPanelLoaded(props: AgentPanelProps) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const adapter = useMemo(
    () =>
      createPdfAgentAdapter({
        getSnapshot: props.getSnapshot,
        getDocumentFile: props.getDocumentFile,
        getPack: props.getPack,
        getPage: props.getPage,
        copy,
        isBackendOffline: () => props.backendOffline,
        clearSelectedContext: () => props.setSelectedContext(null),
        persistChatMessage: props.persistChatMessage,
      }),
    [copy, props.backendOffline, props.getDocumentFile, props.getPage, props.getPack, props.getSnapshot, props.persistChatMessage, props.setSelectedContext],
  );
  const runtime = assistantUi.useLocalRuntime(adapter, { initialMessages: props.initialMessages });
  const { AssistantRuntimeProvider } = assistantUi;
  const page = props.getPage();
  const suggestions = pageSuggestions(page, props.pageAwareSuggestions, copy);
  const contextPreview = composerContextPreview(props.contexts, props.attachments, copy);

  const clearAgentContext = useCallback(() => {
    props.setContexts([]);
    props.setAttachments([]);
    props.setSelectedContext(null);
  }, [props]);

  const startNewConversation = useCallback(() => {
    runtime.thread.reset();
    void runtime.thread.composer.reset();
    clearAgentContext();
    if (props.pendingSelectionPrompt) {
      props.clearPendingSelectionPrompt(props.pendingSelectionPrompt.id);
    }
    props.onNewConversation();
  }, [clearAgentContext, props, runtime]);

  const addImages = async (files: FileList | File[]) => {
    const images = await Promise.all([...files].filter((file) => file.type.startsWith("image/")).slice(0, 6).map((file) => readFileAsDataUrl(file, copy)));
    props.setAttachments((items) => [...items, ...images].slice(-8));
  };

  const addClipboardImages = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }, [addImages]);

  return (
    <aside className="agent-panel">
      <div className="agent-toolbar">
        <div className="toolbar-title">
          <span className="agent-dot" />
          <span>{copy.common.assistant}</span>
        </div>
        <div className="toolbar-actions">
          <span className="agent-model">{props.oauthMode === "connected" ? "OAuth" : props.backendOffline ? "Local" : "OAuth"}</span>
          <button className="agent-action-button" type="button" onClick={startNewConversation}>
            <NotebookText />
            <span>{copy.agent.newConversation}</span>
          </button>
          <button className="agent-action-button" type="button" onClick={clearAgentContext}>
            <Trash2 />
            <span>{copy.agent.clearContext}</span>
          </button>
          <label className="agent-action-button" title={copy.agent.addImage} aria-label={copy.agent.addImage}>
            <Image />
            <span>{copy.agent.addImage}</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                if (event.target.files) void addImages(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>
      <div className="agent-context-strip" hidden={!props.showSourcePills || (!props.contexts.length && !props.attachments.length)}>
        {props.contexts.map((context) => (
          <span className="context-pill" key={context.id} title={context.text}>
            <span>{contextSourceLabel(context, copy)}</span>
            <button type="button" onClick={() => props.setContexts((items) => items.filter((item) => item.id !== context.id))} aria-label={copy.agent.removeContext}>
              <X />
            </button>
          </span>
        ))}
        {props.attachments.map((attachment) => (
          <figure className="context-pill image-pill" key={attachment.id} title={attachment.name}>
            <img src={attachment.data_url} alt={attachment.name} />
            <figcaption>{compactText(attachment.name, 22)}</figcaption>
            <button type="button" onClick={() => props.setAttachments((items) => items.filter((item) => item.id !== attachment.id))} aria-label={copy.agent.removeImage}>
              <X />
            </button>
          </figure>
        ))}
      </div>
      <AssistantRuntimeProvider runtime={runtime}>
        <QuickSelectionPromptRunner
          prompt={props.pendingSelectionPrompt}
          onConsumed={props.clearPendingSelectionPrompt}
        />
        <AssistantThread
          page={page}
          suggestions={suggestions}
          contextPreview={contextPreview}
          selectedContext={props.selectedContext}
          onRemoveSelectedContext={() => props.setSelectedContext(null)}
          composerInputRef={props.composerInputRef}
          onPasteImages={addClipboardImages}
        />
      </AssistantRuntimeProvider>
    </aside>
  );
}

function SelectionToolbar(props: {
  state: SelectionToolbarState | null;
  onAdd: (context: SelectedContext) => void;
  onExplain: (context: SelectedContext) => void;
  onSummarize: (context: SelectedContext) => void;
}) {
  const copy = useAppCopy();
  if (!props.state) return null;
  const { context, x, y } = props.state;
  return (
    <div
      className="selection-toolbar"
      role="toolbar"
      aria-label={copy.agent.selectionToolbarAria}
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={() => props.onAdd(context)}>
        {copy.agent.addToConversation}
      </button>
      <button type="button" onClick={() => props.onExplain(context)}>
        {copy.agent.explainSelection}
      </button>
      <button type="button" onClick={() => props.onSummarize(context)}>
        {copy.agent.summarizeSelection}
      </button>
    </div>
  );
}

type PdfPageRenderStatus = "loading" | "ready" | "empty-text" | "error";

type PdfPageGeometry = {
  width: number;
  height: number;
  rotation: number;
};

type PdfScrollViewerProps = {
  documentId: string;
  documentTitle: string;
  fallbackSrc: string;
  pageNumber: number;
  url: string;
  viewMode: PdfViewMode;
  pdfContextFullPageLimit: number;
  pdfContextEdgePageCount: number;
  onDocumentReady: (pageCount: number) => void;
  onActivePageChange: (pageNumber: number) => void;
  onPdfContextReady: (context: PdfContextPayload) => void;
  onPdfPagesTextReady: (pages: PdfContextPage[]) => void;
  onViewerScroll?: () => void;
};

const pdfIntersectionThresholds = [0, 0.25, 0.5, 0.75, 1];

const PdfScrollViewer = forwardRef<PdfScrollViewerHandle, PdfScrollViewerProps>(function PdfScrollViewer({
  documentId,
  documentTitle,
  fallbackSrc,
  pageNumber,
  url,
  viewMode,
  pdfContextFullPageLimit,
  pdfContextEdgePageCount,
  onDocumentReady,
  onActivePageChange,
  onPdfContextReady,
  onPdfPagesTextReady,
  onViewerScroll,
}, ref) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const activePageTimerRef = useRef<number | null>(null);
  const activePageFrameRef = useRef<number | null>(null);
  const lastActivePageRef = useRef(pageNumber);
  const restoredUrlRef = useRef("");
  const viewportWidth = useElementWidth(scrollContainerRef);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentError, setDocumentError] = useState("");
  const [renderWindowCenter, setRenderWindowCenter] = useState(pageNumber);
  const [pageGeometries, setPageGeometries] = useState<Record<number, PdfPageGeometry>>({});
  const onDocumentReadyRef = useRef(onDocumentReady);
  const onPdfContextReadyRef = useRef(onPdfContextReady);
  const onPdfPagesTextReadyRef = useRef(onPdfPagesTextReady);
  const pageCount = pdfDocument?.numPages || 0;
  const safePageNumber = Math.min(Math.max(pageNumber, 1), Math.max(pageCount, 1));
  const pageNumbers = viewMode === "single-page"
    ? [safePageNumber]
    : Array.from({ length: pageCount }, (_, index) => index + 1);
  const pageGeometryFallback = pageGeometries[safePageNumber] || pageGeometries[1] || Object.values(pageGeometries)[0] || null;

  const updateRenderWindowCenter = useCallback((nextPage: number) => {
    setRenderWindowCenter((current) => current === nextPage ? current : nextPage);
  }, []);

  const rememberPageGeometry = useCallback((pageNo: number, geometry: PdfPageGeometry) => {
    setPageGeometries((current) => {
      const existing = current[pageNo];
      if (
        existing &&
        Math.abs(existing.width - geometry.width) < 0.5 &&
        Math.abs(existing.height - geometry.height) < 0.5 &&
        existing.rotation === geometry.rotation
      ) {
        return current;
      }
      return { ...current, [pageNo]: geometry };
    });
  }, []);

  const scheduleActivePage = useCallback((nextPage: number) => {
    if (lastActivePageRef.current === nextPage) return;
    if (activePageTimerRef.current) window.clearTimeout(activePageTimerRef.current);
    activePageTimerRef.current = window.setTimeout(() => {
      lastActivePageRef.current = nextPage;
      updateRenderWindowCenter(nextPage);
      onActivePageChange(nextPage);
    }, 130);
  }, [onActivePageChange, updateRenderWindowCenter]);

  const chooseActivePage = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const anchorY = rootRect.top + rootRect.height * 0.5;
    const visiblePages = Array.from(pageElementsRef.current.entries())
      .map(([pageNo, element]) => {
        const rect = element.getBoundingClientRect();
        const pageCenter = rect.top + rect.height / 2;
        const edgeDistance = rect.top > anchorY ? rect.top - anchorY : anchorY > rect.bottom ? anchorY - rect.bottom : 0;
        return {
          pageNo,
          top: rect.top,
          bottom: rect.bottom,
          centerDistance: Math.abs(pageCenter - anchorY),
          edgeDistance,
        };
      })
      .filter((entry) => entry.bottom > rootRect.top + 1 && entry.top < rootRect.bottom - 1);
    if (!visiblePages.length) return;

    const currentPage = visiblePages.find((entry) => entry.pageNo === lastActivePageRef.current);
    if (currentPage && currentPage.top <= anchorY && currentPage.bottom >= anchorY) {
      updateRenderWindowCenter(currentPage.pageNo);
      return;
    }

    const centerHits = visiblePages.filter((entry) => entry.top <= anchorY && entry.bottom >= anchorY);
    const candidates = centerHits.length ? centerHits : visiblePages;
    candidates.sort((left, right) => {
      if (centerHits.length) return left.centerDistance - right.centerDistance;
      const edgeDelta = left.edgeDistance - right.edgeDistance;
      if (Math.abs(edgeDelta) > 1) return edgeDelta;
      return left.centerDistance - right.centerDistance;
    });
    updateRenderWindowCenter(candidates[0].pageNo);
    scheduleActivePage(candidates[0].pageNo);
  }, [scheduleActivePage, updateRenderWindowCenter]);

  const requestActivePageFromLayout = useCallback(() => {
    if (activePageFrameRef.current) return;
    activePageFrameRef.current = window.requestAnimationFrame(() => {
      activePageFrameRef.current = null;
      chooseActivePage();
    });
  }, [chooseActivePage]);

  const scrollToPage = useCallback((targetPage: number, behavior: ScrollBehavior = "smooth") => {
    const pageNo = Math.min(Math.max(targetPage, 1), Math.max(pageCount, 1));
    const root = scrollContainerRef.current;
    const pageElement = pageElementsRef.current.get(pageNo);
    updateRenderWindowCenter(pageNo);
    if (!root || !pageElement) {
      onActivePageChange(pageNo);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const top = Math.max(0, root.scrollTop + pageRect.top - rootRect.top - 14);
    root.scrollTo({ top, behavior });
  }, [onActivePageChange, pageCount, updateRenderWindowCenter]);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  const registerPageElement = useCallback((pageNo: number) => (node: HTMLDivElement | null) => {
    if (node) {
      pageElementsRef.current.set(pageNo, node);
    } else {
      pageElementsRef.current.delete(pageNo);
    }
  }, []);

  useEffect(() => {
    onDocumentReadyRef.current = onDocumentReady;
    onPdfContextReadyRef.current = onPdfContextReady;
    onPdfPagesTextReadyRef.current = onPdfPagesTextReady;
  }, [onDocumentReady, onPdfContextReady, onPdfPagesTextReady]);

  useEffect(() => {
    let cancelled = false;
    let textExtractionTimer: number | null = null;
    setPdfDocument(null);
    setDocumentError("");
    setPageGeometries({});
    pageElementsRef.current.clear();
    restoredUrlRef.current = "";
    let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null = null;

    void loadPdfJsRuntime()
      .then((pdfJs) => {
        if (cancelled) return null;
        loadingTask = pdfJs.getDocument({ url, worker: pdfJs.createPdfWorker() });
        return loadingTask.promise;
      })
      .then((document) => {
        if (!document || cancelled) {
          return;
        }
        setPdfDocument(document);
        onDocumentReadyRef.current(document.numPages);
        const initialGeometryPage = Math.min(Math.max(pageNumber, 1), document.numPages);
        const contextPageNumbers = pdfContextPageNumbers(document.numPages, {
          pdfContextFullPageLimit,
          pdfContextEdgePageCount,
        });
        let contextPublished = false;
        const publishExtractionProgress = (pages: PdfContextPage[]) => {
          if (cancelled) return;
          onPdfPagesTextReadyRef.current(pages);
          if (contextPublished) return;
          const extractedPageNumbers = new Set(pages.map((page) => page.page_no));
          if (!contextPageNumbers.every((pageNo) => extractedPageNumbers.has(pageNo))) return;
          contextPublished = true;
          onPdfContextReadyRef.current(pdfContextFromExtractedPages(
            documentId,
            documentTitle,
            document.numPages,
            { pdfContextFullPageLimit, pdfContextEdgePageCount },
            pages,
          ));
        };
        void document.getPage(initialGeometryPage)
          .then((page) => {
            if (cancelled) return;
            const viewport = page.getViewport({ scale: 1 });
            rememberPageGeometry(initialGeometryPage, {
              width: viewport.width,
              height: viewport.height,
              rotation: viewport.rotation,
            });
          })
          .catch(() => undefined);
        textExtractionTimer = window.setTimeout(() => {
          void extractPdfPagesFromDocument(document, {
            priorityPageNumbers: [initialGeometryPage, ...contextPageNumbers],
            shouldCancel: () => cancelled,
            progressBatchSize: 8,
            delayMs: 90,
            onProgress: publishExtractionProgress,
          })
            .then((pages) => {
              if (cancelled) return;
              publishExtractionProgress(pages);
              if (!contextPublished) {
                contextPublished = true;
                onPdfContextReadyRef.current(pdfContextFromExtractedPages(
                  documentId,
                  documentTitle,
                  document.numPages,
                  { pdfContextFullPageLimit, pdfContextEdgePageCount },
                  pages,
                ));
              }
            })
            .catch(() => undefined);
        }, 2800);
      })
      .catch((error) => {
        if (cancelled) return;
        setDocumentError((error as Error).message || "PDF.js 无法加载该 PDF");
      });

    return () => {
      cancelled = true;
      if (textExtractionTimer !== null) window.clearTimeout(textExtractionTimer);
      if (activePageTimerRef.current) window.clearTimeout(activePageTimerRef.current);
      if (activePageFrameRef.current) window.cancelAnimationFrame(activePageFrameRef.current);
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [documentId, documentTitle, pdfContextEdgePageCount, pdfContextFullPageLimit, rememberPageGeometry, url]);

  useEffect(() => {
    lastActivePageRef.current = pageNumber;
    updateRenderWindowCenter(pageNumber);
  }, [pageNumber, updateRenderWindowCenter]);

  useEffect(() => {
    if (!pdfDocument || !scrollContainerRef.current || viewMode !== "continuous") return undefined;
    const observer = new IntersectionObserver(() => {
      requestActivePageFromLayout();
    }, {
      root: scrollContainerRef.current,
      threshold: pdfIntersectionThresholds,
    });

    const observedElements = Array.from(pageElementsRef.current.values());
    observedElements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [pdfDocument, pageCount, requestActivePageFromLayout, viewMode]);

  useEffect(() => {
    if (!pdfDocument || !pageCount || !viewportWidth || restoredUrlRef.current === url) return undefined;
    restoredUrlRef.current = url;
    const targetPage = Math.min(Math.max(pageNumber, 1), pageCount);
    const firstTimer = window.setTimeout(() => scrollToPage(targetPage, "auto"), 80);
    const secondTimer = window.setTimeout(() => scrollToPage(targetPage, "auto"), 320);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearTimeout(secondTimer);
    };
  }, [pageCount, pageNumber, pdfDocument, scrollToPage, url, viewportWidth]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "PageDown") {
      event.preventDefault();
      scrollToPage(Math.min(safePageNumber + 1, Math.max(pageCount, 1)), "smooth");
    } else if (event.key === "PageUp") {
      event.preventDefault();
      scrollToPage(Math.max(safePageNumber - 1, 1), "smooth");
    } else if (event.key === "Home") {
      event.preventDefault();
      scrollToPage(1, "smooth");
    } else if (event.key === "End") {
      event.preventDefault();
      scrollToPage(Math.max(pageCount, 1), "smooth");
    }
  }, [pageCount, safePageNumber, scrollToPage]);

  const handleScroll = useCallback(() => {
    onViewerScroll?.();
    requestActivePageFromLayout();
  }, [onViewerScroll, requestActivePageFromLayout]);

  if (documentError) {
    return (
      <div className="pdf-native-fallback">
        <iframe title="PDF 预览 fallback" src={fallbackSrc} />
        <div className="pdf-layer-note error">PDF.js 渲染失败，已保留原生预览 fallback。{documentError}</div>
      </div>
    );
  }

  return (
    <div
      className={`pdf-js-viewer pdf-scroll-viewer ${viewMode === "single-page" ? "single-page" : "continuous"}`}
      ref={scrollContainerRef}
      aria-label={`${documentTitle} PDF 阅读器`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
    >
      {!pdfDocument && <div className="pdf-layer-note">正在加载 PDF...</div>}
      {pdfDocument && (
        <div className="pdf-page-stack" role="list" aria-label={`${documentTitle} PDF 页面`}>
          {pageNumbers.map((pageNo) => {
            const shouldRenderPage = viewMode === "single-page" || Math.abs(pageNo - renderWindowCenter) <= 1;
            return (
              <div
                key={pageNo}
                ref={registerPageElement(pageNo)}
                className={`pdf-page-shell ${pageNo === safePageNumber ? "active" : ""}`}
                data-page-container-number={pageNo}
                role="listitem"
              >
                <div className="pdf-page-label">PDF p.{pageNo}</div>
                {shouldRenderPage ? (
                  <PdfPageLayer
                    pdfDocument={pdfDocument}
                    pageNumber={pageNo}
                    viewportWidth={viewportWidth}
                    geometry={pageGeometries[pageNo] || pageGeometryFallback}
                    onGeometryReady={rememberPageGeometry}
                  />
                ) : (
                  <PdfPagePlaceholder viewportWidth={viewportWidth} geometry={pageGeometries[pageNo] || pageGeometryFallback} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function pdfPageDisplayMetrics(viewportWidth: number, geometry: PdfPageGeometry | null | undefined) {
  const naturalWidth = Math.max(geometry?.width || 612, 1);
  const naturalHeight = Math.max(geometry?.height || 792, 1);
  const availableWidth = Math.max((viewportWidth || 760) - 56, 280);
  const scale = Math.min(2.2, Math.max(0.45, availableWidth / naturalWidth));
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    width,
    height,
    aspectRatio: `${naturalWidth} / ${naturalHeight}`,
  };
}

function PdfPagePlaceholder({ viewportWidth, geometry }: { viewportWidth: number; geometry?: PdfPageGeometry | null }) {
  const displayMetrics = pdfPageDisplayMetrics(viewportWidth, geometry);
  return (
    <div
      className="pdf-page-placeholder"
      aria-hidden="true"
      style={{
        width: `${displayMetrics.width}px`,
        height: `${displayMetrics.height}px`,
        aspectRatio: displayMetrics.aspectRatio,
      }}
    />
  );
}

function PdfPageLayer({
  pdfDocument,
  pageNumber,
  viewportWidth,
  geometry,
  onGeometryReady,
}: {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  viewportWidth: number;
  geometry?: PdfPageGeometry | null;
  onGeometryReady: (pageNo: number, geometry: PdfPageGeometry) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [pageStatus, setPageStatus] = useState<PdfPageRenderStatus>("loading");
  const [pageError, setPageError] = useState("");
  const displayMetrics = pdfPageDisplayMetrics(viewportWidth, geometry);
  const [viewportMeta, setViewportMeta] = useState({
    width: displayMetrics.width,
    height: displayMetrics.height,
    scale: 1,
    rotation: 0,
    pageNumber,
  });

  useEffect(() => {
    setViewportMeta((current) => ({
      ...current,
      width: displayMetrics.width,
      height: displayMetrics.height,
    }));
  }, [displayMetrics.height, displayMetrics.width]);

  useEffect(() => {
    if (!canvasRef.current || !textLayerRef.current) return undefined;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: { cancel: () => void; render: () => Promise<void> } | null = null;
    const textLayerElement = textLayerRef.current;
    const canvas = canvasRef.current;

    const renderPage = async () => {
      const pdfJs = await loadPdfJsRuntime();
      if (cancelled) return;
      setPageStatus("loading");
      setPageError("");
      textLayerElement.replaceChildren();

      const safePageNumber = Math.min(Math.max(pageNumber, 1), pdfDocument.numPages);
      const pdfPage = await pdfDocument.getPage(safePageNumber);
      if (cancelled) return;

      const baseViewport = pdfPage.getViewport({ scale: 1 });
      onGeometryReady(safePageNumber, {
        width: baseViewport.width,
        height: baseViewport.height,
        rotation: baseViewport.rotation,
      });
      const availableWidth = Math.max((viewportWidth || 760) - 56, 280);
      const scale = Math.min(2.2, Math.max(0.45, availableWidth / baseViewport.width));
      const viewport = pdfPage.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) throw new Error("浏览器无法创建 PDF canvas context");

      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      textLayerElement.style.width = `${viewport.width}px`;
      textLayerElement.style.height = `${viewport.height}px`;
      setViewportMeta({
        width: viewport.width,
        height: viewport.height,
        scale,
        rotation: viewport.rotation,
        pageNumber: safePageNumber,
      });

      renderTask = pdfPage.render({
        canvas,
        canvasContext,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        background: "rgb(255,255,255)",
      });

      await renderTask.promise;
      if (cancelled) return;
      setPageStatus("ready");

      try {
        await waitForPdfExtractionIdle(16);
        if (cancelled) return;
        const textContent = await pdfPage.getTextContent();
        if (cancelled) return;

        if (!hasSelectableText(textContent)) {
          if (!cancelled) setPageStatus("empty-text");
          return;
        }

        textLayer = new pdfJs.TextLayer({
          textContentSource: textContent,
          container: textLayerElement,
          viewport,
        });

        await textLayer.render();
      } catch (error) {
        if (!cancelled && !isPdfRenderCancel(error)) {
          textLayerElement.replaceChildren();
        }
      }
    };

    void renderPage().catch((error) => {
      if (cancelled || isPdfRenderCancel(error)) return;
      setPageError((error as Error).message || "PDF 当前页渲染失败");
      setPageStatus("error");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textLayerElement.replaceChildren();
    };
  }, [onGeometryReady, pageNumber, pdfDocument, viewportWidth]);

  return (
    <>
      <div
        className="pdf-page-layered"
        data-page-number={viewportMeta.pageNumber}
        data-viewport-rotation={viewportMeta.rotation}
        data-viewport-scale={viewportMeta.scale}
        style={{
          width: viewportMeta.width ? `${viewportMeta.width}px` : undefined,
          height: viewportMeta.height ? `${viewportMeta.height}px` : undefined,
          aspectRatio: `${Math.max(viewportMeta.width, 1)} / ${Math.max(viewportMeta.height, 1)}`,
        }}
      >
        <canvas ref={canvasRef} className="pdf-visual-layer" />
        <div ref={textLayerRef} className="textLayer pdf-text-layer" aria-label="PDF 可选文本层" />
      </div>
      {pageStatus === "loading" && <div className="pdf-layer-note">正在渲染 PDF 页面...</div>}
      {pageStatus === "empty-text" && (
        <div className="pdf-layer-note">当前 PDF 页没有可选文本层。可以继续查看页面，OCR/text extraction 接口预留后续接入。</div>
      )}
      {pageStatus === "error" && <div className="pdf-layer-note error">{pageError || "PDF 当前页渲染失败"}</div>}
    </>
  );
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function hasSelectableText(textContent: { items: unknown[] }) {
  return textContent.items.some((item) => {
    const value = item && typeof item === "object" && "str" in item ? item.str : "";
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isPdfRenderCancel(error: unknown) {
  const name = (error as { name?: string })?.name || "";
  return name === "RenderingCancelledException" || name === "AbortException";
}

function QuickSelectionPromptRunner(props: {
  prompt: QuickSelectionPrompt | null;
  onConsumed: (id: string) => void;
}) {
  const assistantUi = useAssistantUi();
  const thread = assistantUi.useThreadRuntime();
  const consumedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!props.prompt) return;
    if (consumedRef.current === props.prompt.id) return;
    consumedRef.current = props.prompt.id;
    thread.append({
      role: "user",
      content: [{ type: "text", text: props.prompt.prompt }],
    });
    props.onConsumed(props.prompt.id);
  }, [props.prompt, props.onConsumed, thread]);

  return null;
}

function OAuthDeviceDialog(props: {
  device: OAuthDevicePrompt;
  secondsLeft: number;
  copied: boolean;
  onCopy: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const copy = useAppCopy();
  const groups = splitOAuthUserCode(props.device.user_code);

  return (
    <section className="oauth-device-panel" role="dialog" aria-labelledby="oauth-device-title" aria-live="polite">
      <div className="oauth-device-header">
        <div>
          <p>{copy.oauth.kicker}</p>
          <h2 id="oauth-device-title">{copy.oauth.title}</h2>
        </div>
        <button className="oauth-device-close" type="button" aria-label={copy.oauth.cancel} onClick={props.onCancel}>
          <X />
        </button>
      </div>

      <div className="oauth-code-display" aria-label={copy.oauth.codeAria(props.device.user_code)}>
        {groups.map((group, groupIndex) => (
          <div className="oauth-code-group" key={`${group}-${groupIndex}`}>
            {groupIndex > 0 && <span className="oauth-code-separator">-</span>}
            {[...group].map((char, index) => (
              <span className="oauth-code-cell" key={`${char}-${index}`}>{char}</span>
            ))}
          </div>
        ))}
      </div>

      <div className="oauth-device-actions">
        <button className="oauth-secondary-button" type="button" onClick={props.onCopy}>
          {props.copied ? <Check /> : <Copy />}
          {props.copied ? copy.oauth.copied : copy.oauth.copyCode}
        </button>
        <button className="oauth-primary-button" type="button" onClick={props.onOpen}>
          <ExternalLink />
          {copy.oauth.openAuthPage}
        </button>
      </div>

      <div className="oauth-device-meta">
        <span><Clock /> {copy.oauth.expiresIn(formatSeconds(props.secondsLeft))}</span>
        <span>{props.device.verification_uri}</span>
      </div>
    </section>
  );
}

function AssistantThread({
  page,
  suggestions,
  contextPreview,
  selectedContext,
  onRemoveSelectedContext,
  composerInputRef,
  onPasteImages,
}: {
  page: PageData;
  suggestions: string[];
  contextPreview: string;
  selectedContext: SelectedContext | null;
  onRemoveSelectedContext: () => void;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onPasteImages: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ThreadPrimitive } = assistantUi;
  const thread = assistantUi.useThreadRuntime();
  const sendSuggestion = useCallback((suggestion: string) => {
    thread.append({
      role: "user",
      content: [{ type: "text", text: suggestion }],
    });
  }, [thread]);

  return (
    <ThreadPrimitive.Root className="aui-thread-root">
      <ThreadPrimitive.Viewport className="aui-thread-viewport">
        <div className="aui-thread-inner">
          <ThreadPrimitive.Empty>
            <div className="aui-welcome">
              <span className="aui-welcome-kicker">PDF p.{page.page_no} · {compactText(page.teaching.slide_title, 36)}</span>
              <h2>{copy.agent.askCurrentPage}</h2>
              <div className="prompt-suggestions" aria-label="Prompt suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => sendSuggestion(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <div className="aui-message-list">
            <ThreadPrimitive.Messages>{() => <AssistantMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="aui-thread-footer">
            <ThreadPrimitive.ScrollToBottom asChild>
              <button className="scroll-bottom" type="button">↓</button>
            </ThreadPrimitive.ScrollToBottom>
            <AssistantComposer
              contextPreview={contextPreview}
              selectedContext={selectedContext}
              onRemoveSelectedContext={onRemoveSelectedContext}
              inputRef={composerInputRef}
              onPasteImages={onPasteImages}
            />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function AssistantMessage() {
  const assistantUi = useAssistantUi();
  const role = assistantUi.useAuiState((state) => state.message.role);
  return role === "user" ? <UserMessage /> : <AgentMessage />;
}

function UserMessage() {
  const copy = useAppCopy();
  const { ActionBarPrimitive, MessagePrimitive } = useAssistantUi();
  return (
    <MessagePrimitive.Root className="aui-message user-message">
      <div className="message-bubble user-bubble">
        <MessagePrimitive.Quote>
          {(quote: { text: string }) => (
            <div className="message-quote">
              <span>{copy.agent.quoteLabel}</span>
              <p>{compactText(quote.text, 220)}</p>
            </div>
          )}
        </MessagePrimitive.Quote>
        <MessagePrimitive.Parts />
      </div>
      <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
        <ActionBarPrimitive.Edit asChild>
          <button type="button" aria-label={copy.agent.edit}><RefreshCw /></button>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function AgentMessage() {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const {
    ActionBarPrimitive,
    BranchPickerPrimitive,
    ErrorPrimitive,
    MessagePrimitive,
  } = assistantUi;
  const status = assistantUi.useAuiState((state) => state.message.status);
  const content = assistantUi.useAuiState((state) => state.message.content);
  const isThinking = status?.type === "running" && content.length === 0;
  const isStopped = status?.type === "incomplete" && status.reason === "cancelled";

  return (
    <MessagePrimitive.Root className="aui-message assistant-message">
      <div className="assistant-label">{copy.common.assistant}</div>
      <div className="message-bubble assistant-bubble">
        {isThinking && <AssistantThinkingIndicator />}
        {isStopped && <MessageStatusNote>{copy.agent.generationStopped}</MessageStatusNote>}
        <MessagePrimitive.Parts components={{ Text: MarkdownPart }} />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="message-error">
            {copy.agent.generationFailed}
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      <div className="assistant-footer">
        <BranchPickerPrimitive.Root hideWhenSingleBranch className="branch-picker">
          <BranchPickerPrimitive.Previous asChild>
            <button type="button"><ChevronLeft /></button>
          </BranchPickerPrimitive.Previous>
          <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
          <BranchPickerPrimitive.Next asChild>
            <button type="button"><ChevronRight /></button>
          </BranchPickerPrimitive.Next>
        </BranchPickerPrimitive.Root>
        <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
          <ActionBarPrimitive.Copy asChild>
            <button type="button" aria-label={copy.agent.copy}><Copy /></button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button type="button" aria-label={copy.agent.regenerate}><RefreshCw /></button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantComposer({
  contextPreview,
  selectedContext,
  onRemoveSelectedContext,
  inputRef,
  onPasteImages,
}: {
  contextPreview: string;
  selectedContext: SelectedContext | null;
  onRemoveSelectedContext: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPasteImages: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const copy = useAppCopy();
  const assistantUi = useAssistantUi();
  const { ComposerPrimitive } = assistantUi;
  const thread = assistantUi.useThreadRuntime();

  useEffect(() => {
    thread.composer.setQuote(
      selectedContext
        ? {
            text: selectedContext.text,
            messageId: selectedContext.id,
          }
        : undefined,
    );
  }, [selectedContext, thread]);

  return (
    <div className="composer-shell">
      {selectedContext && (
        <SelectedSourcePreview context={selectedContext} onRemove={onRemoveSelectedContext} />
      )}
      {contextPreview && (
        <div className="composer-context-preview">
          <span />
          {contextPreview}
        </div>
      )}
      <ComposerPrimitive.Root className="aui-composer-root">
        <ComposerPrimitive.Input
          ref={inputRef}
          className="aui-composer-input"
          placeholder={selectedContext ? copy.agent.askWithSelectionPlaceholder : copy.agent.askPlaceholder}
          rows={2}
          submitMode="enter"
          aria-label={copy.agent.inputAria}
          onPaste={onPasteImages}
        />
        <div className="aui-composer-actions">
          <ComposerPrimitive.Send asChild>
            <button className="composer-send" type="button" aria-label={copy.agent.send}><Send /></button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

function MarkdownPart() {
  const assistantUi = useAssistantUi();
  const text = assistantUi.useAuiState((state) => {
    if (state.part.type !== "text" && state.part.type !== "reasoning") return "";
    return state.part.text || "";
  });

  return (
    <ReaderMarkdown className="markdown-body" text={text} />
  );
}

function AssistantThinkingIndicator() {
  const copy = useAppCopy();
  return (
    <div className="assistant-thinking" aria-label="Assistant is thinking">
      <span className="thinking-wave" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
      <span>{copy.agent.thinking}</span>
    </div>
  );
}

function MessageStatusNote({ children }: { children: ReactNode }) {
  return <div className="message-status-note">{children}</div>;
}

function SelectedSourcePreview({ context, onRemove }: { context: SelectedContext; onRemove: () => void }) {
  const copy = useAppCopy();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`selected-source-preview ${expanded ? "expanded" : ""}`}>
      <button
        className="selected-source-main"
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="selected-source-label">{selectedContextSourceLabel(context, copy)}</span>
        <span className="selected-source-text">{compactText(context.text, expanded ? 520 : 220)}</span>
      </button>
      <button className="selected-source-remove" type="button" onClick={onRemove} aria-label={copy.agent.removeSelectedContent}>
        <X />
      </button>
    </div>
  );
}

function PaneToolbar({ title, badge, right }: { title: string; badge?: string; right?: ReactNode }) {
  return (
    <div className="pane-toolbar">
      <div className="toolbar-title">
        {badge ? <span className="confidence-badge">{badge}</span> : <span className="status-dot" />}
        <span>{title}</span>
      </div>
      {right}
    </div>
  );
}

function SlidePreview({ page }: { page: PageData }) {
  const copy = useAppCopy();
  return (
    <article className="slide-preview">
      <div className="slide-kicker">{copy.common.pageLabel(page.page_no)}</div>
      <h2>{page.teaching.slide_title}</h2>
      <div className="slide-grid">
        <div>
          <div className="slide-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="chips">
            {page.teaching.concepts.slice(0, 3).map((item) => <ReaderMarkdown className="chip" inline key={item} text={item} />)}
          </div>
        </div>
        <div className="slide-figure">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    </article>
  );
}

function GenerationDetailsPopover({
  copy,
  pages,
  currentPageNo,
  summary,
}: {
  copy: AppCopy;
  pages: Array<{ pageNo: number; status: GenerationPageStatus }>;
  currentPageNo: number;
  summary: { done: number; running: number; failed: number; pending: number };
}) {
  const pageRangeForStatus = (status: GenerationPageStatus) =>
    formatPageRanges(pages.filter((item) => item.status === status).map((item) => item.pageNo)) || copy.common.none;
  const currentStatus = pages.find((item) => item.pageNo === currentPageNo)?.status || "pending";
  const rows = [
    { label: copy.topbar.generationDetailsGenerated, value: `${summary.done}/${pages.length}`, detail: pageRangeForStatus("done") },
    { label: copy.topbar.generationDetailsPending, value: `${summary.pending}`, detail: pageRangeForStatus("pending") },
    ...(summary.running
      ? [{ label: copy.topbar.generationDetailsRunning, value: `${summary.running}`, detail: pageRangeForStatus("running") }]
      : []),
    ...(summary.failed ? [{ label: copy.topbar.generationDetailsFailed, value: `${summary.failed}`, detail: pageRangeForStatus("failed") }] : []),
    {
      label: copy.topbar.generationDetailsCurrent,
      value: `p.${currentPageNo}`,
      detail: generationStatusLabel(currentStatus, copy),
    },
  ];

  return (
    <div className="generation-details-popover" role="status" aria-label={copy.topbar.generationDetailsLabel}>
      <div className="generation-details-header">
        <span>{copy.topbar.generationDetailsLabel}</span>
        <strong>{summary.done}/{pages.length}</strong>
      </div>
      <div className="generation-details-list">
        {rows.map((row) => (
          <div className="generation-detail-row" key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            <small title={row.detail}>{row.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarkdownBlock({ markdown, concepts }: { markdown: string; concepts: string[] }) {
  return (
    <article className="note-markdown">
      <ReaderMarkdown className="note-markdown-content markdown-body" text={markdown} />
      <div className="chips">{concepts.map((item) => <ReaderMarkdown className="chip" inline key={item} text={item} />)}</div>
    </article>
  );
}

function ReaderMarkdown({ className, text, inline = false }: { className: string; text: string; inline?: boolean }) {
  return (
    <Suspense fallback={inline ? <span className={className}>{text}</span> : <div className={className}>{text}</div>}>
      <MarkdownRenderer className={className} inline={inline} text={text} />
    </Suspense>
  );
}

function StructurePanel({ page }: { page: PageData }) {
  const copy = useAppCopy();
  const rows = [
    [copy.structure.pageNo, copy.common.pageLabel(page.page_no)],
    [copy.structure.parser, page.source.parser],
    [copy.structure.ocr, page.source.ocr_used ? copy.structure.ocrEnabled : copy.structure.ocrDisabled],
    [copy.structure.confidence, `${Math.round(page.teaching.confidence * 100)}%`],
    [copy.structure.prerequisites, page.teaching.prerequisites.join(copy.common.listSeparator) || copy.common.none],
    [copy.structure.visualNotes, page.teaching.visual_explanations.join(copy.common.sentenceSeparator) || copy.common.none],
    [copy.structure.sourceText, page.source.text_md || copy.common.none],
  ];
  return (
    <div className="structure-grid">
      {rows.map(([label, value]) => (
        <div className="structure-row" key={label}>
          <div className="structure-label">{label}</div>
          <div className="structure-value">{value}</div>
        </div>
      ))}
    </div>
  );
}

function IconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`mini-button ${active ? "active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FileButton({ label, accept, onFile, children }: { label: string; accept: string; onFile: (file: File) => void; children: ReactNode }) {
  return (
    <label className="mini-button" title={label} aria-label={label}>
      {children}
      <input type="file" accept={accept} onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) onFile(file);
        event.currentTarget.value = "";
      }} />
    </label>
  );
}
