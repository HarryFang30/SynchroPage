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

已经打好包、只想安装（不重新构建）：

```bash
./scripts/build-macos-app.sh --no-build --install --open
```

打包阶段 electron-builder 会访问 github.com 校验 Electron（本地有缓存也一样），网络不通时报 `getaddrinfo ENOTFOUND github.com`，重试即可；`--no-build` 只复制 `apps/desktop/release` 里现成的 `.app`，不需要网络。

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

## coproxy 网关（gpt-6-astra）

除 OAuth 外，后端预置了 `coproxy` provider（OpenAI Responses 协议，指向自建 coproxy 网关，主力模型 `gpt-6-astra`）。
在「设置 → Providers」填入 token 并启用，或在启动后端前 `export COPROXY_API_KEY=...`。
后端会按模型自动夹取 `reasoning.effort`（`gpt-6-astra` 不支持 `none`，`gpt-5.5` 不支持 `max`）。
完整步骤、验证命令和排障见 [docs/workflows/coproxy-gateway-setup.md](docs/workflows/coproxy-gateway-setup.md)。

安全约定：

- 不要提交 `~/.pdf_agent/openai_oauth.json`。
- 不要把真实 token 写进 `config/`、`docs/`、`examples/` 或 `.env`。
- 运行时数据放到已忽略的目录，例如 `data/runtime/`、`runs/`、`outputs/`。

## Reader 使用方法

页面默认加载示例 SynchroPage 文档。核心工作流：

1. 用上传按钮导入 PDF。
2. 如果已有生成结果，用 JSON 按钮导入 `synchropage.lecture.v1` 文件。
3. 通过 PDF pane toolbar、讲解区的「地图」或直接滚动切换页面。打开 / 关闭侧栏或缩放窗口时，PDF 视图会保持在同一页的同一位置。
4. 中间区域查看原 PDF 页面；当前实现优先走 PDF.js canvas + transparent text layer，失败时回退原生 PDF 预览。
5. 讲解区在「讲解 / 笔记 / 地图」之间切换：「地图」是课程地图，备课之后按段列出每段讲什么、每页的角色和详略、★ 重点页、每页讲解是否已生成，点任一页就跳到 PDF 的那一页。打开 设置 → 高级 → Debug 模式 后会多出「结构 / JSON」两个检查用的标签页。生成菜单里「整份 PDF」会重新备课并重写所有页，「补齐缺失」只生成还没有讲解的页。
6. 在 PDF 页面真实可见文字上拖选文本，浮动工具条可「添加到对话 / 解释选中内容 / 总结选中内容」。
7. 在 Agent 面板中加入当前页、PDF 选区、公式或图片。
8. 在 composer 中提问，后端会带上当前 PDF context、选中文字、页码位置、上下文 chips、最近对话和图片附件。图片属于发出它的那条消息：发送后从输入框移到用户气泡里（也可以只发图片不写字），随对话一起存入 IndexedDB；同一段对话里更早发过的图片仍随后续请求带上（最多 8 张，超出时丢最早的），追问时模型还能看到。
9. 在 Agent 面板底部的 Challenge 条里选择题型和题数，点「生成挑战」：选择题会以居中浮层（约 75% 视口、毛玻璃背景）打开，一次一题，答错先给诊断和提示、允许再答一次，锁定后展示为什么对、可迁移的原则和「考试怎么考」；做完给出首答正确率、按考点的强弱和错题重做队列，错题会记入本文档的薄弱点，下次出题优先针对。
10. 在 PDF 上拖选文字后，浮动工具条最前面是「高亮」和「写笔记」；每一页下方还有「添加本页笔记」。详见下面的「PDF 高亮与笔记」。

### 助手对话

