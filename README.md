# SynchroPage

SynchroPage 是工业级课程 PDF 阅读与讲解工作区：将 PDF 转换为页级对齐的 `synchropage.lecture.v1` 结构化产物，提供 React/TypeScript 双栏阅读器，并通过 OpenAI OAuth Gateway 驱动右侧 IDE / Cursor / Codex 风格 AI Agent Panel。

当前前端是 local-first workspace：PDF Blob、讲解页、Agent 对话、PDF 选区上下文、当前页、设置和布局都会保存到 IndexedDB，刷新后自动恢复。

## 项目能力

- `apps/web`：现代化 React Reader，支持 PDF.js canvas/text-layer 预览、真实 PDF 文字选区、逐页讲解、结构化字段、JSON 检查、上下文 chips、图片附件、`@assistant-ui/react` Agent Panel 和 local-first persistence。
- `src/pdf_agent`：Python 后端，负责 OpenAI OAuth、ChatGPT Codex Gateway 请求、上下文组装、本地 HTTP server。
- `contracts/schemas`：版本化 JSON Schema，用于约束模型输出。
- `config`：OAuth、prompt、harness 策略配置。
- `docs`：架构、决策、研究、工作流文档。
- `scripts`：可重复执行的运维入口。

## 目录结构

```text
apps/
  desktop/                    Electron macOS app shell，自动启动后端并打开 Reader
  web/                         React + TypeScript SynchroPage 前端
    src/                       App 组件、assistant-ui adapter、CSS 视觉系统
      lib/persistence/         Dexie/IndexedDB schema、store、migration、import/export、repair
config/
  auth/                        OpenAI OAuth 与 Gateway 配置
  harness/                     重试、fallback、批处理、观测策略
  prompts/                     课程 PDF 生成 prompt 契约
contracts/
  schemas/synchropage_lecture/    生成器和校验器共用的 JSON Schema
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
  build-desktop-backend.sh     用 PyInstaller 构建 Electron sidecar 后端
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

仓库根目录只保留仓库级配置。前端自己的 `package.json`、`package-lock.json`、`tsconfig*.json` 和 `vite.config.ts` 全部位于 `apps/web/`。

## 环境要求

- Python 3.11 或更新版本。
- Node.js 20 或更新版本。当前开发机使用 Node `v24.6.0`、npm `11.12.1`。
- 构建 macOS App 需要 Electron / electron-builder 依赖，以及 PyInstaller。
- Ruby 可选。`scripts/check.sh` 会在 Ruby 存在时用它校验 YAML 语法。
- 浏览器需要支持 IndexedDB。建议使用 Chrome / Edge / Safari 当前稳定版。
- 首次安装前端依赖和真实 OpenAI OAuth / 模型调用需要网络。

## 安装

在仓库根目录执行：

```bash
npm --prefix apps/web install
```

如果需要构建或运行 macOS 桌面 App，再安装桌面端依赖：

```bash
npm --prefix apps/desktop install
python3 -m pip install pyinstaller
```

Python 后端依赖 `PyPDF2` 和 `PyYAML`。建议安装为 editable package，或者至少安装 `pyproject.toml` 中声明的运行时依赖。直接从源码运行时使用 `PYTHONPATH=src`。

可选：安装为 editable package：

```bash
python3 -m pip install -e .
```

安装后会得到控制台命令：

```bash
pdf-agent-web --port 8765
```

注意：`pdf-agent-web` 只启动 Python server；前端仍需要先执行 `npm --prefix apps/web run build`，或者用 `./scripts/run-web.sh` 自动完成构建。

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
npm --prefix apps/web run build
PYTHONPATH=src python3 -m pdf_agent.server.web_app --port 8765
```

旧入口仍然兼容：

```bash
PYTHONPATH=src python3 -m pdf_agent.web_app --port 8765
```

## macOS App

桌面端位于 `apps/desktop`。它使用 Electron 作为 macOS 外壳，启动时会：

