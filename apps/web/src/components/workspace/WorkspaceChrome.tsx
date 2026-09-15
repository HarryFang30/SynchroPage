import {
  ArrowLeftRight,
  BookA,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Compass,
  FlaskConical,
  GraduationCap,
  Image as ImageIcon,
  Lightbulb,
  ListChecks,
  Pin,
  SquareFunction,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useMemo,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { AppCopy } from "../../i18n";
import { useAppCopy } from "../../lib/contexts";
import { splitNoteSections, type NoteSectionKey } from "../../lib/notes/noteSections";
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

/** One icon per section kind, so the reader recognises the rhythm of a page at a glance. */
const NOTE_SECTION_ICONS: Record<NoteSectionKey, LucideIcon> = {
  lead: Lightbulb,
  symbols: BookA,
  example: FlaskConical,
  keep: Pin,
  stuck: TriangleAlert,
  formula: SquareFunction,
  visual: ImageIcon,
  entry: Compass,
  selfcheck: ListChecks,
  exam: GraduationCap,
  check: CircleHelp,
  bridge: ArrowLeftRight,
};

function noteOrder(index: number): CSSProperties {
  return { "--note-i": index } as CSSProperties;
}

export function MarkdownBlock({
  markdown,
  concepts,
  title,
  pageNo,
  pageType,
}: {
  markdown: string;
  concepts: string[];
  title?: string;
  pageNo?: number;
  pageType?: string;
}) {
  const copy = useAppCopy();
  const sections = useMemo(() => splitNoteSections(markdown), [markdown]);
  const heading = (title || "").trim();
  const typeLabel = pageType ? copy.notes.pageTypes[pageType.trim().toLowerCase()] : undefined;
  const showHeader = Boolean(heading || concepts.length);
  let order = 0;
  return (
    // Keyed by page so a page change replays the entrance instead of morphing
    // the previous page's sections in place.
    <article className="note-markdown" key={pageNo ?? "notes"}>
      {showHeader && (
        <header className="note-header" style={noteOrder(order++)}>
          {(pageNo !== undefined || typeLabel) && (
            <p className="note-eyebrow">
              {pageNo !== undefined && <span>{copy.common.pageLabel(pageNo)}</span>}
              {typeLabel && <span>{typeLabel}</span>}
            </p>
          )}
          {heading && (
            <h1 className="note-title">
              <ReaderMarkdown className="note-title-text" inline text={heading} />
            </h1>
          )}
          {concepts.length > 0 && (
            <ul className="note-concepts" aria-label={copy.notes.conceptsLabel}>
              {concepts.map((item) => (
                <li key={item}>
                  <ReaderMarkdown className="note-concept" inline text={item} />
                </li>
              ))}
            </ul>
          )}
        </header>
      )}
      {sections.map((section, index) => {
        const Icon = section.key ? NOTE_SECTION_ICONS[section.key] : null;
        return (
          <section
            key={`${index}-${section.heading}`}
            className={`note-section${section.key ? ` note-section-${section.key}` : ""}`}
            style={noteOrder(order++)}
          >
            {section.heading && (
              <h2 className="note-section-title">
                {Icon && <Icon className="note-section-icon" aria-hidden="true" />}
                <span>{section.heading}</span>
              </h2>
            )}
            {section.body && <ReaderMarkdown className="note-markdown-content markdown-body" text={section.body} />}
            {section.answer !== undefined && (
              <details className="note-answer">
                <summary>
                  <span className="note-answer-show">{copy.notes.showAnswer}</span>
                  <span className="note-answer-hide">{copy.notes.hideAnswer}</span>
                </summary>
                <ReaderMarkdown className="note-markdown-content markdown-body" text={section.answer} />
              </details>
            )}
          </section>
        );
      })}
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
    [copy.structure.stuckPoints, (page.teaching.stuck_points || []).join(copy.common.sentenceSeparator) || copy.common.none],
    [copy.structure.examAngles, (page.teaching.exam_angles || []).join(copy.common.sentenceSeparator) || copy.common.none],
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
