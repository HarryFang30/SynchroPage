# PDF Agent

工业级课程 PDF Agent 原型：用 GPT-5.5 直读 PDF 作为主能力，用可恢复的 PagePair harness 保证页级稳定性、审计、缓存、重试和前端左右对照展示。

## 目录结构

```text
apps/
  web/                         # 静态双栏 PagePair Reader 原型
config/
  auth/                        # OpenAI OAuth / Gateway 认证策略
  harness/                     # harness 运行策略、并发、fallback、观测配置
  prompts/                     # 版本化 agent prompt 配置
contracts/
  schemas/lecture_pairpack/    # 模型输出 JSON Schema 契约
data/
  samples/pdfs/                # 本地样本 PDF
docs/
  architecture/                # 架构说明
  decisions/                   # 方案决策记录
  research/                    # 深度调研报告
  workflows/                   # 规范化工作流
examples/
  openai/                      # OpenAI Responses API 请求示例
src/
  pdf_agent/auth/              # ChatGPT Device Code OAuth manager
  pdf_agent/gateway/           # OpenAI/Codex gateway header 注入
  pdf_agent/harness/           # Python harness 包：loop、ports、policy、store、types
```

## 关键入口

- 架构总览：[docs/architecture/course-pdf-agent-framework.md](/Users/harry/PDF_Agent/docs/architecture/course-pdf-agent-framework.md)
- Harness 设计：[docs/architecture/agent-harness.md](/Users/harry/PDF_Agent/docs/architecture/agent-harness.md)
- OpenAI OAuth Gateway：[docs/architecture/openai-oauth-gateway.md](/Users/harry/PDF_Agent/docs/architecture/openai-oauth-gateway.md)
- 推荐方案：[docs/decisions/recommended-solution.md](/Users/harry/PDF_Agent/docs/decisions/recommended-solution.md)
- OAuth 配置：[config/auth/openai_oauth.yaml](/Users/harry/PDF_Agent/config/auth/openai_oauth.yaml)
- OAuth 登录示例：[examples/auth/openai_oauth_device_login.py](/Users/harry/PDF_Agent/examples/auth/openai_oauth_device_login.py)
- Prompt 配置：[config/prompts/course_agent.prompt.yaml](/Users/harry/PDF_Agent/config/prompts/course_agent.prompt.yaml)
- Harness 配置：[config/harness/course_pdf_harness.yaml](/Users/harry/PDF_Agent/config/harness/course_pdf_harness.yaml)
- Schema 契约：[contracts/schemas/lecture_pairpack/v1.schema.json](/Users/harry/PDF_Agent/contracts/schemas/lecture_pairpack/v1.schema.json)
- 前端原型：[apps/web/index.html](/Users/harry/PDF_Agent/apps/web/index.html)

## 推荐展示格式

当前选型是 `lecture_pairpack.v1.json + React/TypeScript Reader + assistant-ui Agent Panel`：

- 左侧保留原 PDF/页面预览，中间显示逐页讲解、结构和 JSON。
- 右侧 Agent Panel 使用 `@assistant-ui/react` 的 runtime、Thread、Message、Composer、ActionBar、BranchPicker primitives，不再是手写静态 chat DOM。
- 用户选中页面、讲解、结构或 JSON 中的内容后，可以加入 AI 上下文；当前页、LaTeX 数学公式、图片附件和自由文本会一起发送给后端。
- 模型入口统一走后端 OpenAI OAuth Gateway，浏览器不持有模型 token。

Agent Panel 的对话模型借鉴 Cherry Studio，但只迁移适合当前轻量栈的部分：

- 本地 `Conversation + Message + parts`，消息包含 `parent_id`、`status`、`parts`、时间戳，便于后续分支和重新生成。
- `parts` 支持 `text`、`quote`、`pdf_reference`、`file`、`error`，选区/PDF 页/图片不再混成一条纯字符串。
- 前端先创建 user message 和 assistant placeholder，再请求 `/api/agent/chat`；支持停止、重试、重新生成和 localStorage 持久化。
- 后端负责组装模型上下文：system prompt + 当前 PDF 页 + 引用 parts + 最近历史，并按字符预算裁剪，避免无限增长。

本地完整预览：

```bash
npm install
npm run build
PYTHONPATH=src python3 -m pdf_agent.web_app --port 8765
```

打开 <http://127.0.0.1:8765/>。开发时也可以运行 `npm run dev`，Vite 会把 `/api` 和 `/auth` 代理到本地 Python server。

## 本地校验

```bash
python3 -m compileall -q src
PYTHONPATH=src python3 -m unittest discover -s tests
npm run build
ruby -e 'require "yaml"; YAML.load_file("config/auth/openai_oauth.yaml"); YAML.load_file("config/harness/course_pdf_harness.yaml"); YAML.load_file("config/prompts/course_agent.prompt.yaml")'
python3 - <<'PY'
import json
from pathlib import Path
for path in Path("contracts/schemas").rglob("*.json"):
    json.loads(path.read_text())
print("schemas ok")
PY
```
