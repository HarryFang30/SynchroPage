const samplePack = {
  schema: "lecture_pairpack.v1",
  document: {
    id: "demo_course_pdf",
    title: "课程 PDF 逐页讲解",
    source_pdf_url: "",
    page_count: 3
  },
  pages: [
    {
      page_no: 1,
      source: {
        pdf_page_ref: "#page=1",
        text_md: "课程目标：把 PDF 课件转换为逐页讲解。核心约束是页级对齐、结构化输出、可重跑。",
        ocr_used: false,
        parser: "docling"
      },
      teaching: {
        slide_title: "从讲解 PDF 改为双栏工作台",
        speaker_notes_md:
          "## 从讲解 PDF 改为双栏工作台\n\n这一页建立产品方向：系统不再把讲解重新排成 PDF，而是保留原始 PDF 页面作为左侧参照，在右侧生成可编辑的讲解内容。\n\n### 讲课口径\n\n- 先强调原 PDF 是事实来源，讲解只是对当前页的教学化展开。\n- 再说明 PagePair JSON 会把页号、解析文本、讲解稿和置信度绑定在一起。\n- 最后指出这种格式更适合校对、重跑和版本管理。",
        concepts: ["PagePair JSON", "左右对照", "页级对齐"],
        visual_explanations: ["左侧保留原页面语境，右侧只承载可编辑讲解。"],
        prerequisites: ["课程 PDF 已完成页级解析"],
        confidence: 0.94
      },
      status: "ready"
    },
    {
      page_no: 2,
      source: {
        pdf_page_ref: "#page=2",
        text_md: "系统流程：上传 PDF -> 解析 Page JSON -> 全局摘要 -> 逐页生成 -> JSON 校验 -> Web 展示。",
        ocr_used: false,
        parser: "docling"
      },
      teaching: {
        slide_title: "最优技术路径",
        speaker_notes_md:
          "## 最优技术路径\n\n本页说明后端架构。解析层使用 Docling 或 PyMuPDF 生成稳定的 Page JSON；生成层通过 OpenAI Gateway 调用 Responses API；展示层读取 lecture_pairpack.v1.json。\n\n### 讲课口径\n\n- 解析和生成分离，避免把整份 PDF 直接塞给模型。\n- OpenAI Gateway 是唯一模型入口，前端只关心任务状态和结果数据。\n- 如果遇到扫描件或公式密集页，再通过 fallback 路由切换 OCR 或专业解析器。",
        concepts: ["OpenAI Gateway", "Docling", "PyMuPDF", "Structured Outputs"],
        visual_explanations: ["流程图应突出 parser、generator、validator 三个边界。"],
        prerequisites: ["已确认不生成讲解 PDF"],
        confidence: 0.91
      },
      status: "ready"
    },
    {
      page_no: 3,
      source: {
        pdf_page_ref: "#page=3",
        text_md: "认证：前端走 OAuth 登录，模型请求走后端代理。输出：JSON 与 Markdown，而非 PDF。",
        ocr_used: false,
        parser: "docling"
      },
      teaching: {
        slide_title: "OAuth 与输出格式",
        speaker_notes_md:
          "## OAuth 与输出格式\n\n这一页要讲清楚安全边界：浏览器不应直接持有模型 API 凭据。用户通过 OpenAI OAuth 或应用会话进入系统，后端再统一代理模型调用。\n\n### 讲课口径\n\n- OAuth 负责用户身份和授权入口。\n- OpenAI Gateway 负责模型调用、限流、日志和缓存。\n- 最终展示格式是 JSON 加 Markdown 渲染，必要时再导出 Markdown 或 PPTX。",
        concepts: ["OAuth", "后端代理", "Markdown 渲染"],
        visual_explanations: ["认证链路应从浏览器指向后端，再由后端进入模型 API。"],
        prerequisites: ["已有后端 session 设计"],
        confidence: 0.88
      },
      status: "ready"
    }
  ]
};

let state = {
  pack: samplePack,
  currentPage: 1,
  pdfUrl: "",
  activeTab: "notes",
  query: "",
  oauthConnected: false,
  generationRunning: false
};

const els = {
  documentTitle: document.querySelector("#documentTitle"),
  oauthButton: document.querySelector("#oauthButton"),
  pdfInput: document.querySelector("#pdfInput"),
  jsonInput: document.querySelector("#jsonInput"),
  exportButton: document.querySelector("#exportButton"),
  generateButton: document.querySelector("#generateButton"),
  searchInput: document.querySelector("#searchInput"),
  pageCount: document.querySelector("#pageCount"),
  readyCount: document.querySelector("#readyCount"),
  pageList: document.querySelector("#pageList"),
  pdfFrame: document.querySelector("#pdfFrame"),
  pdfViewer: document.querySelector("#pdfViewer"),
  slidePreview: document.querySelector("#slidePreview"),
  prevButton: document.querySelector("#prevButton"),
  nextButton: document.querySelector("#nextButton"),
  pageOutput: document.querySelector("#pageOutput"),
  pdfStatus: document.querySelector("#pdfStatus"),
  confidenceBadge: document.querySelector("#confidenceBadge"),
  noteTitle: document.querySelector("#noteTitle"),
  notesPanel: document.querySelector("#notesPanel"),
  structurePanel: document.querySelector("#structurePanel"),
  jsonPanel: document.querySelector("#jsonPanel"),
  authStatus: document.querySelector("#authStatus"),
  jobStatus: document.querySelector("#jobStatus")
};

