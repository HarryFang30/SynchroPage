import type { AppCopy } from "../../i18n";
import type { AgentContextItem } from "../../lib/assistant/agentChatAdapter";
import type { SelectedContext } from "../../hooks/usePageSelection";
import { compactText } from "../../lib/workspace/pagePairState";

export function contextSourceLabel(context: AgentContextItem, copy: AppCopy) {
  if (context.type === "formula") return copy.agent.contextFormula(context.page_no);
  if (context.type === "selection") return copy.agent.contextSelection(context.page_no);
  if (context.type === "pdf_reference") return copy.agent.contextPdfReference(context.page_no);
  return copy.agent.contextSource(context.page_no, compactText(context.source || context.title, 28));
}

export function selectedContextSourceLabel(context: SelectedContext, copy: AppCopy) {
  if (context.sourceType === "pdf-page") return copy.agent.selectedPdfPage(context.pdfPageNumber || context.pageNumber || "?");
  if (context.sourceType === "generated-explanation") return copy.agent.selectedNotesPage(context.generatedPageNumber || context.pageNumber || "?");
  if (context.sourceType === "assistant-message") return copy.agent.assistantMessage;
  if (context.sourceType === "page") return copy.agent.pageSource(context.pageNumber || "?");
  return copy.common.selectedContent;
}
