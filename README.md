# PDF Agent

工业级课程 PDF Agent 工作区：将 PDF 转换为页级对齐的 `lecture_pairpack.v1` 结构化产物，提供 React/TypeScript PagePair Reader，并通过 OpenAI OAuth Gateway 驱动右侧 IDE 风格 AI Agent Panel。

## 项目能力

- `apps/web`：现代化 React Reader，支持 PDF/页面预览、逐页讲解、结构化字段、JSON 检查、上下文 chips、图片附件和 `@assistant-ui/react` Agent Panel。
- `src/pdf_agent`：Python 后端，负责 OpenAI OAuth、ChatGPT Codex Gateway 请求、上下文组装、本地 HTTP server。
- `contracts/schemas`：版本化 JSON Schema，用于约束模型输出。
- `config`：OAuth、prompt、harness 策略配置。
- `docs`：架构、决策、研究、工作流文档。
- `scripts`：可重复执行的运维入口。

## 目录结构

```text
apps/
  web/                         React + TypeScript PagePair Reader 前端
    src/                       App 组件、assistant-ui adapter、CSS 视觉系统
config/
  auth/                        OpenAI OAuth 与 Gateway 配置
  harness/                     重试、fallback、批处理、观测策略
  prompts/                     课程 PDF 生成 prompt 契约
contracts/
  schemas/lecture_pairpack/    生成器和校验器共用的 JSON Schema
data/
  samples/pdfs/                可提交的小样本 PDF
docs/
  architecture/                系统设计和 gateway 说明
  decisions/                   技术选型与方案决策
  research/                    调研报告和参考仓库记录
  workflows/                   操作工作流规范
examples/
  auth/                        OAuth device flow 示例
  openai/                      Responses API 请求示例
scripts/
  check.sh                     完整本地校验入口
  run-web.sh                   构建前端并启动本地 Python server
src/pdf_agent/
  auth/                        ChatGPT device-code OAuth manager 和 API facade
  gateway/                     Codex gateway header、payload shaping、脱敏
  harness/                     Course PDF orchestration contracts 和 loop
  server/                      本地 HTTP server、OAuth routes、chat API
  web_app.py                   旧命令兼容 wrapper
tests/
  test_openai_oauth.py         OAuth/gateway 单元测试
  test_web_app.py              Server/static/chat payload 单元测试
```

生成物不要进仓库：`dist/`、`node_modules/`、`__pycache__/`、runtime data、`.env*` 都已被忽略。

## 环境要求

- Python 3.11 或更新版本。
- Node.js 20 或更新版本。当前开发机使用 Node `v24.6.0`、npm `11.12.1`。
- Ruby 可选。`scripts/check.sh` 会在 Ruby 存在时用它校验 YAML 语法。
- 首次 `npm install` 和真实 OpenAI OAuth / 模型调用需要网络。

## 安装

在仓库根目录执行：

```bash
npm install
```

当前 Python 后端只依赖标准库，不强制安装包。直接从源码运行时使用 `PYTHONPATH=src`。

可选：安装为 editable package：

```bash
python3 -m pip install -e .
```

安装后会得到控制台命令：

```bash
pdf-agent-web --port 8765
```

注意：`pdf-agent-web` 只启动 Python server；前端仍需要先执行 `npm run build`，或者用 `./scripts/run-web.sh` 自动完成构建。

## 快速启动

推荐命令：

```bash
./scripts/run-web.sh --port 8765
```

打开：

```text
http://127.0.0.1:8765/
```

等价手动命令：

```bash
npm run build
PYTHONPATH=src python3 -m pdf_agent.server.web_app --port 8765
```

旧入口仍然兼容：

```bash
PYTHONPATH=src python3 -m pdf_agent.web_app --port 8765
```

## 开发模式

终端 A：启动 Python backend。

```bash
PYTHONPATH=src python3 -m pdf_agent.server.web_app --port 8765
```

终端 B：启动 Vite。

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

`vite.config.ts` 会把 `/api` 和 `/auth` 代理到 `http://127.0.0.1:8765`，所以前端开发时不需要额外 CORS 配置。

## OpenAI OAuth 使用方式

浏览器不持有模型凭据，所有模型请求都经过后端代理。

流程：