- **一份文档多段对话**：助手面板左上角是当前对话的标题（取自第一个问题，问的是选中内容时带上选中的文字），点它或右侧的时钟图标打开「历史对话」：按今天 / 昨天 / 近 7 天 / 更早分组，可搜索（标题和对话里说过的话都搜）、重命名、删除。铅笔图标开始新对话；旧对话留在历史里，空对话下面还会列出最近 3 段。没写过字的对话不进历史，连点「新对话」也不会堆出空记录。历史只列当前文档的对话，切换文档时回到那份文档最近的一段。
- **问题记得自己是在哪一页问的**：每条用户消息上有 `p.N` 标签，点它回到那一页；输入框左下角的标签是下一个问题会带上的页，翻页时跟着变。发给模型的历史对话里每个用户回合都标了页码和当时选中的文字，所以翻页之后的追问（「那为什么…」）仍接着上一个话题，新话题则从当前页讲起。
- **改问题、重新生成**：用户消息悬停出现铅笔，点开直接改，回车重新发送，这条之后的内容被新回答替换；「重新生成」同理，只保留新回答。存下来的对话永远和屏幕上一致。问题如果是针对选中内容问的，重新生成和编辑后仍然针对同一段选中内容。
- **真正的流式输出**：回答是模型边写边显示的，不是整段取回后再模拟打字。前端请求 `POST /api/agent/chat` 时带 `stream: true`，后端以 Server-Sent Events 逐块转发：`start`（模型开始响应）→ `thinking`（推理模型还在思考）→ 若干 `delta`（`text` 是下一小段回答）→ `done`（与非流式接口相同的完整对象，回答被截断时带 `truncated: true`）或 `error`。模型发回第一个字节之前不写响应头，所以没登录、key 错、429 这类一开始就失败的请求仍然是带 HTTP 状态码的普通 JSON 错误。各家协议都解了增量：Responses API、Chat Completions（DeepSeek 等，`stream_options.include_usage` 被拒时自动去掉重发）、Anthropic Messages、Gemini `streamGenerateContent?alt=sse`、Ollama 按行 JSON（`src/pdf_agent/server/stream_text.py`）。已经有文字发给用户之后不再自动重试；回答中途上游出错时保留已写的部分并在后面说明；达到输出上限被截断时在末尾注明。不带 `stream` 的请求行为不变。
- **停止与后台作答**：作答时发送键变成停止键，停止后保留已经显示的部分，浏览器断开连接后后端立刻停止上游请求（静默期每 2 秒发一次心跳来发现断开），不再为没人看的回答付费。作答途中切到别的对话、开新对话或隐藏助手面板不会打断请求：答案回来后存进它所属的对话，不会出现在别的对话里。
- **回答要答到点子上**：后端 prompt（`AGENT_INSTRUCTIONS`）要求第一句就回答问题，不复述问题、不先总结页面、不加结尾客套；长度跟着问题走；前提错了先纠正；课件没讲的内容用模型自己的知识回答并说明课件没讲；已有讲解视为学生读过的内容，不重复。prompt 的顺序是「页面 / 选中内容 → 之前的对话 → 现在要回答的问题」，问题放在最后且只出现一次；历史对话最多 12 条（最近 4 条保留全文，更早的截短），失败的回答不进历史，测验 JSON 压成一行说明。回答模式（简洁 / 引导 / 详细）只决定讲多深，不再规定固定的分节模板。

### PDF 高亮与笔记

