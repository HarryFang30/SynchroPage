# Codex Prompt: PagePair Reader Claude-like UI/UX 重构任务

> 目标：把 PagePair Reader 从当前“粗糙暗黑 PDF 工具 / demo UI”重构成具有 Claude 暗色首页质感的高级 AI 学习型 PDF Reader。请借鉴 Claude 的审美特征：温暖深色背景、克制留白、柔和边框、低饱和暖色 accent、优雅排版、安静侧边栏、轻量按钮、成熟 AI 输入框质感。不要照搬 Claude 的品牌、logo、具体文案或专有 UI，只迁移视觉原则和产品气质。

---

## 0. 你的角色

你是一个资深前端工程师 + UI 系统重构专家。你需要在现有 React / Tailwind / shadcn 风格项目中完成视觉系统重构。你必须优先保证现有功能不被破坏，其次通过 design tokens、组件 variants、布局尺寸、状态样式和暗色主题细节，把 PagePair Reader 的整体质感提升到成熟 productivity app 水平。

请先阅读现有代码结构，再分阶段小步提交修改。不要一次性大面积重写业务逻辑。

---

## 1. 产品背景

PagePair Reader 是一个用于阅读 PDF 并生成结构化讲解 / AI 助手问答的学习型 PDF Reader。核心场景：

1. 左侧管理课程和文档；
2. 中间阅读 PDF；
3. 右侧显示结构化讲解或 AI 助手聊天；
4. 用户希望边看 PDF 边获得 AI 解释、总结、问答。

当前 UI 的主要问题：

- 暗色背景偏脏、偏闷、缺少层级；
- 橙色主色过亮、过重，显得廉价；
- 顶部 toolbar 控件太多、太重；
- 左侧 sidebar 像后台管理目录树；
- 中间 PDF 阅读区不够沉浸；
- 右侧 AI 面板像临时拼出来的工具栏，而不是优雅的学习侧栏；
- 设置 modal 太大、太空、层级松散；
- loading / error / empty 状态粗糙；
- 组件尺寸、圆角、hover、active、focus 状态不统一。

---

## 2. 最终视觉方向

视觉方向名称：**Claude-like Warm Graphite Academic**

关键词：

- Warm graphite / 温暖石墨；
- Academic reader / 学术阅读；
- Calm AI assistant / 克制 AI 助手；
- Long-session friendly / 长时间阅读护眼；
- Quiet productivity app / 安静生产力工具；
- Soft hierarchy / 柔和信息层级；
- Low-saturation accent / 低饱和暖色点缀。

核心原则：

1. **PDF 是主角，AI 是安静的辅助层。**
2. **橙色只做温度，不做大面积主题皮肤。**
3. **暗色不是纯黑，而是有纪律的 surface 分层。**
4. **Claude-like 的美感来自留白、暖灰、低对比边框、柔和输入框和克制动效。**
5. **所有组件要统一高度、圆角、边框、hover、active、focus ring。**
6. **右侧讲解内容要像 mini lecture note，不要像原始 Markdown dump。**

---

## 3. 不要改动的功能逻辑

本次任务是 UI/UX 重构，不允许改变以下业务逻辑：

1. PDF 加载、渲染、滚动、分页逻辑；
2. 当前页码状态和页码同步逻辑；
3. 课程 / 文档数据结构；
4. 课程选择、文档选择、最近文档逻辑；
5. AI 生成 API 调用逻辑；
6. 结构化讲解数据生成、展示、缓存逻辑；
7. 聊天发送、重试、清空、图片上传逻辑；
8. 设置保存、本地持久化逻辑；
9. 路由逻辑；
10. 后端接口字段、请求参数、返回数据模型；
11. 现有 keyboard shortcuts，除非只是补充 tooltip 或视觉提示。

允许修改：

- className / Tailwind 样式；
- CSS variables；
- Tailwind theme extension；
- 通用 UI 组件封装；
- 组件结构中的 purely presentational wrapper；
- loading / error / empty 的视觉表达；
- 布局容器尺寸、padding、gap、border、radius、shadow；
- icon button / segmented control / input / modal 的视觉实现。

---

## 4. Claude-like 视觉特征要点

请把 Claude 暗色首页的这些特征转译到 PagePair Reader：

### 4.1 背景

Claude 的暗色不是纯黑，而是温暖的深灰褐色。PagePair 应使用近似 warm graphite 的底色：

- app 背景接近 `#1C1B19` 的温暖深灰；
- sidebar 与 main 背景不要强烈割裂；
- panel 边界用非常轻的 border，而不是重黑线；
- 避免 `#000000`、`#111111` 大面积硬黑。

### 4.2 侧边栏

Claude sidebar 的气质：

- 左侧导航安静，文字不抢；
- section title 很弱；
- active / hover 很克制；
- 底部账户区像稳定 dock，不像后台系统；
- icon 使用细线风格，颜色为 muted warm gray。

PagePair 左侧要像 workspace，而不是 admin tree。

### 4.3 主内容区

Claude 首页主区的美感来自大量 breathing room。PagePair 虽然是 PDF Reader，但仍应做到：

- PDF stage 有明确居中感；
- 工具栏降低存在感；
- 页码导航轻量；
- PDF 页面像放在安静阅读台上的纸张。

