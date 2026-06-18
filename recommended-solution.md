# 最优方案：OpenAI Gateway + 双栏 PagePair Reader

## 结论

基于调研报告和你的新约束，最优方案应从“生成讲解 PDF/PPT”调整为：

**GPT-5.5 direct PDF understanding + OpenAI Gateway + deterministic PagePair Agent workflow + Web 双栏阅读器**

这个方案保留报告里最关键的页级可控性，同时升级模型入口：GPT-5.5 作为主模型直接读取 PDF，Docling/PyMuPDF/MinerU 作为稳定性、缓存和疑难页面兜底。输出从静态文件改成可交互页面：左侧显示原 PDF 当前页，右侧显示该页讲解、概念、图表解释、置信度和结构化 JSON。讲解不再二次生成 PDF，主产物改为可版本化、可编辑、可回放的 `lecture_pairpack.v1.json`。

## 为什么选它

1. **页级对齐最稳**：每一页都有独立 `page_no`、源 PDF 页、解析文本或模型 evidence、讲解结果和生成状态，方便定位问题。
2. **前端体验最好**：讲解和原文直接左右对照，适合学习、校对、二次编辑，不需要下载一个新的讲解 PDF。
3. **适配 OpenAI 入口**：模型调用统一进入后端 OpenAI Gateway，前端不暴露任何 API key。
4. **Agent 框架稳定**：Document Planner、Page Teaching、Reviewer、Repair 分层运行，失败页面可单独重跑。
5. **后续扩展空间大**：可以继续加 OCR、批处理、缓存、TTS、导出 Markdown/PPTX，但核心数据结构不用推倒重来。

## Agent 主流程

```mermaid
flowchart LR
    A["Upload PDF"] --> B["GPT-5.5 Document Planner"]
    B --> C["Document Plan JSON"]
    C --> D["Page Teaching Agent"]
    D --> E["Lecture PairPack JSON"]
    E --> F["Reviewer Agent"]
    F --> G{Pass?}
    G -- yes --> H["Web Reader"]
    G -- no --> I["Repair / Parser Fallback"]
    I --> D
```

详细框架见 [agent-framework.md](/Users/harry/PDF_Agent/agent-framework.md)，可配置 prompt 见 [prompts/course-agent.config.yaml](/Users/harry/PDF_Agent/prompts/course-agent.config.yaml)，输出 schema 见 [schemas/lecture_pairpack.schema.json](/Users/harry/PDF_Agent/schemas/lecture_pairpack.schema.json)。

## OpenAI OAuth 的落点

需要注意一个边界：OpenAI 平台常规模型 API 调用仍应由后端使用服务端凭据代理，不能把密钥放到浏览器。OAuth 更适合作为用户会话入口或 ChatGPT Apps/GPT Actions 这类集成场景的授权层。

因此这里推荐的认证结构是：

```mermaid
flowchart LR
    A["Browser UI"] --> B["/auth/openai/start"]
    B --> C["OpenAI OAuth / App Auth"]
    C --> D["Backend Session"]
    D --> E["OpenAI Gateway"]
    E --> F["Responses API / Batch API"]
    E --> G["Docling / PyMuPDF Parser"]
    G --> H["PagePair JSON Store"]
    F --> H
    H --> A
```

前端只拿应用会话 cookie 或短期 session token。模型侧所有调用都经过 `OpenAI Gateway`，这样后续无论是 API key、企业凭据、ChatGPT App OAuth，还是 OpenAI-compatible 网关，都只需要替换后端 adapter。

相关官方资料入口：

- OpenAI API Authentication：<https://developers.openai.com/api/reference/overview#authentication>
- Latest model guidance：<https://developers.openai.com/api/docs/guides/latest-model.md>
- PDF file input：<https://developers.openai.com/api/docs/guides/pdf-files>
- OpenAI Responses API：<https://developers.openai.com/api/reference/resources/responses/methods/create>
- Structured Outputs：<https://developers.openai.com/api/docs/guides/structured-outputs>
- Apps SDK reference：<https://developers.openai.com/apps-sdk/reference>

## 推荐展示格式

主格式选：

**`lecture_pairpack.v1.json` + Markdown 渲染**

示例结构：

```json
{
  "schema": "lecture_pairpack.v1",
  "document": {
    "id": "doc_001",
    "title": "课程 PDF",
    "source_pdf_url": "/files/doc_001/source.pdf",
    "page_count": 42
  },
  "pages": [
    {
      "page_no": 1,
      "source": {
        "pdf_page_ref": "#page=1",
        "text_md": "本页解析文本...",
        "ocr_used": false,
        "parser": "docling"
      },
      "teaching": {
        "slide_title": "课程导入",
        "speaker_notes_md": "这一页主要建立课程背景...",
        "concepts": ["课程目标", "学习路径"],
        "visual_explanations": ["右侧流程图展示章节关系。"],
        "confidence": 0.91
      },
      "status": "ready"
    }
  ]
}
```

这个格式比 PDF 更适合做产品：可局部重跑、可 diff、可缓存、可编辑、可导出 Markdown，也能在需要时再生成 PPTX speaker notes。

## 最小 API 形态

```http
GET  /auth/openai/start
GET  /auth/openai/callback
POST /api/documents
GET  /api/documents/:document_id
GET  /api/documents/:document_id/pages/:page_no
POST /api/documents/:document_id/generate
GET  /api/jobs/:job_id/events
PATCH /api/documents/:document_id/pages/:page_no/teaching
GET  /api/documents/:document_id/export?format=json|markdown
```

生成策略：

- 10 页以内：在线同步或短轮询。
- 10 页以上：异步任务 + SSE 进度。
- 离线批量：OpenAI Batch API。
- 解析缓存：`file_sha256 + parser_version`。
- 页级缓存：`page_hash + model + prompt_version`。
- 摘要缓存：`doc_hash + summary_prompt_version`。

## 前端布局

前端第一屏就是工作台，不做营销页：

- 左侧窄栏：页码、状态、置信度、搜索。
- 中间：原 PDF 当前页。
- 右侧：讲解 Markdown、概念、图表说明、JSON tab。
- 顶部：OpenAI OAuth 入口、上传 PDF、导入/导出 JSON、生成按钮。

当前仓库中的 `frontend/` 是这个方案的静态原型，可直接打开 `frontend/index.html` 预览。真实后端接入时，只需要把上传、OAuth 和生成按钮连接到上面的 API。
