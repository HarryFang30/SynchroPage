import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ThreadAssistantMessagePart,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  FileInput,
  FileJson,
  Image,
  Lock,
  Maximize2,
  NotebookText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Send,
  Settings2,
  Sigma,
  Square,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

type PageData = {
  page_no: number;
  source: {
    pdf_page_ref: string;
    text_md: string;
    ocr_used: boolean;
    parser: string;
  };
  teaching: {
    slide_title: string;
    speaker_notes_md: string;
    concepts: string[];
    visual_explanations: string[];
    prerequisites: string[];
    confidence: number;
  };
  status: string;
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

type AgentSnapshot = {
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
};

type OAuthMode = "unknown" | "ready" | "connected" | "polling" | "offline" | "mock";
type PanelKey = "rail" | "notes" | "agent";
type PanelVisibility = Record<PanelKey, boolean>;

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

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function requestJson<T>(path: string, options: RequestInit = {}) {
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
      throw new Error("请先连接 OpenAI OAuth 后再发送。");
    }
    throw new Error(parsed?.message || parsed?.error || detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function normalizePack(raw: unknown): PagePack {
  const source = raw as Partial<PagePack> & { pages?: unknown[]; title?: string };
  const pages = Array.isArray(source) ? source : source.pages;
  if (!Array.isArray(pages)) throw new Error("JSON 需要包含 pages 数组");

  return {
    schema: source.schema || "lecture_pairpack.v1",
    document: {
      id: source.document?.id || "imported_document",
      title: source.document?.title || source.title || "导入文档",
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
        prerequisites?: string[];
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
        },
        teaching: {
          slide_title: teaching.slide_title || teaching.title || `第 ${index + 1} 页讲解`,
          speaker_notes_md: teaching.speaker_notes_md || teaching.notes || "",
          concepts: Array.isArray(teaching.concepts) ? teaching.concepts : [],
          visual_explanations: Array.isArray(teaching.visual_explanations)
            ? teaching.visual_explanations
            : [],
          prerequisites: Array.isArray(teaching.prerequisites) ? teaching.prerequisites : [],
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

function detectContextType(text: string): AgentContextItem["type"] {
  return /(\$\$?[^$]+\$\$?|\\\(|\\\[|\\begin\{|[∑∫√∞≈≠≤≥πθλμ])/.test(text)
    ? "formula"
    : "selection";
}

function pageContext(pack: PagePack, page: PageData): AgentContextItem {
  const teaching = page.teaching;
  return {
    id: createId("ctx_page"),
    type: "page",
    title: `第 ${page.page_no} 页`,
    source: teaching.slide_title,
    page_no: page.page_no,
    text: [
      `Document: ${pack.document.title}`,
      `Page: ${page.page_no}`,
      `Title: ${teaching.slide_title}`,
      page.source.text_md ? `Source text: ${page.source.text_md}` : "",
      teaching.speaker_notes_md ? `Teaching notes: ${teaching.speaker_notes_md}` : "",
      teaching.visual_explanations.length
        ? `Visual notes: ${teaching.visual_explanations.join("；")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function readFileAsDataUrl(file: File) {
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
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
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
  getPack: () => PagePack;
  getPage: () => PageData;
  isBackendOffline: () => boolean;
}): ChatModelAdapter {
  return {
    async run(options: ChatModelRunOptions) {
      const snapshot = args.getSnapshot();
      const pack = args.getPack();
      const page = args.getPage();
      const latestUser = [...options.messages].reverse().find((message) => message.role === "user");
      const latestUserText = latestUser ? messageText(latestUser) : "";

      const parts = [
        latestUserText ? { type: "text", text: latestUserText } : null,
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
        document: pack.document,
        page,
        messages: options.messages.map((message) => ({
          role: message.role,
          status: "success",
          content: messageText(message),
          parts: [{ type: "text", text: messageText(message) }],
        })),
        input: latestUserText || "请根据上下文继续。",
        parts,
        attachments: snapshot.attachments,
      };

      try {
        const response = await requestJson<{ message?: { content?: string }; content?: string }>(
          "/api/agent/chat",
          {
            method: "POST",
            body: JSON.stringify(payload),
            signal: options.abortSignal,
          },
        );
        const content = response.message?.content || response.content;
        if (!content) throw new Error("AI 网关返回了空结果");
        return {
          content: [{ type: "text", text: content }] satisfies ThreadAssistantMessagePart[],
        };
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        if (!args.isBackendOffline()) throw error;
        const local = [
          "本地预览回复：真实回答会通过后端 `/api/agent/chat` 使用 OpenAI OAuth 发送。",
          snapshot.contexts.length ? `已读取 ${snapshot.contexts.length} 段上下文。` : `已读取第 ${page.page_no} 页。`,
          snapshot.attachments.length ? `同时包含 ${snapshot.attachments.length} 张图片。` : "",
          latestUserText ? `你的问题：${latestUserText}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text: local }] satisfies ThreadAssistantMessagePart[],
        };
      }
    },
  };
}

export default function App() {
  const [pack, setPack] = useState<PagePack>(samplePack);
  const [currentPageNo, setCurrentPageNo] = useState(1);
  const [pdfUrl, setPdfUrl] = useState("");
  const [activeTab, setActiveTab] = useState<"notes" | "structure" | "json">("notes");
  const [panels, setPanels] = useState<PanelVisibility>(fullPanelVisibility);
  const [query, setQuery] = useState("");
  const [oauthMode, setOauthMode] = useState<OAuthMode>("unknown");
  const [oauthAccount, setOauthAccount] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState("本地原型");
  const [contexts, setContexts] = useState<AgentContextItem[]>([]);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const lastSelectionRef = useRef<AgentContextItem | null>(null);

  const page = pack.pages.find((item) => item.page_no === currentPageNo) || pack.pages[0];
  const currentIndex = Math.max(0, pack.pages.findIndex((item) => item.page_no === page.page_no));
  const percent = pack.pages.length ? Math.round(((currentIndex + 1) / pack.pages.length) * 100) : 0;
  const pdfOnly = !panels.rail && !panels.notes && !panels.agent;
  const fullWorkbench = panels.rail && panels.notes && panels.agent;
  const filteredPages = pack.pages.filter((item) =>
    query ? item.teaching.slide_title.toLowerCase().includes(query.toLowerCase()) : true,
  );
  const workspaceColumns = useMemo(() => {
    const columns = [
      panels.rail ? "232px" : null,
      pdfOnly ? "minmax(0, 1fr)" : "minmax(296px, 1.04fr)",
      panels.notes ? "minmax(312px, 0.96fr)" : null,
      panels.agent ? "minmax(328px, 0.92fr)" : null,
    ];
    return columns.filter(Boolean).join(" ");
  }, [panels.agent, panels.notes, panels.rail, pdfOnly]);
  const workspaceRows = useMemo(() => {
    const rows = [
      panels.rail ? "auto" : null,
      pdfOnly ? "minmax(620px, calc(100vh - 170px))" : "minmax(420px, 55vh)",
      panels.notes ? "minmax(420px, auto)" : null,
      panels.agent ? "minmax(520px, auto)" : null,
    ];
    return rows.filter(Boolean).join(" ");
  }, [panels.agent, panels.notes, panels.rail, pdfOnly]);
  const workspaceStyle = {
    "--workspace-columns": workspaceColumns,
    "--workspace-rows": workspaceRows,
  } as CSSProperties;

  const togglePanel = useCallback((key: PanelKey) => {
    setPanels((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const togglePdfOnly = useCallback(() => {
    setPanels((current) => {
      const currentPdfOnly = !current.rail && !current.notes && !current.agent;
      return currentPdfOnly ? fullPanelVisibility : { rail: false, notes: false, agent: false };
    });
  }, []);

  const getSnapshot = useCallback(
    () => ({ contexts, attachments }),
    [attachments, contexts],
  );
  const getPack = useCallback(() => pack, [pack]);
  const getPage = useCallback(() => page, [page]);

  const addContext = useCallback((context: AgentContextItem) => {
    setContexts((items) => {
      const signature = `${context.type}:${context.page_no}:${context.source}:${context.text}`;
      if (items.some((item) => `${item.type}:${item.page_no}:${item.source}:${item.text}` === signature)) {
        return items;
      }
      return [...items, context].slice(-10);
    });
    setPanels((current) => ({ ...current, agent: true }));
  }, []);

  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    const element =
      selection?.anchorNode instanceof Element
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement;
    const source = element?.closest(".notes-pane")
      ? "讲解选区"
      : element?.closest(".pdf-pane")
        ? "PDF/页面选区"
        : element?.closest(".page-rail")
          ? "目录选区"
          : "页面选区";
    const context = text
      ? {
          id: createId("ctx_selection"),
          type: detectContextType(text),
          title: source,
          source,
          page_no: page.page_no,
          text,
        }
      : lastSelectionRef.current;
    if (!context) {
      setJobStatus("没有可加入的页面选区");
      return;
    }
    addContext(context);
    setJobStatus("选区已加入 Agent");
  }, [addContext, page.page_no]);

  const handleSelectionChange = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (!text) return;
    lastSelectionRef.current = {
      id: createId("ctx_selection"),
      type: detectContextType(text),
      title: "页面选区",
      source: "页面选区",
      page_no: page.page_no,
      text,
    };
  }, [page.page_no]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [handleSelectionChange]);

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

  const connectOAuth = async () => {
    try {
      const status = await requestJson<{ authenticated: boolean }>("/auth/openai/status");
      if (status.authenticated) {
        await requestJson("/auth/openai/logout", { method: "POST" });
        setOauthMode("ready");
        setOauthAccount(null);
        setJobStatus("OAuth 会话已断开");
        return;
      }
      const device = await requestJson<{
        user_code: string;
        device_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      }>("/auth/openai/start", { method: "POST" });
      await navigator.clipboard?.writeText(device.user_code).catch(() => undefined);
      window.open(device.verification_uri, "_blank", "noopener,noreferrer");
      setOauthMode("polling");
      setJobStatus(`授权码 ${device.user_code}`);
      const expiresAt = Date.now() + device.expires_in * 1000;
      const timer = window.setInterval(async () => {
        if (Date.now() > expiresAt) {
          window.clearInterval(timer);
          setOauthMode("ready");
          setJobStatus("OAuth 授权码已过期");
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
          window.clearInterval(timer);
          setOauthMode("connected");
          setOauthAccount(account.login || account.id || null);
          setJobStatus("OAuth 已连接");
        } catch (error) {
          window.clearInterval(timer);
          setOauthMode("ready");
          setJobStatus((error as Error).message);
        }
      }, Math.max(device.interval || 8, 8) * 1000);
    } catch {
      setOauthMode((mode) => (mode === "mock" ? "offline" : "mock"));
      setOauthAccount((account) => (account ? null : "static preview"));
      setJobStatus("OAuth 后端未启动，已进入静态模拟连接");
    }
  };

  useEffect(() => {
    void refreshOAuthStatus();
  }, []);

  const loadPdf = (file: File) => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    const url = URL.createObjectURL(file);
    setPdfUrl(url);
    setPack((current) => ({
      ...current,
      document: {
        ...current.document,
        title: file.name.replace(/\.pdf$/i, ""),
        source_pdf_url: file.name,
      },
    }));
  };

  const loadJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = normalizePack(JSON.parse(String(reader.result)));
        setPack(next);
        setCurrentPageNo(next.pages[0]?.page_no || 1);
        setJobStatus("已导入 PagePair JSON");
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

  const movePage = (delta: number) => {
    const nextIndex = Math.min(Math.max(currentIndex + delta, 0), pack.pages.length - 1);
    setCurrentPageNo(pack.pages[nextIndex].page_no);
  };

  const authText =
    oauthMode === "connected"
      ? `OpenAI Gateway: OAuth session active${oauthAccount ? ` · ${oauthAccount}` : ""}`
      : oauthMode === "polling"
        ? "OpenAI Gateway: 等待授权"
        : oauthMode === "offline"
          ? "OpenAI Gateway: 后端未启动"
          : "OpenAI Gateway: 未连接";

  return (
    <div className={`app-shell ${pdfOnly ? "pdf-focus" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PP</div>
          <div>
            <h1>PagePair Reader</h1>
            <p>{pack.document.title}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="layout-switcher" role="group" aria-label="工作区布局">
            <IconButton label="恢复完整工作台" active={fullWorkbench} onClick={() => setPanels(fullPanelVisibility)}>
              <Columns3 />
            </IconButton>
            <IconButton label={panels.rail ? "隐藏左侧目录" : "显示左侧目录"} active={panels.rail} onClick={() => togglePanel("rail")}>
              {panels.rail ? <PanelLeftClose /> : <PanelLeftOpen />}
            </IconButton>
            <IconButton label={panels.notes ? "隐藏讲解面板" : "显示讲解面板"} active={panels.notes} onClick={() => togglePanel("notes")}>
              <NotebookText />
            </IconButton>
            <IconButton label={panels.agent ? "隐藏 AI Agent" : "显示 AI Agent"} active={panels.agent} onClick={() => togglePanel("agent")}>
              {panels.agent ? <PanelRightClose /> : <PanelRightOpen />}
            </IconButton>
            <IconButton label={pdfOnly ? "退出 PDF 专注" : "只看 PDF"} active={pdfOnly} onClick={togglePdfOnly}>
              <Maximize2 />
            </IconButton>
          </div>
          <IconButton label="连接 OpenAI OAuth" active={oauthMode === "connected"} onClick={connectOAuth}>
            <Lock />
          </IconButton>
          <FileButton label="上传 PDF" accept="application/pdf" onFile={loadPdf}>
            <Upload />
          </FileButton>
          <FileButton label="导入 PagePair JSON" accept="application/json,.json" onFile={loadJson}>
            <FileInput />
          </FileButton>
          <IconButton label="导出 JSON" onClick={exportJson}>
            <FileJson />
          </IconButton>
          <IconButton label="阅读设置">
            <Settings2 />
          </IconButton>
          <button className="primary-button" type="button" onClick={() => setJobStatus("生成任务已交给后端 harness")}>
            <Zap />
            生成
          </button>
        </div>
      </header>

      <section className="reader-progress">
        <div className="progress-meta">
          <span>{page.teaching.slide_title}</span>
          <strong>{percent}%</strong>
        </div>
        <input
          type="range"
          min={1}
          max={Math.max(pack.pages.length, 1)}
          value={currentIndex + 1}
          onChange={(event) => setCurrentPageNo(pack.pages[Number(event.target.value) - 1]?.page_no || 1)}
          aria-label="页面进度"
        />
      </section>

      <main className="workspace" style={workspaceStyle}>
        <aside className="page-rail" hidden={!panels.rail}>
          <div className="rail-tools">
            <div className="search-box">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索页标题" />
            </div>
            <div className="rail-meta">
              <span>{pack.pages.length} 页</span>
              <span>{pack.pages.filter((item) => item.status === "ready").length} ready</span>
            </div>
          </div>
          <div className="page-list">
            {filteredPages.map((item) => (
              <button
                className={`page-item ${item.page_no === page.page_no ? "active" : ""}`}
                key={item.page_no}
                type="button"
                onClick={() => setCurrentPageNo(item.page_no)}
              >
                <span className="page-number">{item.page_no}</span>
                <span className="page-copy">
                  <strong>{item.teaching.slide_title}</strong>
                  <span>
                    {item.status} · {item.source.parser}
                  </span>
                </span>
                <span className="page-score">{Math.round(item.teaching.confidence * 100)}%</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="pdf-pane">
          <PaneToolbar
            title={pdfUrl ? "PDF 预览" : "示例预览"}
            right={
              <div className="toolbar-actions">
                <IconButton label="上一页" onClick={() => movePage(-1)}>
                  <ChevronLeft />
                </IconButton>
                <output>{page.page_no} / {pack.pages.length}</output>
                <IconButton label="下一页" onClick={() => movePage(1)}>
                  <ChevronRight />
                </IconButton>
              </div>
            }
          />
          <div className={`pdf-frame ${pdfUrl ? "has-pdf" : ""}`}>
            {pdfUrl ? (
              <iframe title="PDF 预览" src={`${pdfUrl}#page=${page.page_no}`} />
            ) : (
              <SlidePreview page={page} />
            )}
          </div>
          {page.source.text_md && (
            <div className="pdf-source-strip">
              <Sigma />
              <p>{page.source.text_md}</p>
            </div>
          )}
        </section>

        <section className="notes-pane" hidden={!panels.notes}>
          <PaneToolbar
            title={page.teaching.slide_title}
            badge={`${Math.round(page.teaching.confidence * 100)}%`}
            right={
              <div className="tab-group">
                {(["notes", "structure", "json"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`tab-button ${activeTab === tab ? "active" : ""}`}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === "notes" ? "讲解" : tab === "structure" ? "结构" : "JSON"}
                  </button>
                ))}
              </div>
            }
          />
          <div className="notes-content">
            {activeTab === "notes" && <MarkdownBlock markdown={page.teaching.speaker_notes_md} concepts={page.teaching.concepts} />}
            {activeTab === "structure" && <StructurePanel page={page} />}
            {activeTab === "json" && <pre className="json-panel">{JSON.stringify(page, null, 2)}</pre>}
          </div>
        </section>

        <AgentPanel
          hidden={!panels.agent}
          contexts={contexts}
          attachments={attachments}
          setContexts={setContexts}
          setAttachments={setAttachments}
          addCurrentPage={() => {
            addContext(pageContext(pack, page));
            setJobStatus("当前页已加入 Agent");
          }}
          captureSelection={captureSelection}
          getSnapshot={getSnapshot}
          getPack={getPack}
          getPage={getPage}
          backendOffline={oauthMode === "offline" || oauthMode === "mock"}
          oauthMode={oauthMode}
        />
      </main>

      <footer className="statusbar">
        <span>{authText}</span>
        <span>{jobStatus}</span>
      </footer>
    </div>
  );
}