### 4.4 AI 输入框 / Composer

Claude 输入框特点：

- 大圆角；
- 暖灰背景；
- 柔和边框；
- 内部按钮轻量；
- focus 不刺眼；
- 没有强烈霓虹或厚重阴影。

PagePair 的聊天输入框和生成区要接近这种质感。

### 4.5 Typography

Claude 的文字层级偏优雅：

- 标题可以更有气质，但 PagePair 不需要大 serif；
- 正文使用温暖灰，不用纯白；
- metadata 更弱；
- 右侧 AI 讲解需要高行高，适合长时间阅读。

---

## 5. Design Tokens

### 5.1 CSS Variables

在 `src/styles/tokens.css` 或 `src/styles/globals.css` 中添加以下 tokens。若项目没有独立 tokens 文件，请新增，并在全局样式入口引入。

```css
:root {
  color-scheme: dark;

  /* Backgrounds: Claude-like warm graphite */
  --pp-bg-app: #1B1A18;
  --pp-bg-rail: #1C1B19;
  --pp-bg-sidebar: #1A1917;
  --pp-bg-main: #1C1B19;
  --pp-bg-panel: #20201D;
  --pp-bg-panel-2: #252421;
  --pp-bg-elevated: #2B2A26;
  --pp-bg-hover: #2F2E2A;
  --pp-bg-selected: #33312C;
  --pp-bg-input: #2A2926;
  --pp-bg-input-hover: #302F2B;
  --pp-bg-pdf-stage: #181715;
  --pp-bg-pdf-page: #F8F6EF;

  /* Text */
  --pp-text-primary: #ECE8DF;
  --pp-text-secondary: #C9C3B8;
  --pp-text-muted: #9C958A;
  --pp-text-faint: #746E65;
  --pp-text-disabled: #585249;
  --pp-text-inverse: #17130E;

  /* Accent: Claude-like warm clay / copper, lower saturation than current orange */
  --pp-accent: #D97852;
  --pp-accent-hover: #E0835E;
  --pp-accent-active: #C96945;
  --pp-accent-soft: rgba(217, 120, 82, 0.13);
  --pp-accent-border: rgba(217, 120, 82, 0.28);
  --pp-accent-text: #F0B195;
  --pp-on-accent: #1B100A;

  /* Semantic status */
  --pp-success: #8EBB74;
  --pp-warning: #D4A95F;
  --pp-danger: #D47766;
  --pp-danger-soft: rgba(212, 119, 102, 0.10);
  --pp-danger-border: rgba(212, 119, 102, 0.26);

  /* Borders */
  --pp-border-subtle: rgba(255, 255, 255, 0.055);
  --pp-border: rgba(255, 255, 255, 0.085);
  --pp-border-strong: rgba(255, 255, 255, 0.14);

  /* Focus and shadows */
  --pp-ring: 0 0 0 3px rgba(217, 120, 82, 0.20);
  --pp-shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.20);
  --pp-shadow-sm: 0 8px 24px rgba(0, 0, 0, 0.22);
  --pp-shadow-md: 0 18px 48px rgba(0, 0, 0, 0.34);
  --pp-shadow-pdf: 0 1px 0 rgba(255,255,255,0.05), 0 20px 52px rgba(0,0,0,0.38);
  --pp-shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.055);

  /* Radius */
  --radius-xs: 6px;
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;
  --radius-composer: 24px;

  /* Layout */
  --topbar-height: 56px;
  --reader-header-height: 48px;
  --sidebar-width: 280px;
  --right-panel-width: 420px;

  /* Controls */
  --button-compact-height: 30px;
  --button-height: 36px;
  --button-large-height: 40px;
  --icon-button-size: 32px;
  --input-height: 36px;
  --chat-composer-min-height: 104px;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background: var(--pp-bg-app);
  color: var(--pp-text-secondary);
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "SF Pro Text",
    "PingFang SC",
    "Noto Sans CJK SC",
    "Microsoft YaHei",
    sans-serif;
  font-size: 14px;
  line-height: 1.5;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

* {
  scrollbar-color: rgba(255,255,255,0.18) transparent;
}

::selection {
  background: rgba(217, 120, 82, 0.28);
  color: var(--pp-text-primary);
}
```

### 5.2 Tailwind Theme Extension

在 `tailwind.config.ts` 中添加：

