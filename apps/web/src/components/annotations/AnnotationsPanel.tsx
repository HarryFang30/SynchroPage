import { Download } from "lucide-react";
import type { AppCopy } from "../../i18n";
import {
  annotationsToMarkdown,
  compactQuote,
  formatAnnotationTime,
  groupAnnotationsByPage,
} from "../../lib/annotations/annotationModel";
import type { AnnotationRecord } from "../../lib/persistence";

/**
 * Document-wide index of highlights and notes (the "笔记" tab in the notes
 * pane). The cards under each PDF page remain the place to write; this list
 * is for overview, jumping back to a page, and exporting.
 */
export function AnnotationsPanel({
  documentTitle,
  annotations,
  activeId,
  copy,
  language,
  onJump,
  onExported,
}: {
  documentTitle: string;
  annotations: AnnotationRecord[];
  activeId: string | null;
  copy: AppCopy;
  language: string;
  onJump: (annotation: AnnotationRecord) => void;
  onExported: (count: number) => void;
}) {
  const groups = Array.from(groupAnnotationsByPage(annotations));

  const exportMarkdown = () => {
    const markdown = annotationsToMarkdown(documentTitle, annotations, {
      title: copy.annotations.markdownTitle,
      page: copy.annotations.pageHeading,
      emptyNote: copy.annotations.emptyNote,
    });
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${documentTitle.replace(/[\\/:*?"<>|]+/g, "_") || "notes"}.notes.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onExported(annotations.length);
  };

  return (
    <section className="annotations-panel" aria-label={copy.annotations.panelTitle}>
      <header className="annotations-panel-header">
        <div className="annotations-panel-title">
          <strong>{copy.annotations.panelTitle}</strong>
          <span>{copy.annotations.panelCount(annotations.length)}</span>
        </div>
        <button
          type="button"
          className="annotations-export"
          onClick={exportMarkdown}
          disabled={!annotations.length}
          title={copy.annotations.exportMarkdown}
        >
          <Download aria-hidden="true" />
          <span>{copy.annotations.exportMarkdown}</span>
        </button>
      </header>
      {!annotations.length && (
        <div className="annotations-empty">
          <strong>{copy.annotations.panelEmpty}</strong>
          <p>{copy.annotations.panelEmptyHint}</p>
        </div>
      )}
      {groups.map(([pageNo, items]) => (
        <div className="annotations-page-group" key={pageNo}>
          <div className="annotations-page-heading">{copy.annotations.pageHeading(pageNo)}</div>
          {items.map((annotation) => (
            <button
              key={annotation.id}
              type="button"
              className={`annotations-item ${annotation.id === activeId ? "active" : ""}`}
              data-color={annotation.color}
              onClick={() => onJump(annotation)}
              title={copy.annotations.jumpToPage(annotation.pageNumber)}
            >
              {annotation.quote.trim() ? (
                <span className="annotations-item-quote">{compactQuote(annotation.quote, 120)}</span>
              ) : (
                <span className="annotations-item-kicker">{copy.annotations.pageNoteTitle}</span>
              )}
              <span className={`annotations-item-note ${annotation.note.trim() ? "" : "empty"}`}>
                {annotation.note.trim() ? compactQuote(annotation.note, 240) : copy.annotations.emptyNote}
              </span>
              <span className="annotations-item-time">{formatAnnotationTime(annotation.updatedAt, language)}</span>
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