1. 找到可用端口，默认优先 `127.0.0.1:8765`。
2. 如果该端口已经是 SynchroPage 后端，就直接复用。
3. 否则启动内置 Python sidecar `synchropage-backend`。
4. 把打包进 App 的 `web-dist` 通过 `--web-root` 传给后端。
5. 在桌面窗口中打开 `http://127.0.0.1:<port>/`。

本地开发方式：

```bash
npm --prefix apps/desktop run dev
```

构建可双击的 `.app`：

```bash
npm --prefix apps/desktop run pack
open "apps/desktop/release/mac-arm64/SynchroPage.app"
```

也可以使用仓库级一键脚本：

```bash
./scripts/build-macos-app.sh
```

自用时直接构建、安装到系统「应用程序」并打开：

```bash
./scripts/build-macos-app.sh --install --open
```

如果只想安装到当前用户目录：

```bash
./scripts/build-macos-app.sh --user-install --open
```

`pack` 会依次执行：

```text
npm --prefix apps/web run build
scripts/build-desktop-backend.sh
electron-builder --mac --dir
```

生成物：

```text
apps/desktop/release/mac-arm64/SynchroPage.app
```

如果要生成 DMG / zip：

```bash
npm --prefix apps/desktop run dist
```

默认 `pack` 和 `dist` 会跳过 macOS 自动签名，适合本机使用和测试，避免钥匙串/证书交互卡住构建。正式发布签名包时使用：

```bash
npm --prefix apps/desktop run dist:signed
```

### Mac App Store 发布

App Store 发布使用 Electron MAS target，配置在 [apps/desktop/package.json](apps/desktop/package.json) 的 `build.mas` / `build.masDev` 中。

项目已提供：

- [apps/desktop/entitlements/entitlements.mas.plist](apps/desktop/entitlements/entitlements.mas.plist)：MAS 主应用 sandbox entitlements；
- [apps/desktop/entitlements/entitlements.mas.inherit.plist](apps/desktop/entitlements/entitlements.mas.inherit.plist)：Electron helper / sidecar 继承 entitlements；
- [apps/desktop/profiles](apps/desktop/profiles)：本机 provisioning profile 放置目录，真实 profile 不进 git；
- [scripts/check-mas-signing.sh](scripts/check-mas-signing.sh)：构建前检查证书和 provisioning profile。

需要你在 Apple Developer / App Store Connect 中准备：

1. Apple Developer Program 账号。
2. App Store Connect app 记录。
3. 显式 App ID / bundle ID：`com.synchropage.reader`。如果要换 bundle ID，需要同步修改 `apps/desktop/package.json` 的 `build.appId`，并重新创建 profiles。
4. 本机 Keychain 中安装 `Apple Development` 证书，用于 `mas-dev` 本地 sandbox 测试。
5. 本机 Keychain 中安装 `Apple Distribution` / `3rd Party Mac Developer Application` 证书，用于 App Store 构建。
6. 本机 Keychain 中安装 Mac App Store installer 证书。electron-builder 当前会查找 legacy 名称 `3rd Party Mac Developer Installer`。
7. 下载匹配 bundle ID 的 provisioning profiles：
   - `apps/desktop/profiles/SynchroPage_Development.provisionprofile`
   - `apps/desktop/profiles/SynchroPage_AppStore.provisionprofile`

检查当前机器是否具备 MAS 构建条件：

```bash
npm --prefix apps/desktop run mas:check -- --dev
npm --prefix apps/desktop run mas:check -- --dist
```

构建本地 MAS sandbox 测试版：

```bash
npm --prefix apps/desktop run mas:dev
```

构建 App Store 上传包：

```bash
npm --prefix apps/desktop run mas:dist
```

成功后会在 `apps/desktop/release/` 下生成 MAS `.pkg`，用 Transporter 上传到 App Store Connect。

如果 profile 不放在默认目录，可以使用环境变量：

```bash
SYNCHROPAGE_MAS_DEV_PROFILE=/path/to/dev.provisionprofile npm --prefix apps/desktop run mas:dev
SYNCHROPAGE_MAS_PROFILE=/path/to/appstore.provisionprofile npm --prefix apps/desktop run mas:dist
```