```ts
export default {
  theme: {
    extend: {
      colors: {
        pp: {
          bg: {
            app: "var(--pp-bg-app)",
            rail: "var(--pp-bg-rail)",
            sidebar: "var(--pp-bg-sidebar)",
            main: "var(--pp-bg-main)",
            panel: "var(--pp-bg-panel)",
            panel2: "var(--pp-bg-panel-2)",
            elevated: "var(--pp-bg-elevated)",
            hover: "var(--pp-bg-hover)",
            selected: "var(--pp-bg-selected)",
            input: "var(--pp-bg-input)",
            inputHover: "var(--pp-bg-input-hover)",
            pdfStage: "var(--pp-bg-pdf-stage)",
            pdfPage: "var(--pp-bg-pdf-page)",
          },
          text: {
            primary: "var(--pp-text-primary)",
            secondary: "var(--pp-text-secondary)",
            muted: "var(--pp-text-muted)",
            faint: "var(--pp-text-faint)",
            disabled: "var(--pp-text-disabled)",
            inverse: "var(--pp-text-inverse)",
          },
          accent: {
            DEFAULT: "var(--pp-accent)",
            hover: "var(--pp-accent-hover)",
            active: "var(--pp-accent-active)",
            soft: "var(--pp-accent-soft)",
            border: "var(--pp-accent-border)",
            text: "var(--pp-accent-text)",
            foreground: "var(--pp-on-accent)",
          },
          border: {
            subtle: "var(--pp-border-subtle)",
            DEFAULT: "var(--pp-border)",
            strong: "var(--pp-border-strong)",
          },
          danger: {
            DEFAULT: "var(--pp-danger)",
            soft: "var(--pp-danger-soft)",
            border: "var(--pp-danger-border)",
          },
        },
      },
      borderRadius: {
        ppXs: "var(--radius-xs)",
        ppSm: "var(--radius-sm)",
        ppMd: "var(--radius-md)",
        ppLg: "var(--radius-lg)",
        ppXl: "var(--radius-xl)",
        pp2xl: "var(--radius-2xl)",
        ppComposer: "var(--radius-composer)",
      },
      boxShadow: {
        ppXs: "var(--pp-shadow-xs)",
        ppSm: "var(--pp-shadow-sm)",
        ppMd: "var(--pp-shadow-md)",
        ppPdf: "var(--pp-shadow-pdf)",
        ppInset: "var(--pp-shadow-inset)",
      },
      fontSize: {
        "pp-meta": ["11px", { lineHeight: "14px", fontWeight: "500" }],
        "pp-caption": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "pp-control": ["13px", { lineHeight: "18px", fontWeight: "500" }],
        "pp-body": ["14px", { lineHeight: "23px", fontWeight: "400" }],
        "pp-section": ["15px", { lineHeight: "22px", fontWeight: "650" }],
        "pp-title": ["20px", { lineHeight: "28px", fontWeight: "650" }],
        "pp-hero": ["36px", { lineHeight: "44px", fontWeight: "500" }],
      },
    },
  },
};
```

---

## 6. Layout 目标

### 6.1 AppShell

目标结构：

```text
Viewport
┌──────────────────────────────────────────────────────────────┐
│ Topbar 56px                                                  │
├──────────────┬───────────────────────────────┬───────────────┤
│ Sidebar      │ Reader                         │ AI Panel      │
│ 280px        │ flex: 1                         │ 420px         │
│ min 248      │ min 560                         │ min 360       │
│ max 320      │                                 │ max 520       │
└──────────────┴───────────────────────────────┴───────────────┘
```

推荐 CSS：

```css
.app-shell {
  height: 100vh;
  display: grid;
  grid-template-rows: var(--topbar-height) minmax(0, 1fr);
  background: var(--pp-bg-app);
}

.app-body {
  min-height: 0;
  display: grid;
  grid-template-columns: 280px minmax(560px, 1fr) 420px;
}
```

如果已有 resize 逻辑：

```ts
const SIDEBAR = { default: 280, min: 248, max: 320 };
const AI_PANEL = { default: 420, min: 360, max: 520 };
```

验收标准：

- 顶栏固定 56px；
- 左栏默认 280px；
- 右栏默认 420px；
- 中间 PDF 阅读区是视觉主角；
- 三栏边界只用 subtle border；
- 不出现横向滚动；
- 1280px / 1440px / 1728px 宽度下布局稳定。

---

## 7. P0 任务：建立 tokens + 清理硬编码颜色

### 目标文件

```text
src/styles/globals.css
src/styles/tokens.css
tailwind.config.ts
```

### 任务

1. 添加第 5 节中的 CSS variables；
2. Tailwind 扩展 `pp` 颜色、圆角、阴影、字号；
3. 全局 body 使用 warm graphite 背景；
4. 搜索并替换主要页面里的硬编码颜色：
   - 避免大面积 `bg-black`；
   - 避免大面积 `bg-zinc-*`；
   - 避免大面积 `bg-orange-*`；
   - 避免正文 `text-white`；
5. 将主要背景切换为 `bg-pp-bg-*`；
6. 将主要文字切换为 `text-pp-text-*`；
7. 将边框切换为 `border-pp-border-subtle` 或 `border-pp-border`。

### 验收标准

- 页面主要颜色来自 `pp` tokens；
- 橙色只用于 CTA、active indicator、focus、关键点缀；
- 暗色背景至少有 4 个清晰层级；
- 正文不是纯白，而是 warm gray；
- 页面整体接近 Claude dark 的温暖、低噪音观感。

### 视觉检查点

第一眼看起来不再是“黑橙后台 demo”，而是 warm graphite productivity app。

---

## 8. P0 任务：统一基础 UI 组件

### 目标文件

根据项目实际路径修改。推荐目标：

```text
src/components/ui/Button.tsx
src/components/ui/IconButton.tsx
src/components/ui/SegmentedControl.tsx
src/components/ui/Input.tsx
src/components/ui/Textarea.tsx
src/components/ui/Tooltip.tsx
src/components/ui/Skeleton.tsx
```