- **高亮**：选中 PDF 文字后点「高亮」，会以马克笔样式画在文字上（黄 / 绿 / 蓝 / 粉四色，记住上次用的颜色）。高亮位置按页面比例保存，缩放窗口也不会错位。
- **笔记**：「写笔记」= 高亮 + 立刻打开一张笔记卡；「添加本页笔记」用于不针对某段文字的整页笔记。笔记卡直接展开在对应页面的正下方，像在讲义页边写字一样：不折叠、随时可编辑、边写边保存（600 ms 防抖），`Esc` 或 `⌘/Ctrl+Enter` 结束编辑，删除需要点两次确认。
- **导航**：点页面上的高亮会定位并聚焦对应笔记；讲解区的「笔记」标签页按页列出本文档全部高亮与笔记，点任一条跳回原页，右上角可导出为 Markdown。
- **保存**：笔记存在 IndexedDB 的 `annotations` 表（schema v4），随文档删除而删除，随工作区一起导出 / 导入。
- **喂给助手**：提问和出题时会自动附上你在这份 PDF 上写的笔记（当前页前后两页的优先，最多 12 条，长 PDF 截断时减半；只划线没写字的高亮只带当前页附近的）。助手被要求先对照原文指出笔记里写错、说反或漏条件的地方，再接着你的理解往下讲；出题时把写错的地方做成干扰项、把只划线的地方优先出题。每张笔记卡和「笔记」标签页的每一行都有「让 AI 检查」，会发送一条固定结构的检查请求（判定 → 对照 → 改写 → 一问）。设置 → 助手 里的「把我的笔记发给助手」可以关闭整个通道。出题时只参考当前页前后两页的笔记（远处的笔记不会把题目带偏）；「让 AI 检查」在助手还在作答时会排队等它答完再发，不会打断正在生成的回答。

### 讲解的结构

讲解不再按固定板块填表，而是先备课、再按段落讲：

1. **备课**：第一次点「生成」（或选「整份 PDF」重新生成）时，先把全文每页最多 400 字送给"质量档"模型通读一遍（`POST /api/generate/plan`，超过 100 页分段读、摘要接力），得到备课计划：整份文档在讲什么、分成哪几段（按内容的自然边界，一段通常 2 到 8 页）、每页的角色（封面 / 目录 / 过渡 / 概念 / 推导 / 例子 / 习题 / 回顾 / 总结 / 空白）、深度（略 / 简 / 详）、是否是全文最值得花时间的 2 到 4 个重点页，以及给讲课者的一句备注。计划存在 pack 的 `document.lesson_plan`（`synchropage.lesson-plan.v1`）里，随文档持久化，导出 / 导入的 JSON 也带着它；单页重新生成沿用旧计划，备课失败时按每页自行判断详略继续。
2. **按段落讲**：一个段落里的页在同一次调用里按顺序写完，段与段并行，先讲当前页所在的段；每页都写一句 `handoff`（讲完这页学生手里有了什么），下一页 / 下一段的请求带着它接着讲。讲解是连贯的散文，助教口吻，第二人称；深度按计划：略讲一句话（40 字以内），简讲一小段（80 到 200 字），详讲 300 到 800 字，重点页可到 1200 字。
3. **教具**：老师手里只有五件，只在讲到那里自然需要时用，每页最多两件，略讲页不用：`> **记住：**`（荧光笔划出的一句）、`> **例子：**`、`> **别踩坑：**`、`> **考法：**`（题型 + 一句示例题干）、`> **自测：**`（答案写在同一引用块的下一行，以「答案：」开头，界面默认折叠）。英文版标签是 Remember / Example / Watch out / On the exam / Check yourself / Answer。符号、公式、图都融进正文讲。

页面 JSON 里仍然有 `stuck_points` 和 `exam_angles` 两个数组，只给测验出题当干扰项素材，不再展示在讲解里。质量门槛按深度放宽：略讲页只要非空，简讲页 30 字以下才重试，详讲页沿用原来的 90 / 180 字阈值。讲解语言跟随界面语言（设置里也可以单独指定），换语言会重新备课。

