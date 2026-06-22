import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  lazy,
  Suspense,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type { AppCopy } from "../../i18n";
import type { PageData } from "../../lib/generation/teachingGeneration";
import type { GenerationPageStatus } from "../../lib/generation/generationRuntime";
import {
  compactText,
  formatPageRanges,
} from "../../lib/workspace/synchroPageState";

const MarkdownRenderer = lazy(() => import("../MarkdownRenderer"));

export function PaneToolbar({ title, badge, right }: { title: string; badge?: string; right?: ReactNode }) {
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

export function PageNavigator({
  className = "",
  currentPage,
  pageCount,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
}: {
  className?: string;
  currentPage: number;
  pageCount: number;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className={`page-navigator ${className}`} role="group" aria-label={`${previousLabel} / ${nextLabel}`}>
      <IconButton label={previousLabel} onClick={onPrevious} disabled={currentPage <= 1}>
        <ChevronLeft />
      </IconButton>
      <output>{currentPage} / {pageCount}</output>
      <IconButton label={nextLabel} onClick={onNext} disabled={currentPage >= pageCount}>
        <ChevronRight />
      </IconButton>
    </div>
  );
}

export function SlidePreview({ page, copy }: { page: PageData; copy: AppCopy }) {
  return (
    <article className="slide-preview">
      <div className="slide-kicker">{copy.common.pageLabel(page.page_no)}</div>
      <h2>{page.teaching.slide_title}</h2>
      <div className="slide-grid">
        <div>
          <div className="slide-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="chips">
            {page.teaching.concepts.slice(0, 3).map((item) => <ReaderMarkdown className="chip" inline key={item} text={item} />)}
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

export function GenerationDetailsPopover({
  copy,
  pages,
  currentPageNo,
  summary,
  statusLabel,
}: {
  copy: AppCopy;
  pages: Array<{ pageNo: number; status: GenerationPageStatus }>;
  currentPageNo: number;
  summary: { done: number; running: number; retrying: number; failed: number; pending: number };
  statusLabel: (status: GenerationPageStatus, copy: AppCopy) => string;
}) {
  const pageRangeForStatus = (status: GenerationPageStatus) =>
    formatPageRanges(pages.filter((item) => item.status === status).map((item) => item.pageNo)) || copy.common.none;
  const currentStatus = pages.find((item) => item.pageNo === currentPageNo)?.status || "pending";
  const rows = [
    { label: copy.topbar.generationDetailsGenerated, value: `${summary.done}/${pages.length}`, detail: pageRangeForStatus("done") },
    { label: copy.topbar.generationDetailsPending, value: `${summary.pending}`, detail: pageRangeForStatus("pending") },
    ...(summary.running
      ? [{ label: copy.topbar.generationDetailsRunning, value: `${summary.running}`, detail: pageRangeForStatus("running") }]
      : []),
    ...(summary.retrying
      ? [{ label: copy.topbar.generationDetailsRetrying, value: `${summary.retrying}`, detail: pageRangeForStatus("retrying") }]
      : []),
    ...(summary.failed ? [{ label: copy.topbar.generationDetailsFailed, value: `${summary.failed}`, detail: pageRangeForStatus("failed") }] : []),
    {
      label: copy.topbar.generationDetailsCurrent,
      value: `p.${currentPageNo}`,
      detail: statusLabel(currentStatus, copy),
    },
  ];

  return (
    <div className="generation-details-popover" role="status" aria-label={copy.topbar.generationDetailsLabel}>
      <div className="generation-details-header">
        <span>{copy.topbar.generationDetailsLabel}</span>
        <strong>{summary.done}/{pages.length}</strong>
      </div>
      <div className="generation-details-list">
        {rows.map((row) => (
          <div className="generation-detail-row" key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            <small title={row.detail}>{row.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MarkdownBlock({ markdown, concepts }: { markdown: string; concepts: string[] }) {
  return (
    <article className="note-markdown">
      <ReaderMarkdown className="note-markdown-content markdown-body" text={markdown} />
      <div className="chips">{concepts.map((item) => <ReaderMarkdown className="chip" inline key={item} text={item} />)}</div>
    </article>
  );
}

export function ReaderMarkdown({ className, text, inline = false }: { className: string; text: string; inline?: boolean }) {
  return (
    <Suspense fallback={inline ? <span className={className}>{text}</span> : <div className={className}>{text}</div>}>
      <MarkdownRenderer className={className} inline={inline} text={text} />
    </Suspense>
  );
}

export function StructurePanel({ page, copy }: { page: PageData; copy: AppCopy }) {
  const rows = [
    [copy.structure.pageNo, copy.common.pageLabel(page.page_no)],
    [copy.structure.parser, page.source.parser],
    [copy.structure.ocr, page.source.ocr_used ? copy.structure.ocrEnabled : copy.structure.ocrDisabled],
    [copy.structure.confidence, `${Math.round(page.teaching.confidence * 100)}%`],
    [copy.structure.prerequisites, page.teaching.prerequisites.join(copy.common.listSeparator) || copy.common.none],
    [copy.structure.visualNotes, page.teaching.visual_explanations.join(copy.common.sentenceSeparator) || copy.common.none],
    [copy.structure.sourceText, page.source.text_md || copy.common.none],
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

export function IconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`mini-button ${active ? "active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function FileButton({
  label,
  accept,
  onFile,
  onFiles,
  multiple = false,
  children,
}: {
  label: string;
  accept: string;
  onFile?: (file: File) => void;
  onFiles?: (files: File[]) => void;
  multiple?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="mini-button" title={label} aria-label={label}>
      {children}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.target.files || []);
          if (files.length) {
            if (onFiles) {
              onFiles(files);
            } else {
              onFile?.(files[0]);
            }
          }
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}