function normalizePack(raw) {
  const pages = Array.isArray(raw) ? raw : raw.pages;
  if (!Array.isArray(pages)) {
    throw new Error("JSON 需要包含 pages 数组");
  }

  return {
    schema: raw.schema || "lecture_pairpack.v1",
    document: {
      id: raw.document?.id || "imported_document",
      title: raw.document?.title || raw.title || "导入文档",
      source_pdf_url: raw.document?.source_pdf_url || "",
      page_count: pages.length
    },
    pages: pages.map((page, index) => {
      const teaching = page.teaching || page;
      return {
        page_no: Number(page.page_no || index + 1),
        source: {
          pdf_page_ref: page.source?.pdf_page_ref || `#page=${page.page_no || index + 1}`,
          text_md: page.source?.text_md || page.page_text || "",
          ocr_used: Boolean(page.source?.ocr_used),
          parser: page.source?.parser || "imported"
        },
        teaching: {
          slide_title: teaching.slide_title || teaching.title || `第 ${index + 1} 页讲解`,
          speaker_notes_md: teaching.speaker_notes_md || teaching.notes || "",
          concepts: Array.isArray(teaching.concepts) ? teaching.concepts : [],
          visual_explanations: Array.isArray(teaching.visual_explanations) ? teaching.visual_explanations : [],
          prerequisites: Array.isArray(teaching.prerequisites) ? teaching.prerequisites : [],
          confidence: Number(teaching.confidence ?? 0.72)
        },
        status: page.status || "ready"
      };
    })
  };
}

function currentPageData() {
  return state.pack.pages.find((page) => page.page_no === state.currentPage) || state.pack.pages[0];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }

    if (line.startsWith("### ")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
      continue;
    }

    if (line.startsWith("## ")) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      continue;
    }

    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    html.push(`<p>${escapeHtml(line)}</p>`);
  }

  if (inList) {
    html.push("</ul>");
  }

  return html.join("");
}

function renderPageList() {
  const query = state.query.trim().toLowerCase();
  const pages = state.pack.pages.filter((page) => {
    if (!query) return true;
    return page.teaching.slide_title.toLowerCase().includes(query);
  });

  els.pageList.innerHTML = pages
    .map((page) => {
      const score = Math.round(page.teaching.confidence * 100);
      const isActive = page.page_no === state.currentPage ? " active" : "";
      return `
        <button class="page-item${isActive}" type="button" data-page="${page.page_no}">
          <span class="page-number">${page.page_no}</span>
          <span class="page-copy">
            <strong>${escapeHtml(page.teaching.slide_title)}</strong>
            <span>${escapeHtml(page.status)} · ${escapeHtml(page.source.parser)}</span>
          </span>
          <span class="page-score">${score}%</span>
        </button>
      `;
    })
    .join("");

  for (const button of els.pageList.querySelectorAll(".page-item")) {
    button.addEventListener("click", () => {
      state.currentPage = Number(button.dataset.page);
      render();
    });
  }
}

function renderSlidePreview(page) {
  const concepts = page.teaching.concepts.slice(0, 3);
  els.slidePreview.innerHTML = `
    <div class="slide-kicker">第 ${page.page_no} 页</div>
    <h2>${escapeHtml(page.teaching.slide_title)}</h2>
    <div class="slide-grid">
      <div>
        <div class="slide-lines">
          <span class="slide-line"></span>
          <span class="slide-line"></span>
          <span class="slide-line"></span>
        </div>
        <div class="chips">
          ${concepts.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
      <div class="slide-figure" aria-hidden="true">
        <span class="bar" style="height:54%"></span>
        <span class="bar"></span>
        <span class="bar"></span>
        <span class="bar"></span>
      </div>
    </div>
  `;
}

function renderPdf(page) {
  if (state.pdfUrl) {
    const separator = state.pdfUrl.includes("#") ? "&" : "#";
    els.pdfViewer.src = `${state.pdfUrl}${separator}page=${page.page_no}`;
    els.pdfFrame.classList.add("has-pdf");
    els.pdfStatus.textContent = "PDF 预览";
  } else {
    els.pdfFrame.classList.remove("has-pdf");
    els.pdfStatus.textContent = "示例预览";
    renderSlidePreview(page);
  }
}