### 8.1 Button

支持：

```ts
type ButtonVariant = "primary" | "subtle" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";
```

尺寸：

```text
sm: height 30px, px 10px, radius 10px
md: height 36px, px 14px, radius 12px
lg: height 40px, px 16px, radius 14px
```

Primary 样式：

```tsx
"bg-pp-accent text-pp-accent-foreground shadow-ppInset hover:bg-pp-accent-hover active:bg-pp-accent-active"
```

Subtle 样式：

```tsx
"bg-pp-bg-panel2 text-pp-text-secondary border border-pp-border-subtle hover:bg-pp-bg-hover hover:text-pp-text-primary"
```

Ghost 样式：

```tsx
"text-pp-text-muted hover:bg-pp-bg-hover hover:text-pp-text-primary"
```

Danger 样式：

```tsx
"text-pp-danger hover:bg-pp-danger-soft border border-transparent hover:border-pp-danger-border"
```

Focus：

```tsx
"focus-visible:outline-none focus-visible:[box-shadow:var(--pp-ring)]"
```

### 8.2 IconButton

支持：

```ts
type IconButtonVariant = "ghost" | "subtle" | "active" | "primary" | "danger";
type IconButtonSize = "sm" | "md";
```

尺寸：

```text
sm: 30px × 30px
md: 32px × 32px
icon: 16px
radius: 10px
```

默认：

```tsx
"inline-flex items-center justify-center rounded-ppMd text-pp-text-muted transition-colors duration-150"
```

Hover：

```tsx
"hover:bg-pp-bg-hover hover:text-pp-text-primary"
```

Active：

```tsx
"bg-pp-bg-selected text-pp-accent-text shadow-ppInset"
```

Danger hover：

```tsx
"hover:bg-pp-danger-soft hover:text-pp-danger"
```

验收标准：

- 顶栏 icon button 大小一致；
- 右侧删除、刷新、图片按钮大小一致；
- 所有 icon button 有 tooltip；
- 删除按钮默认不红，hover 才 danger；
- active 状态不使用大面积橙底。

### 8.3 SegmentedControl

样式：

```tsx
<div className="inline-flex h-8 rounded-ppLg border border-pp-border-subtle bg-pp-bg-panel2 p-0.5 shadow-ppInset">
  <button className="rounded-ppMd px-3 text-pp-control text-pp-text-muted data-[active=true]:bg-pp-bg-selected data-[active=true]:text-pp-text-primary">
    讲解
  </button>
  <button className="rounded-ppMd px-3 text-pp-control text-pp-text-muted data-[active=true]:bg-pp-bg-selected data-[active=true]:text-pp-text-primary">
    助手
  </button>
</div>
```

注意：把当前类似“讲 / 构 / J”的短标签改成可理解的 `讲解 / 助手`。不要让用户猜。

---

## 9. P1 任务：TopBar 重构

### 目标文件

```text
src/components/layout/TopBar.tsx
src/components/toolbar/PageNavigator.tsx
src/components/toolbar/ViewControls.tsx
src/components/toolbar/GenerateButton.tsx
```

根据项目实际结构映射。

### 目标布局

```text
[Logo + App Name + 当前文档名]      [上一页  3 / 303  下一页]      [视图控制组] [已保存] [生成]
```

### 样式参数

```text
Topbar height: 56px
Horizontal padding: 14px
Background: --pp-bg-rail
Bottom border: 1px solid --pp-border-subtle
Icon button: 32px
Page navigator height: 36px
Generate button height: 36px
Generate button radius: 12px
```

### 任务

1. 顶栏使用 `h-14 bg-pp-bg-rail border-b border-pp-border-subtle`；
2. 左侧 logo 保持，但降低块感；
3. 当前文档名使用 `text-pp-control text-pp-text-muted`；
4. 页码导航放中间，使用 unified pill；
5. 保存状态改成弱状态 chip，不要像主按钮；
6. 生成按钮是唯一强 CTA；
7. 低频操作放入更多菜单；
8. 视图控制按钮组统一 `IconButton`；
9. 不要使用一排重黑色按钮。

### 页码导航推荐实现

```tsx
<div className="inline-flex h-9 items-center rounded-ppLg border border-pp-border-subtle bg-pp-bg-panel2 p-0.5 shadow-ppInset">
  <IconButton size="sm" variant="ghost" aria-label="上一页">
    <ChevronLeft className="size-4" />
  </IconButton>
  <div className="min-w-[76px] text-center text-pp-control tabular-nums text-pp-text-muted">
    {currentPage} / {totalPages}
  </div>
  <IconButton size="sm" variant="ghost" aria-label="下一页">
    <ChevronRight className="size-4" />
  </IconButton>
</div>
```

### 生成按钮推荐实现

```tsx
<Button variant="primary" size="md" className="gap-2 font-semibold">
  <Zap className="size-4" />
  生成
</Button>
```

### 验收标准

- 顶栏只有“生成”一个强视觉元素；
- 页码导航居中且轻量；
- 保存状态弱化；
- 图标按钮大小统一；
- 顶栏整体像 Claude / Linear 风格：安静、克制、精确。

---

## 10. P1 任务：Sidebar 重构

### 目标文件