function AgentPanel(props: {
  hidden: boolean;
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
  setContexts: (fn: AgentContextItem[] | ((items: AgentContextItem[]) => AgentContextItem[])) => void;
  setAttachments: (fn: AgentAttachment[] | ((items: AgentAttachment[]) => AgentAttachment[])) => void;
  addCurrentPage: () => void;
  captureSelection: () => void;
  getSnapshot: () => AgentSnapshot;
  getPack: () => PagePack;
  getPage: () => PageData;
  backendOffline: boolean;
  oauthMode: OAuthMode;
}) {
  const adapter = useMemo(
    () =>
      createPdfAgentAdapter({
        getSnapshot: props.getSnapshot,
        getPack: props.getPack,
        getPage: props.getPage,
        isBackendOffline: () => props.backendOffline,
      }),
    [props.backendOffline, props.getPage, props.getPack, props.getSnapshot],
  );
  const runtime = useLocalRuntime(adapter);

  const addImages = async (files: FileList | File[]) => {
    const images = await Promise.all([...files].filter((file) => file.type.startsWith("image/")).slice(0, 6).map(readFileAsDataUrl));
    props.setAttachments((items) => [...items, ...images].slice(-8));
  };

  return (
    <aside className="agent-panel" hidden={props.hidden}>
      <div className="agent-toolbar">
        <div className="toolbar-title">
          <span className="agent-dot" />
          <span>Agent</span>
        </div>
        <div className="toolbar-actions">
          <span className="agent-model">{props.oauthMode === "connected" ? "OAuth" : props.backendOffline ? "Local" : "OAuth"}</span>
          <IconButton label="加入当前页" onClick={props.addCurrentPage}><FileJson /></IconButton>
          <IconButton label="加入选区" onClick={props.captureSelection}><Bot /></IconButton>
          <label className="mini-button" title="加入图片" aria-label="加入图片">
            <Image />
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
          <IconButton label="清空上下文" onClick={() => props.setContexts([])}><Trash2 /></IconButton>
        </div>
      </div>
      <div className="agent-context-strip">
        {props.contexts.map((context) => (
          <span className="context-pill" key={context.id}>
            <strong>{context.type === "formula" ? "Math" : context.type === "page" ? "Page" : "Quote"}</strong>
            <span>{compactText(context.text, 80)}</span>
            <button type="button" onClick={() => props.setContexts((items) => items.filter((item) => item.id !== context.id))} aria-label="移除上下文">
              <X />
            </button>
          </span>
        ))}
        {props.attachments.map((attachment) => (
          <span className="context-pill image-pill" key={attachment.id}>
            <img src={attachment.data_url} alt="" />
            <span>{attachment.name}</span>
            <button type="button" onClick={() => props.setAttachments((items) => items.filter((item) => item.id !== attachment.id))} aria-label="移除图片">
              <X />
            </button>
          </span>
        ))}
      </div>
      <AssistantRuntimeProvider runtime={runtime}>
        <AssistantThread />
      </AssistantRuntimeProvider>
    </aside>
  );
}