function renderNotes(page) {
  const teaching = page.teaching;
  els.confidenceBadge.textContent = `${Math.round(teaching.confidence * 100)}%`;
  els.noteTitle.textContent = teaching.slide_title;

  els.notesPanel.innerHTML = `
    <article class="note-markdown">
      ${markdownToHtml(teaching.speaker_notes_md)}
      <div class="chips">
        ${teaching.concepts.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}
      </div>
    </article>
  `;

  const rows = [
    ["页号", `第 ${page.page_no} 页`],
    ["解析器", page.source.parser],
    ["OCR", page.source.ocr_used ? "已启用" : "未启用"],
    ["前置概念", teaching.prerequisites.join("、") || "无"],
    ["图表说明", teaching.visual_explanations.join("；") || "无"],
    ["解析文本", page.source.text_md || "无"]
  ];

  els.structurePanel.innerHTML = `
    <div class="structure-grid">
      ${rows
        .map(
          ([label, value]) => `
            <div class="structure-row">
              <div class="structure-label">${escapeHtml(label)}</div>
              <div class="structure-value">${escapeHtml(value)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;

  els.jsonPanel.textContent = JSON.stringify(page, null, 2);
}

function renderMeta() {
  const pages = state.pack.pages;
  const ready = pages.filter((page) => page.status === "ready").length;
  els.documentTitle.textContent = state.pack.document.title;
  els.pageCount.textContent = `${pages.length} 页`;
  els.readyCount.textContent = `${ready} ready`;
  els.pageOutput.textContent = `${state.currentPage} / ${pages.length}`;
  els.authStatus.textContent = state.oauthConnected
    ? "OpenAI Gateway: OAuth session active"
    : "OpenAI Gateway: 未连接";
}

function renderTabs() {
  for (const button of document.querySelectorAll(".tab-button")) {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("active", panel.id === `${state.activeTab}Panel`);
  }
}

function render() {
  if (!state.pack.pages.length) return;
  const page = currentPageData();
  state.currentPage = page.page_no;

  renderMeta();
  renderPageList();
  renderPdf(page);
  renderNotes(page);
  renderTabs();
}

function movePage(delta) {
  const pages = state.pack.pages.map((page) => page.page_no);
  const index = pages.indexOf(state.currentPage);
  const nextIndex = Math.min(Math.max(index + delta, 0), pages.length - 1);
  state.currentPage = pages[nextIndex];
  render();
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.pack, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.pack.document.id || "lecture"}-pairpack.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function loadPdf(file) {
  if (state.pdfUrl) {
    URL.revokeObjectURL(state.pdfUrl);
  }
  state.pdfUrl = URL.createObjectURL(file);
  state.pack.document.title = file.name.replace(/\.pdf$/i, "");
  state.pack.document.source_pdf_url = file.name;
  render();
}

function loadJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state.pack = normalizePack(JSON.parse(String(reader.result)));
      state.currentPage = state.pack.pages[0]?.page_no || 1;
      els.jobStatus.textContent = "已导入 PagePair JSON";
      render();
    } catch (error) {
      els.jobStatus.textContent = error.message;
    }
  };
  reader.readAsText(file);
}

function connectOAuth() {
  state.oauthConnected = !state.oauthConnected;
  els.jobStatus.textContent = state.oauthConnected
    ? "OAuth 会话已模拟连接"
    : "OAuth 会话已断开";
  renderMeta();
}

function runMockGeneration() {
  if (state.generationRunning) return;
  state.generationRunning = true;
  els.generateButton.disabled = true;
  els.jobStatus.textContent = "生成中 0%";

  const pages = [...state.pack.pages];
  pages.forEach((page) => {
    page.status = "queued";
  });
  render();

  let index = 0;
  const timer = window.setInterval(() => {
    if (index > 0) {
      pages[index - 1].status = "ready";
      pages[index - 1].teaching.confidence = Math.min(0.98, pages[index - 1].teaching.confidence + 0.01);
    }
    if (index < pages.length) {
      pages[index].status = "running";
      const percent = Math.round((index / pages.length) * 100);
      els.jobStatus.textContent = `生成中 ${percent}%`;
      index += 1;
      render();
      return;
    }

    window.clearInterval(timer);
    state.generationRunning = false;
    els.generateButton.disabled = false;
    els.jobStatus.textContent = "生成完成";
    render();
  }, 520);
}

els.oauthButton.addEventListener("click", connectOAuth);
els.exportButton.addEventListener("click", exportJson);
els.generateButton.addEventListener("click", runMockGeneration);
els.prevButton.addEventListener("click", () => movePage(-1));
els.nextButton.addEventListener("click", () => movePage(1));
els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderPageList();
});

els.pdfInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) loadPdf(file);
});

els.jsonInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) loadJson(file);
});

for (const button of document.querySelectorAll(".tab-button")) {
  button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    renderTabs();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "ArrowLeft") movePage(-1);
  if (event.key === "ArrowRight") movePage(1);
});

render();
