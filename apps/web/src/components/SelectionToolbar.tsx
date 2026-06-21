import { useAppCopy } from "../lib/contexts";
import type { SelectedContext, SelectionToolbarState } from "../hooks/usePageSelection";

export function SelectionToolbar(props: {
  state: SelectionToolbarState | null;
  onAdd: (context: SelectedContext) => void;
  onExplain: (context: SelectedContext) => void;
  onSummarize: (context: SelectedContext) => void;
}) {
  const copy = useAppCopy();
  if (!props.state) return null;
  const { context, x, y } = props.state;
  return (
    <div
      className="selection-toolbar"
      role="toolbar"
      aria-label={copy.agent.selectionToolbarAria}
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={() => props.onAdd(context)}>
        {copy.agent.addToConversation}
      </button>
      <button type="button" onClick={() => props.onExplain(context)}>
        {copy.agent.explainSelection}
      </button>
      <button type="button" onClick={() => props.onSummarize(context)}>
        {copy.agent.summarizeSelection}
      </button>
    </div>
  );
}