注意：App Store 构建必须启用 Apple App Sandbox。当前 entitlements 开启了本应用需要的最小能力：本地后端 localhost 通信、OpenAI 网络请求、用户选择文件读写、Downloads 导出，以及 Electron 在 MAS 下需要的 JIT 权限。真实提交前需要在一台干净机器上测试 `mas-dev`，确认 PDF 上传、IndexedDB 持久化、OpenAI OAuth、Agent 请求和 Python sidecar 启动都能在 sandbox 下工作。

桌面端日志写入 macOS app logs 目录，例如：

```text
~/Library/Logs/SynchroPage/backend.log
```

桌面端持久化数据默认写入 Electron 的 `userData` 目录，包含 Chromium profile、IndexedDB、localStorage 等前端本地数据。可以在启动前指定数据根目录：

```bash
SYNCHROPAGE_DESKTOP_DATA_DIR=/path/to/SynchroPageData npm --prefix apps/desktop start
```

也可以通过 JSON 配置文件指定：

```bash
SYNCHROPAGE_DESKTOP_CONFIG=/path/to/synchropage-desktop.json npm --prefix apps/desktop start
```

```json
{
  "dataDir": "~/SynchroPageData",
  "backendDataDir": "~/SynchroPageData/backend",
  "oauthStoragePath": "~/SynchroPageData/backend/openai_oauth.json"
}
```

如果只设置 `dataDir`，桌面端会默认把后端 `PDF_AGENT_HOME` 放到 `<dataDir>/backend`，并把 OAuth refresh token 存到 `<dataDir>/backend/openai_oauth.json`。显式设置 `PDF_AGENT_HOME` 或 `PDF_AGENT_OPENAI_OAUTH_STORAGE_PATH` 时会优先使用显式值。

在桌面应用内也可以从 `设置 → 存储 → 保存目录` 手动选择目录、恢复默认目录或直接重启应用。由于 IndexedDB / Chromium profile 的目录必须在启动前确定，目录更改会在重启后生效。

可选环境变量：

```text
SYNCHROPAGE_DESKTOP_PORT=8765              默认端口
SYNCHROPAGE_DESKTOP_PORT_SCAN_LIMIT=20     端口扫描数量
SYNCHROPAGE_BACKEND_START_TIMEOUT_MS=30000 后端启动超时
SYNCHROPAGE_DESKTOP_DEVTOOLS=1             打开 Electron DevTools
SYNCHROPAGE_DESKTOP_DATA_DIR=/path/to/data 桌面端 userData/IndexedDB 保存目录
SYNCHROPAGE_DESKTOP_CONFIG=/path/to/config 桌面端 JSON 配置文件
SYNCHROPAGE_BACKEND_DATA_DIR=/path/to/data 后端默认数据目录
SYNCHROPAGE_BACKEND_BINARY=/path/to/bin    使用指定后端 sidecar
PDF_AGENT_HOME=/path/to/backend-data       Python 后端默认数据目录
PDF_AGENT_OPENAI_OAUTH_STORAGE_PATH=/path/to/openai_oauth.json  OAuth token 文件
```

## 开发模式

终端 A：启动 Python backend。

```bash
PYTHONPATH=src python3 -m pdf_agent.server.web_app --port 8765
```

终端 B：启动 Vite。

```bash
npm --prefix apps/web run dev
```

打开：

```text
http://127.0.0.1:5173/
```

`apps/web/vite.config.ts` 会把 `/api` 和 `/auth` 代理到 `http://127.0.0.1:8765`，所以前端开发时不需要额外 CORS 配置。

## OpenAI OAuth 使用方式

浏览器不持有模型凭据，所有模型请求都经过后端代理。

桌面应用内置 Codex device-code flow 使用的 OpenAI OAuth public client id，因此自用场景下不需要额外配置环境变量。这个 client id 不是 access token / refresh token，不具备模型调用权限；真实会话仍由你登录后保存在本机的 refresh token 负责。

如果你要覆盖默认 client id，可以使用环境变量：

```bash
export PDF_AGENT_OPENAI_OAUTH_CLIENT_ID="app_xxx"
```

