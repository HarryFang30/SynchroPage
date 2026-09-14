import { Plus, Sparkles, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { AppCopy } from "../../i18n";
import { ANNOTATION_COLORS, compactQuote, formatAnnotationTime } from "../../lib/annotations/annotationModel";
import type { AnnotationColor, AnnotationRecord } from "../../lib/persistence";

export type PageNotesHandlers = {
  onActivate: (id: string) => void;
  onChangeNote: (id: string, note: string) => void;
  onChangeColor: (id: string, color: AnnotationColor) => void;
  onDelete: (id: string) => void;
  onAddPageNote: (pageNo: number) => void;
  onFocusHandled: (id: string) => void;
  /** "让 AI 检查": send this note to the assistant for a verdict. */
  onCheckNote: (annotation: AnnotationRecord) => void;
};

/**
 * Margin notes for one PDF page, rendered directly beneath it so they read
 * like notes in the margin of a printed handout: always expanded, always
 * editable, saved as you type.
 */
export function PageNotes({
  pageNo,
  annotations,
  activeId,
  focusRequestId,
  copy,
  language,
  handlers,
}: {
  pageNo: number;
  annotations: AnnotationRecord[];
  activeId: string | null;
  focusRequestId: string | null;
  copy: AppCopy;
  language: string;
  handlers: PageNotesHandlers;
}) {
  return (
    <div className={`pdf-page-notes ${annotations.length ? "has-notes" : ""}`} data-page-number={pageNo}>
      {annotations.map((annotation) => (
        <NoteCard
          key={annotation.id}
          annotation={annotation}
          active={annotation.id === activeId}
          focusRequested={annotation.id === focusRequestId}
          copy={copy}
          language={language}
          handlers={handlers}
        />
      ))}
      <button
        type="button"
        className="pdf-page-add-note"
        onClick={() => handlers.onAddPageNote(pageNo)}
        title={copy.annotations.addPageNote}
      >
        <Plus aria-hidden="true" />
        <span>{copy.annotations.addPageNote}</span>
      </button>
    </div>
  );
}

function NoteCard({
  annotation,
  active,
  focusRequested,
  copy,
  language,
  handlers,
}: {
  annotation: AnnotationRecord;
  active: boolean;
  focusRequested: boolean;
  copy: AppCopy;
  language: string;
  handlers: PageNotesHandlers;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [annotation.note, resize]);

  useEffect(() => {
    if (!focusRequested) return;
    const element = textareaRef.current;
    if (element) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      element.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    handlers.onFocusHandled(annotation.id);
  }, [annotation.id, focusRequested, handlers]);

  useEffect(() => () => {
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const handleDelete = () => {
    if (confirmingDelete) {
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      handlers.onDelete(annotation.id);
      return;
    }
    setConfirmingDelete(true);
    confirmTimerRef.current = window.setTimeout(() => setConfirmingDelete(false), 3200);
  };

  return (
    <article
      className={`page-note ${active ? "active" : ""} ${annotation.kind === "note" ? "page-level" : ""}`}
      data-color={annotation.color}
      data-annotation-id={annotation.id}
      onFocusCapture={() => handlers.onActivate(annotation.id)}
      onMouseDownCapture={() => handlers.onActivate(annotation.id)}
    >
      {annotation.quote.trim() ? (
        <blockquote className="page-note-quote" title={annotation.quote}>
          {compactQuote(annotation.quote)}
        </blockquote>
      ) : (
        <div className="page-note-kicker">{copy.annotations.pageNoteTitle}</div>
      )}
      <textarea
        ref={textareaRef}
        className="page-note-input"
        rows={1}
        value={annotation.note}
        placeholder={copy.annotations.notePlaceholder}
        aria-label={copy.annotations.noteAria}
        spellCheck={false}
        onChange={(event) => handlers.onChangeNote(annotation.id, event.target.value)}
        onInput={resize}
        onKeyDown={handleKeyDown}
      />
      <footer className="page-note-footer">
        <div className="page-note-colors" role="radiogroup" aria-label={copy.annotations.colorLabel}>
          {ANNOTATION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={annotation.color === color}
              aria-label={copy.annotations.colors[color]}
              title={copy.annotations.colors[color]}
              className={`page-note-color ${annotation.color === color ? "selected" : ""}`}
              data-color={color}
              onClick={() => handlers.onChangeColor(annotation.id, color)}
            />
          ))}
        </div>
        <time className="page-note-time" dateTime={new Date(annotation.updatedAt).toISOString()}>
          {formatAnnotationTime(annotation.updatedAt, language)}
        </time>
        <button
          type="button"
          className="page-note-ask"
          disabled={!annotation.note.trim() && !annotation.quote.trim()}
          onClick={() => handlers.onCheckNote(annotation)}
          aria-label={copy.annotations.checkUnderstanding}
          title={
                  annotation.note.trim()
                    ? copy.annotations.checkUnderstandingHint
                    : annotation.quote.trim()
                      ? copy.annotations.checkHighlightHint
                      : copy.annotations.checkUnderstandingEmpty
                }
        >
          <Sparkles aria-hidden="true" />
          <span>{copy.annotations.checkUnderstanding}</span>
        </button>
        <button
          type="button"
          className={`page-note-delete ${confirmingDelete ? "confirming" : ""}`}
          onClick={handleDelete}
          onBlur={() => setConfirmingDelete(false)}
          aria-label={confirmingDelete ? copy.annotations.confirmDelete : copy.annotations.delete}
          title={confirmingDelete ? copy.annotations.confirmDelete : copy.annotations.delete}
        >
          <Trash2 aria-hidden="true" />
          <span>{confirmingDelete ? copy.annotations.confirmDelete : copy.annotations.delete}</span>
        </button>
      </footer>
    </article>
  );
}