```text
src/components/sidebar/Sidebar.tsx
src/components/sidebar/SearchBox.tsx
src/components/sidebar/CourseList.tsx
src/components/sidebar/DocumentList.tsx
src/components/sidebar/RecentList.tsx
src/components/sidebar/SidebarItem.tsx
src/components/sidebar/SidebarFooter.tsx
```

### 样式参数

```text
Width: 280px
Min width: 248px
Max width: 320px
Background: --pp-bg-sidebar
Right border: 1px solid --pp-border-subtle
Padding: 12px
Search height: 36px
Section gap: 20px
Item height: 34px / 36px
Document item with metadata: 42px / 44px
Icon size: 16px
Item radius: 10px
```

### 任务

1. Sidebar 背景使用 `bg-pp-bg-sidebar`；
2. 右边框使用 `border-pp-border-subtle`；
3. 搜索框高度 `36px`，背景 `bg-pp-bg-input`；
4. section title 使用极弱 metadata：`text-pp-meta text-pp-text-faint`；
5. 课程 item 使用 `h-9 rounded-ppMd`；
6. 文档 item 可使用 `min-h-[42px]`，标题和 metadata 两行；
7. active item 使用 `bg-pp-bg-selected` + 左侧 `2px` accent bar；
8. 不要大面积橙色背景；
9. “最近”列表文字弱化，避免抢 PDF；
10. 底部设置 / 用户区固定在底部，像 Claude sidebar bottom dock。

### SidebarItem 推荐 class

```tsx
<div
  data-active={active}
  className="group relative flex h-9 items-center gap-2 rounded-ppMd px-2 text-pp-control text-pp-text-secondary transition-colors hover:bg-pp-bg-hover hover:text-pp-text-primary data-[active=true]:bg-pp-bg-selected data-[active=true]:text-pp-text-primary data-[active=true]:shadow-ppInset"
>
  {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-pp-accent" />}
  <Icon className="size-4 shrink-0 text-pp-text-muted group-hover:text-pp-text-secondary" />
  <span className="truncate">{label}</span>
  {meta && <span className="ml-auto text-pp-meta text-pp-text-faint">{meta}</span>}
</div>
```

### 验收标准

- 左侧像 Claude Projects / Notion workspace，不像后台目录树；
- active 清楚但不吵；
- metadata 更弱；
- 搜索框轻量；
- 整体不会和 PDF 抢视觉焦点。

---

## 11. P1 任务：ReaderPane / PDF 阅读区重构

### 目标文件

```text
src/components/reader/ReaderPane.tsx
src/components/reader/PdfStage.tsx
src/components/reader/PdfPage.tsx
src/components/reader/PageLabel.tsx
src/components/reader/PageNavigator.tsx
```

### 样式参数

```text
Reader header height: 48px
PDF stage background: --pp-bg-pdf-stage
Stage padding: 28px 32px 56px
PDF page max width: 860px
Page gap: 32px
PDF page radius: 8px
PDF page shadow: --pp-shadow-pdf
Page label margin bottom: 8px
Page label font: text-pp-caption
```

### 任务

1. Reader 中间区背景设为 `bg-pp-bg-pdfStage`；
2. PDF 页面居中；
3. PDF page wrapper：`mx-auto w-full max-w-[860px]`；
4. 页面之间 gap 固定 `gap-8`；
5. PDF page 添加 `rounded-lg shadow-ppPdf overflow-hidden bg-pp-bg-pdfPage`；
6. Page label 改成 muted metadata；
7. `PDF p.3` 改为 `来源 PDF · p.3` 或 `PDF · p.3`；
8. 小 accent dot 可以保留，但不能使用大面积橙色；
9. 滚动条保持轻量；
10. 不要改 PDF 渲染组件逻辑。

### PageLabel 推荐实现

```tsx
<div className="mb-2 flex items-center gap-2 text-pp-caption text-pp-text-muted">
  <span className="h-1.5 w-1.5 rounded-full bg-pp-accent opacity-80" />
  <span>来源 PDF · p.{pageNumber}</span>
</div>
```

### PDF Stage 推荐结构

```tsx
<div className="min-h-0 flex-1 overflow-y-auto bg-pp-bg-pdfStage px-8 py-7">
  <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8">
    {pages.map((page) => (
      <PdfPage key={page.id} page={page} />
    ))}
  </div>
</div>
```

### 验收标准

- PDF 看起来像放在安静阅读台上的纸张；
- 页面阴影柔和，不像截图硬贴；
- PDF 阅读区是视觉主角；
- 左右 panel 存在但不抢戏；
- 长时间阅读不会感觉压抑。

---

## 12. P1 任务：右侧 AI Panel 重构

### 目标文件

```text
src/components/ai/AIPanel.tsx
src/components/ai/AIPanelHeader.tsx
src/components/ai/StructuredExplanation.tsx
src/components/ai/AssistantChat.tsx
src/components/ai/ChatMessage.tsx
src/components/ai/ChatComposer.tsx
src/components/ai/AIEmptyState.tsx
src/components/ai/AIErrorState.tsx
src/components/ai/AILoadingState.tsx
```

### 12.1 AI Panel Layout

样式参数：