也兼容 `OPENAI_OAUTH_CLIENT_ID`。仓库里的 [config/auth/openai_oauth.yaml](config/auth/openai_oauth.yaml) 保留 `${PDF_AGENT_OPENAI_OAUTH_CLIENT_ID}` 占位符；当环境变量不存在时，后端会回退到内置的 Codex public client id。

流程：

1. 打开 Reader 后点击顶部「更多」菜单中的「连接 OpenAI OAuth」。
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

页面默认加载示例 SynchroPage 文档。核心工作流：

1. 用上传按钮导入 PDF。
2. 如果已有生成结果，用 JSON 按钮导入 `synchropage.lecture.v1` 文件。
3. 通过左侧页列表或 PDF pane toolbar 切换页面。
4. 中间区域查看原 PDF 页面；当前实现优先走 PDF.js canvas + transparent text layer，失败时回退原生 PDF 预览。
5. 讲解区在「讲解 / 结构 / JSON」之间切换。
6. 在 PDF 页面真实可见文字上拖选文本，浮动工具条可「添加到对话 / 解释选中内容 / 总结选中内容」。
7. 在 Agent 面板中加入当前页、PDF 选区、公式或图片。
8. 在 composer 中提问，后端会带上当前 PDF context、选中文字、页码位置、上下文 chips、最近对话和图片附件。

前端发送给 `/api/agent/chat` 的 payload 包含：

- document metadata；
- current page；
- recent messages；
- `selectedContext`，包含 PDF 页码、选区文本、rects、viewport scale；
- `pdfContext`，长 PDF 会按 Settings 中的页数阈值截取前后页；
- `quote`、`pdf_reference` 等 context parts；
- image attachments data URL。

后端会转换为 Responses 风格的多模态请求，包括 `input_text` 和 `input_image`。

## 本地保存与恢复

前端使用 Dexie + IndexedDB 作为 local-first persistence layer。不要把 PDF、聊天或生成内容存进 `localStorage`；`localStorage` 只保存很小的 fallback，例如 `lastWorkspaceId` 和 UI preference fallback。

SynchroPage 使用全新的本地存储命名空间。旧版本地工作区不会迁移，刷新或重新打开后会从新的 IndexedDB / localStorage key 开始保存。

保存位置：

```text
IndexedDB database: synchropage-reader
localStorage key: synchropage.lastWorkspaceId.v1
```

浏览器开发模式下这些数据由浏览器 profile 管理。桌面端由 Electron `userData` 目录承载，可通过 `SYNCHROPAGE_DESKTOP_DATA_DIR` 或 `SYNCHROPAGE_DESKTOP_CONFIG` 配置。

主要表：

```text
workspaces        workspace metadata、active document/thread、当前页、layout snapshot、settings snapshot
documents         PDF / SynchroPage document metadata、页数、当前 PDF 页、pdfBlobId
fileBlobs         PDF Blob 本体
generatedPages    逐页讲解 markdown/json/status
chatThreads       Agent 对话线程
chatMessages      user/assistant/system 消息、selectedContext、sourceRefs、streaming status
selectedContexts  composer 中尚未发送的 PDF/讲解/助手选区
settings          theme、语言、debug、PDF context 截断策略等 UI 设置
```

自动保存触发点：

- PDF 上传成功后保存 Blob + Document + Workspace。
- PDF 页码切换、讲解页变化、Settings/layout 变化会 debounce 保存。
- Agent 消息发送前先保存 user message；assistant 消息从 pending、streaming 到 completed/failed/stopped 都会持续保存。
- selected context 添加到 composer 时保存，清空时删除。
- 页面隐藏或刷新前会尝试 flush 当前 workspace 快照。

恢复流程：

1. 启动时读取 `lastWorkspaceId`。
2. 加载 workspace、active document、PDF Blob、generated pages、active chat thread 和 messages。
3. 从 Blob 重新创建 object URL 并交给现有 PDF renderer。
4. 恢复 current PDF page、settings、layout、selected context 和 Agent 初始消息。
5. 如果 metadata 存在但 Blob 缺失，会显示恢复失败状态，不会静默白屏。