界面上：讲解顶部显示页码 · 角色 · 深度，重点页带 ★（PDF 页标签也带 ★）；「地图」标签页把整份备课计划摊开成课程地图（`apps/web/src/components/workspace/LessonMapPanel.tsx`）：文档摘要、重点页一排、每段的标题 / 页码范围 / 目标，段里每页一行——页码、一到三格的详略条、角色、★、备课备注和已讲解 / 生成中 / 失败的状态点，当前页高亮，点一行跳到 PDF 对应页；略讲的承接页有「这一段从 p.N 讲起」的链接；五件教具渲染成各自颜色的引用块（`apps/web/src/components/workspace/WorkspaceChrome.tsx` 的 `NoteDeviceQuote`）。旧版带 `## ` 小标题的讲解仍按小节渲染（`apps/web/src/lib/notes/noteSections.ts`）。
Prompt 定义在 `src/pdf_agent/server/constants.py`（`TEACHING_PLANNER_INSTRUCTIONS`、`TEACHING_GENERATOR_INSTRUCTIONS`、`TEACHING_DEVICE_LABELS`）与 `payload_builders.py`，中文版契约见 [config/prompts/course_agent.prompt.yaml](config/prompts/course_agent.prompt.yaml)。模型在中文里用英文直引号把 JSON 截断时，服务端会把不挨着 JSON 结构的直引号转成弯引号再解析（`markdown_math.repair_json_prose_quotes`）。

### 文字层不可读的页（公式是嵌入字体）

有些课件（比如 EECS 445 的 Lecture 4）把公式画成嵌入字体、没有可用的 ToUnicode 映射，PDF.js 抽出来的文字里公式变成一串 `! = 0 , ̅ & (") = ' 0` 这样的乱码，而正文还在，所以"没有文字层"的判断不会触发，只走文字的讲解会对着噪声胡讲。现在的处理：

1. **识别**：每页抽完文字后用 `apps/web/src/lib/pdf/textQuality.ts` 打分：没有字母、只由孤零零的引号 / 美元号 / 感叹号 / 组合字符 / 私用区字符 / `(cid:N)` 组成的 token 算噪声，噪声占比过线就把 `source.text_garbled` 记为 true（Lecture 4 的 28 页标出 10 页，普通课件、论文和代码页不会误报；纯函数，Playwright `e2e/textQuality.spec.ts` 有样例）。
2. **路径**（`unreadableTextRoute`，按当前模型配置自动选，优先级从高到低）：
   - **质量档模型自己能看页面**：provider 能读 PDF 文件（OpenAI Responses、ChatGPT Codex，或 `apiFeatures.pdfInputFile: true` 的网关，比如 coproxy）就附 PDF 子集；模型能读图片但读不了 PDF（`deepseek-flash`，以及 gpt-4o / gemini / claude / qwen-vl 一类，见 `providerModelReadsImages`，也可用 `apiFeatures.imageInput` / `visionModels` / `models[<id>].imageInput` 指定）就把这页在浏览器里用 PDF.js 渲染成约 1100 px 宽的 PNG（`lib/pdf/pageImages.ts`）随请求附上。两种情况讲课请求都带 `garbled-source-text` / `garbled-source-text-image`、单页发送，备课请求也把这些页作为 PDF 子集或 `pageImages` 附上（`attachPages`，每个分段最多 40 页），模型直接看页面。
   - **专用 OCR 模型**：配置了 `defaults.ocr`（比如 SiliconFlow 上的 `deepseek-ai/DeepSeek-OCR`）时，每页图片单独调用一次 `POST /api/generate/transcribe`（`mode: "ocr"`），发送的就是 deepseek-ocr SDK 那一套（一张图 + `Free OCR.` 提示词，`ocrMode: "grounding"` 时用 `<|grounding|>Convert the document to markdown.`），返回的 Markdown 去掉定位标记后替换掉乱码文字（`source.parser = "deepseek-ocr"`）。这里不依赖 SDK 本身：SDK 的价值是用 PyMuPDF 渲染 PDF，而页面已经在浏览器里渲染好了，打包进桌面版也不用多带一个 PyMuPDF。注意 DeepSeek 官方 API 不提供 OCR 模型，需要 SiliconFlow / PPIO 之类的端点。
   - **通用模型转写**：`defaults.transcription` 指定的模型，或第一个启用且能读图片的模型（其次是能读 PDF 的），一次最多 8 页（前端 4 页一组），把页面**转写**成带 LaTeX 的 Markdown 替换掉乱码文字（`source.parser = "model-transcription"`、`ocr_used = true`）；对 DeepSeek flash 这一步关掉 thinking（`reasoningEffort: "none"` → `thinking: disabled`），一页两三秒、几百个 token。转写后的页随文档持久化，重新打开也不会被 PDF.js 的乱码盖掉。
   - **什么都读不了**：状态栏提示有几页读不了，prompt 里明确告诉模型这页的文字是噪声，只按标题、备课备注和前后页来讲，说清楚哪条公式看不到，并标为待复核（`needs_review`）。