1. 打开 Reader 后点击顶部锁形图标。
2. 前端调用 `POST /auth/openai/start`。
3. 后端创建 OpenAI device code。
4. 页面打开 OpenAI verification URL，并在浏览器允许时复制 user code。
5. 登录完成后，前端轮询 `POST /auth/openai/poll`。
6. 后端保存账号元数据和 refresh token 到 `~/.pdf_agent/openai_oauth.json`。
7. access token 只保存在后端内存中，到期前刷新。
8. Agent 提问时，前端调用 `POST /api/agent/chat`，后端再调用 Codex Responses endpoint。

OAuth / Gateway 配置在 [config/auth/openai_oauth.yaml](config/auth/openai_oauth.yaml)。

安全约定：

- 不要提交 `~/.pdf_agent/openai_oauth.json`。
- 不要把真实 token 写进 `config/`、`docs/`、`examples/` 或 `.env`。
- 运行时数据放到已忽略的目录，例如 `data/runtime/`、`runs/`、`outputs/`。

## Reader 使用方法

页面默认加载示例 PagePair 文档。核心工作流：

1. 用上传按钮导入 PDF。
2. 如果已有生成结果，用 JSON 按钮导入 `lecture_pairpack.v1` 文件。
3. 通过左侧页列表或顶部进度条切换页面。
4. 中间区域查看原 PDF/页面预览。
5. 右侧讲解区在「讲解 / 结构 / JSON」之间切换。
6. 在 Agent 面板中加入当前页、选中文本、公式或图片。
7. 在 composer 中提问，后端会带上当前页、上下文 chips、最近对话和图片附件。

前端发送给 `/api/agent/chat` 的 payload 包含：

- document metadata；
- current page；
- recent messages；
- `quote`、`pdf_reference` 等 context parts；
- image attachments data URL。

后端会转换为 Responses 风格的多模态请求，包括 `input_text` 和 `input_image`。

## 本地 API

```text
GET    /api/health
POST   /api/agent/chat
GET    /auth/openai/status
POST   /auth/openai/start
POST   /auth/openai/poll
POST   /auth/openai/logout
POST   /auth/openai/default
DELETE /auth/openai/accounts/:account_id
```

静态资源优先从 `dist/web` 提供。没有构建产物时会指向 `apps/web`，源码开发请使用 Vite。

## 校验

完整校验：

```bash
./scripts/check.sh
```

等价手动命令：

```bash
PYTHONPATH=src python3 -m compileall -q src tests
PYTHONPATH=src python3 -m unittest discover -s tests
npm run build
```

`npm run build` 可能出现 Vite chunk-size warning，因为 assistant-ui 和 markdown renderer 被打进主 bundle。这个 warning 不影响本地运行。

## 关键文档

- [架构总览](docs/architecture/course-pdf-agent-framework.md)
- [Harness 设计](docs/architecture/agent-harness.md)
- [OpenAI OAuth Gateway](docs/architecture/openai-oauth-gateway.md)
- [推荐方案](docs/decisions/recommended-solution.md)
- [PairPack 工作流](docs/workflows/course-pdf-pairpack.md)
- [深度研究报告](docs/research/deep-research-report.md)
- [Readest Reader 调研](docs/research/readest-reader-framework.md)

## 配置参考

- [config/auth/openai_oauth.yaml](config/auth/openai_oauth.yaml)：OAuth endpoint、本地 token 存储策略、Codex gateway URL、注入 headers、脱敏策略、前端 API 契约。
- [config/harness/course_pdf_harness.yaml](config/harness/course_pdf_harness.yaml)：parser/generator/fallback、并发、预算、checkpoint、观测默认值。
- [config/prompts/course_agent.prompt.yaml](config/prompts/course_agent.prompt.yaml)：模型指令和输出 schema 预期。
- [contracts/schemas/lecture_pairpack/v1.schema.json](contracts/schemas/lecture_pairpack/v1.schema.json)：完整文档输出 schema。
- [contracts/schemas/lecture_pairpack/page_batch.v1.schema.json](contracts/schemas/lecture_pairpack/page_batch.v1.schema.json)：页级批处理输出 schema。

## 工业化约定

- 前端只放在 `apps/web`，不要把运行时服务逻辑塞进前端目录。
- 后端 HTTP/API 入口放在 `src/pdf_agent/server`。
- OAuth、gateway、harness 作为独立包目录维护，避免互相直接读取对方内部状态。
- 契约 schema 只做增量演进；破坏性变更新建版本目录。
- 长任务持久化应接在 `src/pdf_agent/harness/session_store.py` 后面。
- 真实模型凭据只允许后端读取，浏览器永远只拿应用状态和 device code。
- 如果需要生产级 PDF 选区，单独接 `pdf.js` canvas/text layer，不引入完整 ebook engine。