```text
Width: 420px
Min width: 360px
Max width: 520px
Background: --pp-bg-panel
Left border: 1px solid --pp-border-subtle
Header height: 48px
Header padding: 0 16px
Content padding: 24px
Composer padding: 12px 14px 14px
```

推荐结构：

```tsx
<aside className="grid min-h-0 grid-rows-[48px_minmax(0,1fr)] border-l border-pp-border-subtle bg-pp-bg-panel">
  <AIPanelHeader />
  {mode === "explanation" ? <StructuredExplanation /> : <AssistantChat />}
</aside>
```

### 12.2 Header

任务：

1. 左侧显示标题：`讲解` 或 `助手`；
2. 右侧使用 `SegmentedControl` 切换 `讲解 / 助手`；
3. 删除、刷新、图片等按钮使用统一 `IconButton`；
4. 不要使用 cryptic 标签，例如 `讲 / 构 / J`。

### 12.3 StructuredExplanation

目标：像一篇 mini lecture note，而不是 Markdown dump。

推荐 CSS：

```css
.structured-article {
  max-width: 58ch;
  padding: 24px;
}

.structured-article header {
  margin-bottom: 24px;
}

.structured-article h1 {
  margin: 0;
  color: var(--pp-text-primary);
  font-size: 20px;
  line-height: 28px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.structured-article h2 {
  margin-top: 24px;
  margin-bottom: 8px;
  color: var(--pp-text-primary);
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
}

.structured-article p,
.structured-article li {
  color: var(--pp-text-secondary);
  font-size: 14px;
  line-height: 23px;
}

.structured-article ul {
  margin: 0;
  padding-left: 18px;
}

.structured-article li + li {
  margin-top: 8px;
}

.structured-article li::marker {
  color: var(--pp-text-faint);
}

.structured-article strong {
  color: var(--pp-text-primary);
  font-weight: 600;
}
```

推荐 JSX：

```tsx
<article className="structured-article overflow-y-auto">
  <header>
    <div className="mb-2 text-pp-caption text-pp-text-muted">
      当前页讲解 · PDF p.{currentPage}
    </div>
    <h1>本页作用</h1>
  </header>

  <section>
    <h2>主要内容脉络</h2>
    <ul>
      {/* content */}
    </ul>
  </section>
</article>
```

### 12.4 AssistantChat

目标：像 Claude / ChatGPT 的优雅侧栏，不像临时 textarea 面板。

结构：

```tsx
<div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
  <MessageList />
  <ChatComposer />
</div>
```

消息列表：

```tsx
<div className="min-h-0 overflow-y-auto px-4 py-5">
  {messages.length === 0 ? <AIEmptyState /> : messages.map(...)}
</div>
```

用户消息：

```tsx
<div className="ml-auto max-w-[78%] rounded-[16px_16px_6px_16px] border border-pp-border-subtle bg-pp-bg-panel2 px-3 py-2 text-pp-body text-pp-text-primary shadow-ppInset">
  {content}
</div>
```

助手消息：

```tsx
<div className="mr-auto max-w-[92%] text-pp-body text-pp-text-secondary">
  {content}
</div>
```

说明：assistant 消息不必强行放大气泡，更像正文会更高级。

### 12.5 Empty State

替换当前空状态“你好”。使用学习型 prompt starters。

推荐：

```tsx
<div className="flex h-full flex-col items-center justify-center px-6 text-center">
  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-pp-border-subtle bg-pp-bg-panel2 text-pp-accent-text shadow-ppInset">
    <Sparkles className="size-5" />
  </div>
  <h3 className="text-pp-section text-pp-text-primary">问我关于当前页的问题</h3>
  <p className="mt-2 max-w-[28ch] text-pp-body text-pp-text-muted">
    我可以总结、解释公式、生成检查题，或者把本页内容讲得更直觉。
  </p>
  <div className="mt-5 grid w-full grid-cols-2 gap-2">
    <button className="prompt-chip">总结当前页</button>
    <button className="prompt-chip">解释这个公式</button>
    <button className="prompt-chip">生成检查题</button>
    <button className="prompt-chip">用直觉讲一遍</button>
  </div>
</div>
```

Prompt chip 样式：

```tsx
"rounded-ppLg border border-pp-border-subtle bg-pp-bg-panel2 px-3 py-2 text-left text-pp-control text-pp-text-secondary hover:bg-pp-bg-hover hover:text-pp-text-primary"
```

### 12.6 ChatComposer

目标：接近 Claude 输入框质感。

样式参数：

```text
Wrapper padding: 12px 14px 14px
Composer min height: 104px
Radius: 24px
Background: --pp-bg-input
Border: --pp-border
Focus ring: --pp-ring
Textarea min height: 68px
Send button: 32px
```

推荐实现：

```tsx
<div className="border-t border-pp-border-subtle bg-pp-bg-panel px-3.5 py-3">
  <div className="rounded-ppComposer border border-pp-border bg-pp-bg-input p-2 shadow-ppInset transition-colors focus-within:border-pp-accent-border focus-within:[box-shadow:var(--pp-ring)]">
    <textarea
      className="min-h-[68px] w-full resize-none bg-transparent px-3 py-2 text-pp-body text-pp-text-primary placeholder:text-pp-text-faint outline-none"
      placeholder="询问当前页或选中内容..."
    />
    <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
      <div className="rounded-full border border-pp-border-subtle bg-pp-bg-panel2 px-2.5 py-1 text-pp-meta text-pp-text-muted">
        PDF p.{currentPage}
      </div>
      <IconButton variant="primary" aria-label="发送">
        <Send className="size-4" />
      </IconButton>
    </div>
  </div>
</div>
```

