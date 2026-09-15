import type { AppCopy } from "../../i18n";
import { useAppCopy } from "../../lib/contexts";
import type { LessonPlan, LessonPlanPage } from "../../lib/generation/lessonPlan";
import type { GenerationPageStatus } from "../../lib/generation/generationRuntime";
import { pageIsTranscribed, pageTextLayerIsUnreadable } from "../../lib/generation/generationRuntime";
import type { PageData } from "../../lib/generation/teachingGeneration";

/**
 * The lesson map: the plan the planning pass wrote for this deck, laid out
 * as a syllabus. Segments in lecture order; every page with its role, how
 * much it is taught (one, two or three bars), the ★ of a key page, the
 * planner's cue, and whether its notes exist yet. Clicking a page scrolls the
 * PDF there; the notes tab follows the reader as usual.
 */
export function LessonMapPanel({
  plan,
  pages,
  currentPageNo,
  statuses,
  onJumpToPage,
}: {
  plan?: LessonPlan;
  pages: PageData[];
  currentPageNo: number;
  statuses: ReadonlyMap<number, GenerationPageStatus>;
  onJumpToPage: (pageNo: number) => void;
}) {
  const copy = useAppCopy();
  if (!plan) {
    return (
      <div className="lesson-map lesson-map-empty">
        <p className="lesson-map-empty-title">{copy.lessonMap.empty}</p>
        <p>{copy.lessonMap.emptyHint}</p>
      </div>
    );
  }
  const pagesByNumber = new Map(pages.map((page) => [page.page_no, page]));
  const rowsBySegment = new Map<number, LessonPlanPage[]>();
  for (const row of plan.pages) {
    const rows = rowsBySegment.get(row.segment) ?? [];
    rows.push(row);
    rowsBySegment.set(row.segment, rows);
  }
  const keyPageNumbers = plan.pages.filter((row) => row.key).map((row) => row.page_no);
  return (
    <nav className="lesson-map" aria-label={copy.lessonMap.title}>
      <header className="lesson-map-header">
        <p className="lesson-map-eyebrow">
          <span>{copy.lessonMap.title}</span>
          <span>{copy.lessonMap.segmentCount(plan.segments.length)}</span>
          <span>{copy.lessonMap.pageCount(plan.pages.length)}</span>
        </p>
        {plan.document_summary && <p className="lesson-map-summary">{plan.document_summary}</p>}
        {keyPageNumbers.length > 0 && (
          <p className="lesson-map-key-pages">
            <span className="lesson-map-key-pages-label">{copy.lessonMap.keyPagesLabel}</span>
            {keyPageNumbers.map((pageNo) => (
              <button
                key={pageNo}
                type="button"
                className="lesson-map-key-chip"
                title={copy.lessonMap.jump(pageNo)}
                onClick={() => onJumpToPage(pageNo)}
              >
                ★ p.{pageNo}
              </button>
            ))}
          </p>
        )}
      </header>
      <ol className="lesson-map-segments">
        {plan.segments.map((segment, index) => (
          <li className="lesson-map-segment" key={segment.id}>
            <div className="lesson-map-segment-header">
              <span className="lesson-map-segment-index" aria-hidden="true">{index + 1}</span>
              <div className="lesson-map-segment-text">
                <h2 className="lesson-map-segment-title">{segment.title}</h2>
                <p className="lesson-map-segment-meta">
                  <span>{copy.lessonMap.pageRange(segment.pages[0], segment.pages[1])}</span>
                  {segment.goal && <span>{segment.goal}</span>}
                </p>
              </div>
            </div>
            <ol className="lesson-map-pages">
              {(rowsBySegment.get(segment.id) ?? []).map((row) => (
                <li key={row.page_no}>
                  <LessonMapPageRow
                    row={row}
                    page={pagesByNumber.get(row.page_no)}
                    current={row.page_no === currentPageNo}
                    status={statuses.get(row.page_no) ?? "pending"}
                    copy={copy}
                    onJump={onJumpToPage}
                  />
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function statusLabel(status: GenerationPageStatus, copy: AppCopy) {
  if (status === "done") return copy.lessonMap.statusDone;
  if (status === "running" || status === "retrying") return copy.lessonMap.statusRunning;
  if (status === "failed") return copy.lessonMap.statusFailed;
  return copy.lessonMap.statusPending;
}

function LessonMapPageRow({
  row,
  page,
  current,
  status,
  copy,
  onJump,
}: {
  row: LessonPlanPage;
  page?: PageData;
  current: boolean;
  status: GenerationPageStatus;
  copy: AppCopy;
  onJump: (pageNo: number) => void;
}) {
  const roleLabel = copy.notes.roles[row.role] || row.role;
  const depthLabel = copy.notes.depths[row.depth] || row.depth;
  const textLayer = page && pageIsTranscribed(page) ? "transcribed" : page && pageTextLayerIsUnreadable(page) ? "unreadable" : undefined;
  const className = [
    "lesson-map-page",
    `depth-${row.depth}`,
    current ? "is-current" : "",
    row.key ? "is-key" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={className}
      aria-current={current ? "page" : undefined}
      title={copy.lessonMap.jump(row.page_no)}
      onClick={() => onJump(row.page_no)}
    >
      <span className="lesson-map-page-no">p.{row.page_no}</span>
      <span className="lesson-map-depth" role="img" aria-label={depthLabel} title={depthLabel}>
        <i /><i /><i />
      </span>
      <span className="lesson-map-page-body">
        <span className="lesson-map-page-role">
          <span>{roleLabel}</span>
          {row.key && <b className="lesson-map-key">★ {copy.notes.keyPage}</b>}
          {textLayer === "transcribed" && (
            <span className="note-text-layer note-text-layer-transcribed" title={copy.notes.textLayerTranscribedTitle}>
              {copy.notes.textLayerTranscribed}
            </span>
          )}
          {textLayer === "unreadable" && (
            <span className="note-text-layer note-text-layer-unreadable" title={copy.notes.textLayerUnreadableTitle}>
              {copy.notes.textLayerUnreadable}
            </span>
          )}
        </span>
        {row.cue && row.depth !== "skim" && <span className="lesson-map-page-cue">{row.cue}</span>}
      </span>
      <span className={`lesson-map-status status-${status}`} role="img" aria-label={statusLabel(status, copy)} title={statusLabel(status, copy)} />
    </button>
  );
}