function AssistantThread() {
  return (
    <ThreadPrimitive.Root className="aui-thread-root">
      <ThreadPrimitive.Viewport className="aui-thread-viewport">
        <div className="aui-thread-inner">
          <ThreadPrimitive.Empty>
            <div className="aui-welcome">
              <Bot />
              <h2>PagePair Agent</h2>
            </div>
          </ThreadPrimitive.Empty>
          <div className="aui-message-list">
            <ThreadPrimitive.Messages>{() => <AssistantMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="aui-thread-footer">
            <ThreadPrimitive.ScrollToBottom asChild>
              <button className="scroll-bottom" type="button">↓</button>
            </ThreadPrimitive.ScrollToBottom>
            <AssistantComposer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function AssistantMessage() {
  const role = useAuiState((state) => state.message.role);
  return role === "user" ? <UserMessage /> : <AgentMessage />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="aui-message user-message">
      <div className="message-bubble user-bubble">
        <MessagePrimitive.Parts />
      </div>
      <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
        <ActionBarPrimitive.Edit asChild>
          <button type="button" aria-label="编辑"><RefreshCw /></button>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function AgentMessage() {
  return (
    <MessagePrimitive.Root className="aui-message assistant-message">
      <div className="assistant-label">Agent</div>
      <div className="message-bubble assistant-bubble">
        <MessagePrimitive.Parts components={{ Text: MarkdownPart }} />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="message-error">
            <ErrorPrimitive.Message />
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
            <button type="button" aria-label="复制"><Copy /></button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button type="button" aria-label="重新生成"><RefreshCw /></button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantComposer() {
  return (
    <ComposerPrimitive.Root className="aui-composer-root">
      <ComposerPrimitive.Input
        className="aui-composer-input"
        placeholder="Ask with selected PDF context"
        rows={2}
        aria-label="Agent message input"
      />
      <div className="aui-composer-actions">
        <button className="composer-tool" type="button" title="数学公式"><Sigma /></button>
        <ComposerPrimitive.Cancel asChild>
          <button className="composer-send" type="button" aria-label="停止"><Square /></button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <button className="composer-send" type="button" aria-label="发送"><Send /></button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

function MarkdownPart() {
  return <MarkdownTextPrimitive className="markdown-body" />;
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
  return (
    <article className="slide-preview">
      <div className="slide-kicker">第 {page.page_no} 页</div>
      <h2>{page.teaching.slide_title}</h2>
      <div className="slide-grid">
        <div>
          <div className="slide-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="chips">
            {page.teaching.concepts.slice(0, 3).map((item) => <span className="chip" key={item}>{item}</span>)}
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

function MarkdownBlock({ markdown, concepts }: { markdown: string; concepts: string[] }) {
  return (
    <article className="note-markdown">
      <SimpleMarkdown markdown={markdown} />
      <div className="chips">{concepts.map((item) => <span className="chip" key={item}>{item}</span>)}</div>
    </article>
  );
}

function SimpleMarkdown({ markdown }: { markdown: string }) {
  return (
    <>
      {markdown.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith("## ")) return <h2 key={index}>{trimmed.slice(3)}</h2>;
        if (trimmed.startsWith("### ")) return <h3 key={index}>{trimmed.slice(4)}</h3>;
        if (trimmed.startsWith("- ")) return <p className="bullet" key={index}>• {trimmed.slice(2)}</p>;
        return <p key={index}>{trimmed}</p>;
      })}
    </>
  );
}

function StructurePanel({ page }: { page: PageData }) {
  const rows = [
    ["页号", `第 ${page.page_no} 页`],
    ["解析器", page.source.parser],
    ["OCR", page.source.ocr_used ? "已启用" : "未启用"],
    ["前置概念", page.teaching.prerequisites.join("、") || "无"],
    ["图表说明", page.teaching.visual_explanations.join("；") || "无"],
    ["解析文本", page.source.text_md || "无"],
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

function IconButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      className={`mini-button ${active ? "active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
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