### 12.7 Loading State

不要大 spinner。使用 skeleton：

```tsx
<div className="space-y-3 p-4">
  <div className="text-pp-caption text-pp-text-muted">正在分析当前页...</div>
  <Skeleton className="h-4 w-4/5" />
  <Skeleton className="h-4 w-full" />
  <Skeleton className="h-4 w-2/3" />
</div>
```

Skeleton 样式：

```tsx
"animate-pulse rounded-full bg-white/[0.07]"
```

### 12.8 Error State

替换大橙色错误框。使用 compact inline error：

```tsx
<div className="rounded-ppLg border border-pp-danger-border bg-pp-danger-soft px-3 py-2 text-pp-control text-pp-text-secondary">
  <div className="flex items-center justify-between gap-3">
    <span>生成失败，请重试</span>
    <button className="font-medium text-pp-danger hover:underline">
      重试
    </button>
  </div>
</div>
```

验收标准：

- 错误状态不再像严重系统告警；
- loading 不再使用大 spinner；
- empty state 有明确学习场景引导；
- composer 接近 Claude 的柔和输入框质感。

---

## 13. P2 任务：Settings Modal 重构

### 目标文件

```text
src/components/settings/SettingsModal.tsx
src/components/settings/SettingsNav.tsx
src/components/settings/SettingsRow.tsx
src/components/settings/SettingsSection.tsx
```

### 样式参数

```text
Modal width: 920px
Max width: calc(100vw - 64px)
Max height: 76vh
Grid columns: 220px 1fr
Radius: 20px
Background: --pp-bg-elevated
Border: 1px solid --pp-border
Shadow: --pp-shadow-md
Overlay: rgba(0, 0, 0, 0.56)
Backdrop blur: max 2px
Nav padding: 16px 12px
Content padding: 28px 32px 32px
Settings row min height: 64px
```

### 推荐结构

```tsx
<DialogContent className="grid max-h-[76vh] w-[920px] max-w-[calc(100vw-64px)] grid-cols-[220px_1fr] overflow-hidden rounded-pp2xl border border-pp-border bg-pp-bg-elevated p-0 shadow-ppMd">
  <SettingsNav />
  <main className="min-h-0 overflow-y-auto px-8 py-7">
    <SettingsSection />
  </main>
</DialogContent>
```

### SettingsRow 推荐实现

```tsx
<div className="flex min-h-16 items-center justify-between gap-6 border-b border-pp-border-subtle py-4">
  <div className="min-w-0">
    <div className="text-pp-section text-pp-text-primary">界面语言</div>
    <div className="mt-1 text-pp-caption text-pp-text-muted">
      切换 PagePair Reader 的固定界面文案。
    </div>
  </div>
  <div className="shrink-0">
    {control}
  </div>
</div>
```

### 验收标准

- modal 不再巨大空洞；
- 左 nav 和右内容比例稳定；
- overlay 不糊；
- 设置项 row 化；
- select、switch、button 都使用统一 UI tokens。

---

## 14. P2 任务：微交互和状态统一

### 目标文件

```text
src/components/ui/*
src/components/ai/AIErrorState.tsx
src/components/ai/AILoadingState.tsx
src/components/reader/*
src/components/sidebar/*
```

### 任务

1. 所有可点击元素使用统一 transition：

```css
.interactive {
  transition:
    background-color 120ms ease-out,
    border-color 120ms ease-out,
    color 120ms ease-out,
    box-shadow 120ms ease-out,
    transform 80ms ease-out;
}

.interactive:active {
  transform: translateY(0.5px);
}
```

2. 所有 button / input / textarea 有 `focus-visible` ring；
3. 禁止大面积 glow、neon、heavy gradient；
4. hover 使用 `--pp-bg-hover`；
5. selected 使用 `--pp-bg-selected`；
6. disabled 使用 `--pp-text-disabled` 且 opacity 不要低到不可读；
7. tooltip 背景使用 `--pp-bg-elevated`，边框 `--pp-border`。

### 验收标准

- 所有交互状态统一；
- 暗色主题不脏、不糊、不闷；
- 操作反馈轻，但可感知；
- 长时间阅读没有视觉疲劳。

---

## 15. 文件 / 组件拆分执行顺序

请按以下顺序执行，不要跳跃式修改。

### Step 1: Design tokens

目标文件：

```text
src/styles/globals.css
src/styles/tokens.css
tailwind.config.ts
```

验收：tokens 生效，页面基础色变为 warm graphite。

视觉检查：全局从黑橙 demo 转为暖灰暗色。

---

### Step 2: 基础 UI 组件

目标文件：

```text
src/components/ui/Button.tsx
src/components/ui/IconButton.tsx
src/components/ui/SegmentedControl.tsx
src/components/ui/Input.tsx
src/components/ui/Textarea.tsx
src/components/ui/Skeleton.tsx
```

