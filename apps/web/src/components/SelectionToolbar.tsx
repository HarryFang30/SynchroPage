import { useAppCopy } from "../lib/contexts";
import type { SelectedContext, SelectionToolbarState } from "../hooks/usePageSelection";

export function SelectionToolbar(props: {
  state: SelectionToolbarState | null;
  onAdd: (context: SelectedContext) => void;
  /** The learner explains the selection in their own words; the assistant checks. */
  onExplainYourself: (context: SelectedContext) => void;
  /** Coach mode: a hint toward the selection's meaning. Direct mode: an explanation. */
  onAsk: (context: SelectedContext) => void;
  coaching: boolean;
  /** Present only when the selection can be turned into a PDF highlight. */
  onHighlight?: (context: SelectedContext) => void;
  onNote?: (context: SelectedContext) => void;
}) {
  const copy = useAppCopy();
  if (!props.state) return null;
  const { context, x, y } = props.state;
  const canAnnotate = context.sourceType === "pdf-page" && Boolean(context.pageSize) && Boolean(props.onHighlight || props.onNote);
  return (
    <div
      className="selection-toolbar"
      role="toolbar"
      aria-label={copy.agent.selectionToolbarAria}
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {canAnnotate && props.onHighlight && (
        <button type="button" className="selection-toolbar-annotate" onClick={() => props.onHighlight?.(context)}>
          {copy.annotations.highlight}
        </button>
      )}
      {canAnnotate && props.onNote && (
        <button type="button" className="selection-toolbar-annotate" onClick={() => props.onNote?.(context)}>
          {copy.annotations.addNote}
        </button>
      )}
      {canAnnotate && <span className="selection-toolbar-divider" aria-hidden="true" />}
      <button type="button" className="selection-toolbar-primary" onClick={() => props.onExplainYourself(context)}>
        {copy.agent.explainYourself}
      </button>
      <button type="button" onClick={() => props.onAsk(context)}>
        {props.coaching ? copy.agent.hintSelection : copy.agent.explainSelection}
      </button>
      <button type="button" onClick={() => props.onAdd(context)}>
        {copy.agent.addToConversation}
      </button>
    </div>
  );
}
