import { Eye, Lightbulb, MessageCircleQuestion, NotebookPen, PencilLine } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AppCopy } from "../../i18n";
import type { AnnotationRecord } from "../../lib/persistence";
import { ReaderMarkdown } from "./WorkspaceChrome";

/** Unsent drafts per page, kept for the session so turning the page does not lose a half-written thought. */
const draftCache = new Map<string, string>();

/** Grows with its text, and measures again whenever the column's width changes the wrapping. */
function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);
  useLayoutEffect(resize, [value, resize]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);
  return { ref, resize };
}

/**
 * The question a page asks before its explanation opens, with room for the
 * learner's own answer. Writing something and comparing is the main path;
 * "just show me" is always one click away, because a gate that cannot be
 * passed teaches resentment, not thinking.
 */
export function ThinkFirstPrompt({
  draftKey,
  question,
  generic,
  hasExplanation,
  initialText,
  editing,
  copy,
  onSubmit,
  onReveal,
  onCancelEdit,
}: {
  /** Document and page, so a draft survives turning the page. */
  draftKey: string;
  question: string;
  /** The page has no question of its own (generated before questions existed, or not generated yet). */
  generic: boolean;
  hasExplanation: boolean;
  /** The saved reflection, when editing it again. */
  initialText?: string;
  editing?: boolean;
  copy: AppCopy;
  /** Resolves to false when nothing could be saved; the text then stays in the box. */
  onSubmit: (text: string) => Promise<boolean>;
  onReveal: () => void;
  onCancelEdit?: () => void;
}) {
  // An edit keeps its own draft, so abandoning one never leaks into the next.
  const cacheKey = editing ? `${draftKey}:edit` : draftKey;
  const [text, setText] = useState(() => draftCache.get(cacheKey) ?? initialText ?? "");
  const [saving, setSaving] = useState(false);
  const { ref, resize } = useAutosize(text);
  const trimmed = text.trim();

  useEffect(() => {
    if (text && text !== initialText) draftCache.set(cacheKey, text);
    else draftCache.delete(cacheKey);
  }, [cacheKey, initialText, text]);

  // Opened on purpose (修改, or "say it back" at the end of a long explanation):
  // take the focus and bring the box into view where the button used to be.
  useLayoutEffect(() => {
    if (!editing) return;
    const element = ref.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollIntoView({ block: "center" });
  }, [editing, ref]);

  const submit = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    const saved = await onSubmit(trimmed).catch(() => false);
    setSaving(false);
    if (saved) draftCache.delete(cacheKey);
  };

  const cancelEdit = () => {
    draftCache.delete(cacheKey);
    onCancelEdit?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      cancelEdit();
    }
  };

  const submitLabel = editing ? copy.thinkFirst.saveEdit : hasExplanation ? copy.thinkFirst.compare : copy.thinkFirst.keep;

  return (
    <section className="think-first" aria-label={copy.thinkFirst.label}>
      <p className="think-first-eyebrow">
        <Lightbulb aria-hidden="true" />
        <span>{copy.thinkFirst.label}</span>
      </p>
      <p className={`think-first-question ${generic ? "generic" : ""}`}>
        <ReaderMarkdown className="think-first-question-text" inline text={question} />
      </p>
      <textarea
        ref={ref}
        className="think-first-input"
        rows={3}
        value={text}
        placeholder={copy.thinkFirst.placeholder}
        aria-label={copy.thinkFirst.inputAria}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onInput={resize}
        onKeyDown={handleKeyDown}
      />
      <div className="think-first-actions">
        <button type="button" className="think-first-submit" disabled={!trimmed || saving} onClick={() => void submit()}>
          <PencilLine aria-hidden="true" />
          <span>{submitLabel}</span>
        </button>
        {editing ? (
          <button type="button" className="think-first-secondary" onClick={cancelEdit}>
            {copy.thinkFirst.cancelEdit}
          </button>
        ) : hasExplanation ? (
          <button type="button" className="think-first-secondary" onClick={onReveal}>
            <Eye aria-hidden="true" />
            <span>{copy.thinkFirst.reveal}</span>
          </button>
        ) : null}
        <span className="think-first-hint">{copy.thinkFirst.hint}</span>
      </div>
    </section>
  );
}

/** What the learner wrote before opening the explanation, shown above it so the two can be compared. */
export function ThinkFirstRecap({
  reflection,
  copy,
  onEdit,
  onCheck,
}: {
  reflection: AnnotationRecord;
  copy: AppCopy;
  onEdit: () => void;
  onCheck: () => void;
}) {
  const label = reflection.afterReading ? copy.thinkFirst.recapAfterLabel : copy.thinkFirst.recapLabel;
  return (
    <section className="think-first-recap" aria-label={label}>
      <p className="think-first-eyebrow">
        <NotebookPen aria-hidden="true" />
        <span>{label}</span>
      </p>
      {reflection.prompt && (
        <p className="think-first-recap-question">
          <ReaderMarkdown className="think-first-question-text" inline text={reflection.prompt} />
        </p>
      )}
      <p className="think-first-recap-text">{reflection.note}</p>
      <div className="think-first-actions">
        <button type="button" className="think-first-secondary" onClick={onCheck} title={copy.thinkFirst.checkHint}>
          <MessageCircleQuestion aria-hidden="true" />
          <span>{copy.thinkFirst.check}</span>
        </button>
        <button type="button" className="think-first-secondary" onClick={onEdit}>
          <PencilLine aria-hidden="true" />
          <span>{copy.thinkFirst.edit}</span>
        </button>
      </div>
    </section>
  );
}

/** Stands where the explanation will open, so the learner knows it is there and why it waits. */
export function ThinkFirstVeil({ copy, onReveal }: { copy: AppCopy; onReveal: () => void }) {
  return (
    <div className="think-first-veil">
      <span className="think-first-veil-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <p>
        {copy.thinkFirst.veil}{" "}
        <button type="button" className="think-first-link" onClick={onReveal}>
          {copy.thinkFirst.reveal}
        </button>
      </p>
    </div>
  );
}

/** A page without an explanation yet: the learner can still think first, and can ask for one. */
export function ExplanationMissing({
  copy,
  generating,
  failed = false,
  onGenerate,
}: {
  copy: AppCopy;
  generating: boolean;
  /** The last attempt failed; its reason is shown above. */
  failed?: boolean;
  onGenerate: () => void;
}) {
  const message = generating ? copy.thinkFirst.preparing : failed ? copy.thinkFirst.failedExplanation : copy.thinkFirst.noExplanation;
  return (
    <div className="explanation-missing">
      <p>{message}</p>
      {!generating && (
        <button type="button" className="think-first-secondary" onClick={onGenerate}>
          <NotebookPen aria-hidden="true" />
          <span>{failed ? copy.thinkFirst.retryThisPage : copy.thinkFirst.prepareThisPage}</span>
        </button>
      )}
    </div>
  );
}