Settings → 存储 提供：

- 保存状态；
- workspace / document 数量；
- 本地存储占用估算；
- persistent storage 状态和启用按钮；
- 导出当前 workspace；
- 导入 workspace；
- 清空当前 workspace；
- 检查并清理存储；
- 重置当前 workspace。

导出 workspace 会包含 metadata、PDF Blob data URL、讲解页、聊天、选区、settings、table counts 和 PDF Blob SHA-256 hash。导入时会先校验 schema、引用关系、counts、Blob 大小和 hash，再在单个 IndexedDB transaction 中写入，最后切换 `lastWorkspaceId`。

当前持久化实现借鉴了 Cherry Studio 的几个工程实践：

- schema 和 service 分层；
- Dexie migration scaffold；
- 导入前 validate、导入时 transaction commit；
- 统一错误分类；
- storage repair / orphan cleanup；
- page hide flush。

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

静态资源优先从 `apps/web/dist` 提供。没有构建产物时会指向 `apps/web`，源码开发请使用 Vite。桌面 App 会通过 `--web-root` 明确指定打包进 `.app` 的前端资源目录。

## 校验

完整校验：

```bash
./scripts/check.sh
```

等价手动命令：

```bash
PYTHONPATH=src python3 -m compileall -q src tests
PYTHONPATH=src python3 -m unittest discover -s tests
npm --prefix apps/web run build
```

前端单独校验：

```bash
npm --prefix apps/web run check
npm --prefix apps/web run build
```

`npm --prefix apps/web run build` 可能出现 Vite chunk-size warning，因为 assistant-ui、pdf.js 和 markdown renderer 被打进主 bundle。这个 warning 不影响本地运行。

## 关键文档

- [架构总览](docs/architecture/course-pdf-agent-framework.md)
- [Harness 设计](docs/architecture/agent-harness.md)
- [OpenAI OAuth Gateway](docs/architecture/openai-oauth-gateway.md)
- [推荐方案](docs/decisions/recommended-solution.md)
- [SynchroPage Lecture 工作流](docs/workflows/course-pdf-synchropage.md)
- [深度研究报告](docs/research/deep-research-report.md)
- [Readest Reader 调研](docs/research/readest-reader-framework.md)

## 配置参考

- [config/auth/openai_oauth.yaml](config/auth/openai_oauth.yaml)：OAuth endpoint、本地 token 存储策略、Codex gateway URL、注入 headers、脱敏策略、前端 API 契约。
- [config/harness/course_pdf_harness.yaml](config/harness/course_pdf_harness.yaml)：parser/generator/fallback、并发、预算、checkpoint、观测默认值。
- [config/prompts/course_agent.prompt.yaml](config/prompts/course_agent.prompt.yaml)：模型指令和输出 schema 预期。
- [contracts/schemas/synchropage_lecture/v1.schema.json](contracts/schemas/synchropage_lecture/v1.schema.json)：完整文档输出 schema。
- [contracts/schemas/synchropage_lecture/page_batch.v1.schema.json](contracts/schemas/synchropage_lecture/page_batch.v1.schema.json)：页级批处理输出 schema。

## 工业化约定

- 前端只放在 `apps/web`，不要把运行时服务逻辑塞进前端目录。
- 后端 HTTP/API 入口放在 `src/pdf_agent/server`。
- OAuth、gateway、harness 作为独立包目录维护，避免互相直接读取对方内部状态。
- 契约 schema 只做增量演进；破坏性变更新建版本目录。
- 长任务持久化应接在 `src/pdf_agent/harness/session_store.py` 后面。
- 真实模型凭据只允许后端读取，浏览器永远只拿应用状态和 device code。
- PDF 预览和选区走受控 PDF.js canvas/text layer；不要回退到旁边/下面额外 reflow 原文层。
- 前端 workspace 数据必须通过 `apps/web/src/lib/persistence` 访问，不要把 IndexedDB 操作散落到组件里。
- PDF Blob、chat、generated pages 不允许塞进 `localStorage`。