3. **界面**：讲解头部和课程地图里，转写过的页带绿色的「页面转写」标签，仍不可读的页带琥珀色的「文字层不可读」标签。

实测（2026-09-15，对 api.deepseek.com）：`deepseek-flash` 能读 `image_url` 传的 PNG，`deepseek-v4-pro` 会静默丢掉图片；两者都不接受 PDF 文件（OpenAI 风格的 `file` 部件返回 400，Anthropic 兼容接口的 `document` 块被忽略）。后端的 Chat Completions 适配器只对能读图片的模型发内容数组（`input_image` → `image_url`），其他模型仍然是纯文字加一行占位说明；Anthropic 适配器同理（`image` 块）。Prompt 在 `constants.py` 的 `TEACHING_TRANSCRIBER_INSTRUCTIONS`，`payload_builders._source_text_layer_lines` 负责讲课 / 备课 prompt 里的 `text_layer:` 说明。

在 `~/.pdf_agent/model_providers.json` 里指定 OCR 或转写模型的写法：

```json
"defaults": {
  "teachingQuality": { "providerId": "deepseek", "model": "deepseek-flash" },
  "ocr": { "providerId": "silicon", "model": "deepseek-ai/DeepSeek-OCR" },
  "transcription": { "providerId": "deepseek", "model": "deepseek-flash" }
}
```

### 公式的写法与渲染

讲解、转写和助手回复里的数学都是 LaTeX，前端用 KaTeX 排版（`apps/web/src/lib/markdown/mathMarkdown.ts`）。公式的边界由 Markdown 的 tokenizer 决定，而不是渲染前的字符串修补：`micromark-extension-math-extended` 认 `$$` 围栏、行内 `$$…$$` 和 `\(…\)`，仓库里的 `llmMathText.ts` 补上带 Pandoc 货币规则的单美元 `$…$`（`$5 and $10` 不是公式；`$5, and $x$` 里只有 x 是公式）和写在句子中间的 `\[…\]`。tokenizer 认出来的区间原样交给 KaTeX，认不出来的就是正文，所以一个多余的 `$` 只会多显示一个字符，不会把后面整段变成斜体。独占一段的 `$$…$$` 或 `\[…\]` 提升为独立公式（紧跟的句号进公式里）；标题、标签这类行内位置里的独立公式降为行内。唯一的字符串级处理是表格行里公式内的 `|`（GFM 先按 `|` 切单元格再解析行内内容），会换成 `\lvert{}` / `\rvert{}`。KaTeX 解析不了的公式以源码显示并带 `.katex-error`，页面其余部分不受影响。

后端只修 JSON 转义留下的痕迹（`src/pdf_agent/server/markdown_math.py`）：模型漏写的 `\\`（`\frac` → `\\frac`）、写了两遍的换行（字面的 `\n` 后面不是英文字母时变成换行）和数字前的反斜杠（`\2^n` → `2^n`）；分隔符和公式本身按模型写的原样存储。提示词里要求模型：行内 `$…$`，独立公式单独一行 `$$`、公式、再一行 `$$`，不用 `\( \)`、`\[ \]`，标点和中文写在 `$` 外，金额写 `\$5`，表格里的绝对值写 `\lvert x \rvert`。

回归测试：`apps/web/e2e/markdownMath.spec.ts` 用应用同一条 remark / rehype 管线在 Node 里渲染一组真实写法（曾经渲染坏的三种输入、两种分隔符方言、货币、中文标点、表格、未闭合的分隔符），断言每条公式原样到达 KaTeX、正文一个字不少；`tests/test_markdown_math.py` 覆盖 JSON 修复。

