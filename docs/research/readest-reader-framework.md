# Readest Reader Framework Notes

调研来源：`/Users/harry/reference-repo/readest`，由 subagent 只读检查，并由主线程抽查关键 reader/store 文件。

## 可迁移模式

- Reader shell 分层：`Reader -> ReaderContent -> BooksGrid -> HeaderBar/FoliateViewer/ProgressBar/FooterBar/SideBar`。
- 状态按职责拆分：`readerStore` 管低频 view state，`readerProgressStore` 管高频翻页进度，`sidebarStore` 管侧栏，`themeStore` 管主题与 localStorage。
- 设置三层模型：类型、默认值、读写 helper。旧设置加载时用默认值合并，新增字段不需要重迁移。
- 桌面和移动分离：桌面侧栏可 pin/resize，移动端侧栏变 sheet，底部工具栏承担导航与设置入口。
- 进度是 reader 的一等能力：显示当前页/总页/百分比，并支持 range 跳页。
- 主题通过 `data-theme` 和 CSS variables 驱动，而不是散落在组件样式里。

## 不迁移内容

- Next.js/Tauri/OpenNext/Cloudflare 多端外壳。
- `foliate-js` 完整 ebook 引擎和 CFI/annotation 体系。
- Supabase、S3、sync、KOSync、WebDAV、TTS、AI notebook、书库多书视图。
- 复杂 e-ink、竖排、CJK transform 和自定义字体/纹理系统。

## 已应用到 PagePair Reader

- `apps/web/index.html` 作为 Vite/React mount point。
- `apps/web/src/App.tsx` 实现 reader progress、页级 rail、PDF/页面预览、讲解/结构/JSON tabs，以及 `@assistant-ui/react` Agent Panel。
- `apps/web/src/styles.css` 使用 CSS variables、响应式 grid、IDE 风格面板、上下文 chips、composer 和移动端单列布局。
- `src/pdf_agent/server/web_app.py` 提供构建产物、OAuth 路由和 Agent chat API，避免前端直接持有模型凭据。

后续如果要把 PDF 渲染升级到生产级，建议单独接 `pdf.js` 当前页 canvas/text layer，不引入 readest 的完整 ebook engine。
