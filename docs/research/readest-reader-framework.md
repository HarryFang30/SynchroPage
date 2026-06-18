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

- `apps/web/index.html` 新增 reader progress、settings popover、mobile reader bar。
- `apps/web/app.js` 新增轻量 preferences、localStorage、进度跳页、侧栏收起、布局/主题/密度/字号控制。
- `apps/web/styles.css` 新增 `data-theme`、`data-layout`、`data-density` 驱动的 reader shell 样式和移动端抽屉。

后续如果要把 PDF 渲染升级到生产级，建议单独接 `pdf.js` 当前页 canvas/text layer，不引入 readest 的完整 ebook engine。