### 字体

软件里所有英文（界面、讲解、助手回复、设置）都使用 Anthropic Sans，中文仍走 PingFang / Noto Sans SC；代码和路径保持等宽字体，公式由 KaTeX 自带字体排版。字体文件不在仓库里（它是 Anthropic 的专有字体，`apps/web/public/fonts/` 已加入 .gitignore）：装了 Claude 桌面版的机器上运行一次 `./scripts/install-local-fonts.sh`，脚本会把字体从 Claude.app 复制到该目录；没有这些文件时自动回退到系统字体，不影响使用。

### 长 PDF 一键生成的稳定性

- 后端对 Responses 类 provider 走流式读取：空闲 120 秒才算超时，整体截止时间按 `reasoning.effort` 计算（low 180 s … xhigh/max 600 s），并按 effort 设置 `max_output_tokens`。
- 相同页的并发请求会合并成一次上游调用；排队超过 30 秒返回 `queue_timeout`；429 的 `Retry-After` 会被全局遵守；返回的 JSON 不合法时按低一档 effort 修复重试一次；批量结果部分成功时返回 `missing` 页码。
- 前端按失败原因决定重试计划：超时 / 网络错误不会升级成附 PDF 的重型请求，限流走共享冷却门，只有模型明确标记内容过弱才升级一次；并发窗口按 AIMD 自适应；「停止」会把进行中的页恢复为草稿而不是失败。
- 数值策略集中在 `src/pdf_agent/server/generation_policy.py`，说明见 [docs/workflows/coproxy-gateway-setup.md](docs/workflows/coproxy-gateway-setup.md)。

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

前端使用 Dexie + IndexedDB 作为 local-first persistence layer（schema v4 起包含 `annotations` 表，保存 PDF 高亮与笔记）。不要把 PDF、聊天或生成内容存进 `localStorage`；`localStorage` 只保存很小的 fallback，例如 `lastWorkspaceId` 和 UI preference fallback。

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
chatThreads       Agent 对话线程：标题（自动 / 用户改名）、消息数、预览、问过的页码
chatMessages      user/assistant/system 消息、提问时所在页、图片、selectedContext、sourceRefs、streaming status
selectedContexts  composer 中尚未发送的 PDF/讲解/助手选区
settings          theme、语言、debug、PDF context 截断策略等 UI 设置
```

自动保存触发点：

- PDF 上传成功后保存 Blob + Document + Workspace。
- PDF 页码切换、讲解页变化、Settings/layout 变化会 debounce 保存。
- Agent 消息发送前先保存 user message；assistant 消息从 pending、streaming 到 completed/failed/stopped 都会持续保存。编辑问题或重新生成后，被替换的消息同时从存储里删掉。
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
POST   /api/agent/chat          带 stream: true 时以 text/event-stream 返回 start / thinking / delta / done / error
POST   /api/generate/page
POST   /api/generate/pages      部分成功时返回 pages + missing
POST   /api/generate/plan       备课：整份文档的段落 / 每页角色与详略 / 重点页（>100 页分段读；文字层不可读的页可随 documentFile + attachPages 附上 PDF 子集）
POST   /api/generate/transcribe 把文字层不可读的页转写成带 LaTeX 的 Markdown（≤8 页/次，带 pageImages 或 documentFile；mode: "ocr" 时逐页调用专用 OCR 模型）
GET    /api/generate/status     活跃 / 排队 / 冷却 / 截止时间
GET    /api/model-config
POST   /api/model-config
POST   /api/model-config/models
POST   /api/model-config/preview
POST   /api/model-config/check
GET    /api/model-catalog
GET    /api/model-catalog/models
POST   /api/pdf/cache
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

端到端测试（Playwright，会自动起 Vite；如果 5173 被别的检出占用，用 `PLAYWRIGHT_PORT` 指定端口）：

```bash
npm --prefix apps/web run test:e2e
PLAYWRIGHT_PORT=5175 npm --prefix apps/web run test:e2e
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