验收：所有按钮尺寸、圆角、hover、active、focus 统一。

视觉检查：toolbar 和 panel icon buttons 不再各自为政。

---

### Step 3: AppShell / 三栏布局

目标文件：

```text
src/components/layout/AppShell.tsx
src/components/layout/TopBar.tsx
src/components/layout/Sidebar.tsx
src/components/layout/ReaderPane.tsx
src/components/layout/AIPanel.tsx
```

验收：三栏宽度稳定，顶栏 56px，右栏 420px，左栏 280px。

视觉检查：PDF 是主角，左右两侧安静。

---

### Step 4: TopBar

目标文件：

```text
src/components/toolbar/PageNavigator.tsx
src/components/toolbar/ViewControls.tsx
src/components/toolbar/GenerateButton.tsx
```

验收：页码导航居中，生成按钮唯一强 CTA，其他按钮轻量。

视觉检查：顶栏接近 Claude / Linear 的克制工具栏。

---

### Step 5: Sidebar

目标文件：

```text
src/components/sidebar/*
```

验收：sidebar 像 workspace，不像后台管理目录树。

视觉检查：左侧文字弱化、active 克制、搜索框轻量。

---

### Step 6: PDF Reader

目标文件：

```text
src/components/reader/*
```

验收：PDF 页面居中、有柔和纸张感，page label 变成 metadata。

视觉检查：中间像安静阅读台。

---

### Step 7: AI Panel

目标文件：

```text
src/components/ai/*
```

验收：讲解 article 化，聊天 Claude-like，composer 柔和，error / loading / empty 成熟。

视觉检查：右侧像优雅 AI 学习侧栏。

---

### Step 8: Settings Modal

目标文件：

```text
src/components/settings/*
```

验收：modal 尺寸合理，row 化，overlay 克制。

视觉检查：像成熟 app preferences。

---

### Step 9: 全局视觉 QA

检查：

1. 1280px / 1440px / 1728px 宽度；
2. 默认阅读页面；
3. 结构化讲解页面；
4. 助手聊天空状态；
5. AI 生成 loading；
6. AI 生成失败；
7. 设置弹窗；
8. 左栏 active / hover；
9. 顶栏按钮 hover / focus；
10. PDF 多页滚动。

---

## 16. 具体 Before / After 要求

### 16.1 顶部 toolbar

Before：按钮多、权重混乱、橙色过强。  
After：只有生成按钮是强 CTA；其他都是轻量 ghost / subtle icon button。

### 16.2 左侧 sidebar

Before：像后台目录树。  
After：像 Claude Projects / Notion workspace，安静、低噪音、可扫读。

### 16.3 PDF 阅读区

Before：PDF 页面像截图堆叠在黑底上。  
After：PDF 像安静阅读台上的纸张，居中、柔和阴影、page label 弱化。

### 16.4 右侧讲解

Before：Markdown dump。  
After：mini lecture note，标题、section、bullet、正文节奏稳定。

### 16.5 右侧聊天

Before：临时聊天面板。  
After：Claude-like AI side panel，有 prompt starters，有柔和 composer，有优雅消息排版。

### 16.6 输入框

Before：普通 textarea，边框橙色重。  
After：Claude-like large rounded composer，warm gray 背景，focus ring 克制。

### 16.7 错误状态

Before：大橙色框，像严重告警。  
After：compact inline error，带 retry，不刺眼。

### 16.8 设置 modal

Before：大、空、糊。  
After：920px preferences dialog，左 nav 220px，右侧 row 化。

---

## 17. 视觉禁区

不要做：

1. 大面积毛玻璃；
2. 霓虹光效；
3. 过度渐变；
4. 强拟物；
5. 高饱和橙色铺底；
6. 大面积纯黑；
7. 正文纯白；
8. hover 状态过亮；
9. 粗边框；
10. 过多阴影；
11. 动画过度；
12. 为了好看牺牲 PDF 可读性。

---

## 18. 最终验收标准

改完后，PagePair Reader 应满足：

1. 第一眼像成熟 AI 学习 productivity app，而不是学生 demo；
2. 暗色模式温暖、干净、有层级；
3. 橙色变成低饱和点缀，不廉价；
4. PDF 阅读区沉浸且稳定；
5. 右侧 AI 面板像 Claude / ChatGPT 的优雅侧栏；
6. 左侧文件管理像 Claude Projects / Notion workspace；
7. toolbar 精简，不抢主内容；
8. 设置 modal 像成熟 app preferences；
9. loading / error / empty 状态可信赖；
10. 所有按钮、输入框、tab、icon button 风格统一；
11. 长时间阅读护眼、低干扰；
12. 现有功能逻辑完全不被破坏。

---

## 19. 最重要的一句话

把 PagePair Reader 的视觉从 **“黑橙暗色工具页”** 升级为 **“Claude-like warm graphite AI academic reader”**：

- 用 warm graphite 建立高级暗色基底；
- 用低饱和 clay/copper accent 保留温度；
- 用大量克制留白和柔和边框降低噪音；
- 用统一组件系统消除拼装感；
- 让 PDF 成为主角，让 AI 像安静可靠的学习搭档。
