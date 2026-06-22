import type { AppCopy } from "../../i18n";
import type { ModelRef, UiPreferences } from "../../settings";
import type { SelectedContext } from "../../hooks/usePageSelection";
import { requestJson } from "../http/requestJson";
import type { PdfDirectFileInput } from "../pdf/directFile";
import type { PdfContextPayload } from "../pdf/textExtraction";
import type { ChatMessageStatus } from "../persistence";
import { streamAssistantText } from "./streaming";

export type ThreadAssistantMessagePart = { type: "text"; text: string };

export type ChatModelMessage = {
  id?: string;
  role: string;
  content?: unknown[];
  createdAt?: Date;
};

export type ChatModelRunOptions = {
  messages: ChatModelMessage[];
  unstable_assistantMessageId?: string;
  abortSignal: AbortSignal;
};

export type ChatModelAdapter = {
  run(options: ChatModelRunOptions): AsyncGenerator<{
    content: ThreadAssistantMessagePart[];
    status: unknown;
  }>;
};

export type AgentContextItem = {
  id: string;
  type: "page" | "selection" | "formula" | "pdf_reference";
  title: string;
  source: string;
  page_no: number;
  text: string;
};

export type AgentAttachment = {
  id: string;
  type: "image";
  name: string;
  mime: string;
  size: number;
  data_url: string;
};

export type AgentSnapshot = {
  contexts: AgentContextItem[];
  attachments: AgentAttachment[];
  selectedContext: SelectedContext | null;
  pdfContext: PdfContextPayload | null;
  answerMode: UiPreferences["agentAnswerMode"];
  reasoningEffort: UiPreferences["modelReasoningEffort"];
  assistantModel: ModelRef;
};

export type ChatPersistInput = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: ChatMessageStatus;
  createdAt?: number;
  selectedContext?: Record<string, unknown> | null;
  sourceRefs?: Record<string, unknown>[];
};

type AgentPagePack = {
  document: {
    id: string;
    title: string;
    source_pdf_url: string;
    page_count: number;
  };
};

type AgentPageData = {
  page_no: number;
  [key: string]: unknown;
};

export function createPdfAgentAdapter(args: {
  getSnapshot: () => AgentSnapshot;
  getDocumentFile?: () => Promise<PdfDirectFileInput | null>;
  getPack: () => AgentPagePack;
  getPage: () => AgentPageData;
  copy: AppCopy;
  createId: (prefix: string) => string;
  isBackendOffline: () => boolean;
  clearSelectedContext: () => void;
  persistChatMessage?: (input: ChatPersistInput) => Promise<void>;
}): ChatModelAdapter {
  return {
    async *run(options: ChatModelRunOptions) {
      const snapshot = args.getSnapshot();
      const pack = args.getPack();
      const page = args.getPage();
      const selectedAgentContext = snapshot.selectedContext
        ? selectedContextToAgentContext(snapshot.selectedContext, args.copy)
        : null;
      const selectedPdfSourceContext = snapshot.selectedContext
        ? selectedContextPdfSourceContext(snapshot.selectedContext, args.copy)
        : null;
      const documentFile = await args.getDocumentFile?.().catch(() => null) || null;
      const latestUser = [...options.messages].reverse().find((message) => message.role === "user");
      const latestUserText = latestUser ? messageText(latestUser) : "";
      const promptInput = buildSelectedQuestionPrompt(latestUserText, snapshot.selectedContext, snapshot.pdfContext, args.copy);
      const latestUserMeta = latestUser as { id?: string; createdAt?: Date };
      const assistantMessageId = options.unstable_assistantMessageId || args.createId("assistant");
      const selectedContextRecord = snapshot.selectedContext ? asPersistedRecord(selectedContextPayload(snapshot.selectedContext)) : null;
      const sourceRefs = [
        ...(selectedAgentContext ? [asPersistedRecord(selectedAgentContext)] : []),
        ...(selectedPdfSourceContext ? [asPersistedRecord(selectedPdfSourceContext)] : []),
        ...snapshot.contexts.map((context) => asPersistedRecord(context)),
      ];
      let persistQueue = Promise.resolve();
      let lastPartialSaveAt = 0;
      const enqueuePersist = (input: ChatPersistInput) => {
        persistQueue = persistQueue
          .then(() => args.persistChatMessage?.(input))
          .catch(() => undefined);
        return persistQueue;
      };
      if (latestUserText) {
        await enqueuePersist({
          id: latestUserMeta.id || args.createId("user"),
          role: "user",
          content: latestUserText,
          status: "completed",
          createdAt: latestUserMeta.createdAt?.getTime?.() || Date.now(),
          selectedContext: selectedContextRecord,
          sourceRefs,
        });
      }
      await enqueuePersist({
        id: assistantMessageId,
        role: "assistant",
        content: "",
        status: "pending",
        selectedContext: selectedContextRecord,
        sourceRefs,
      });
      const persistPartial = (content: string, status: ChatMessageStatus, force = false) => {
        const now = Date.now();
        if (!force && now - lastPartialSaveAt < 420) return;
        lastPartialSaveAt = now;
        void enqueuePersist({
          id: assistantMessageId,
          role: "assistant",
          content,
          status,
          selectedContext: selectedContextRecord,
          sourceRefs,
        });
      };

      const parts = [
        promptInput ? { type: "text", text: promptInput } : null,
        selectedAgentContext
          ? {
              type: "quote",
              title: selectedAgentContext.title,
              text: selectedAgentContext.text,
              source: {
                kind: selectedAgentContext.source,
                page_no: selectedAgentContext.page_no,
                document_id: pack.document.id,
                source_type: snapshot.selectedContext?.sourceType,
                pdf_source: snapshot.selectedContext?.pdfSource || null,
              },
            }
          : null,
        selectedPdfSourceContext
          ? {
              type: "pdf_reference",
              title: selectedPdfSourceContext.title,
              text: selectedPdfSourceContext.text,
              source: {
                kind: selectedPdfSourceContext.source,
                page_no: selectedPdfSourceContext.page_no,
                document_id: pack.document.id,
                source_type: "pdf-page",
                relation: "corresponding_pdf_source_for_selected_explanation",
              },
            }
          : null,
        ...snapshot.contexts.map((context) => ({
          type: context.type === "formula" ? "quote" : "pdf_reference",
          title: context.title,
          text: context.text,
          source: {
            kind: context.source,
            page_no: context.page_no,
            document_id: pack.document.id,
          },
        })),
        ...snapshot.attachments.map((attachment) => ({
          type: "file",
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
          data_url: attachment.data_url,
        })),
      ].filter(Boolean);

      const payload = {
        modelProviderId: snapshot.assistantModel.providerId,
        model: snapshot.assistantModel.model,
        answerMode: snapshot.answerMode,
        reasoningEffort: snapshot.reasoningEffort,
        document: pack.document,
        documentFile,
        page,
        messages: options.messages.map((message) => ({
          role: message.role,
          status: "success",
          content: messageText(message),
          parts: [{ type: "text", text: messageText(message) }],
        })),
        input: promptInput,
        parts,
        attachments: snapshot.attachments,
        context: [
          ...(selectedAgentContext ? [selectedAgentContext] : []),
          ...(selectedPdfSourceContext ? [selectedPdfSourceContext] : []),
          ...snapshot.contexts,
        ],
        selectedContext: snapshot.selectedContext ? selectedContextPayload(snapshot.selectedContext) : null,
        pdfContext: snapshot.pdfContext,
      };

      try {
        const response = await requestJson<{ message?: { content?: string }; content?: string }>(
          "/api/agent/chat",
          {
            method: "POST",
            body: JSON.stringify(payload),
            signal: options.abortSignal,
          },
          args.copy.errors.accountNotFound,
        );
        const content = response.message?.content || response.content;
        if (!content) throw new Error(args.copy.errors.emptyGatewayResult);
        for await (const partial of streamAssistantText(content, options.abortSignal, args.copy.errors.generationStopped)) {
          persistPartial(partial, "streaming");
          yield {
            content: [{ type: "text", text: partial }] satisfies ThreadAssistantMessagePart[],
            status: { type: "running" },
          };
        }
        persistPartial(content, "completed", true);
        await persistQueue;
        yield {
          content: [{ type: "text", text: content }] satisfies ThreadAssistantMessagePart[],
          status: { type: "complete", reason: "stop" },
        };
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          persistPartial("", "stopped", true);
          await persistQueue;
          throw error;
        }
        if (!args.isBackendOffline()) {
          const failureText = agentFailureText(error, args.copy);
          persistPartial(failureText, "failed", true);
          await persistQueue;
          yield {
            content: [{ type: "text", text: failureText }] satisfies ThreadAssistantMessagePart[],
            status: { type: "running" },
          };
          throw new Error(failureText);
        }
        try {
          const local = [
            args.copy.agent.localPreviewIntro,
            selectedAgentContext ? args.copy.agent.localPreviewSelected(selectedAgentContext.title) : "",
            snapshot.contexts.length ? args.copy.agent.localPreviewContexts(snapshot.contexts.length) : args.copy.agent.localPreviewPage(page.page_no),
            snapshot.attachments.length ? args.copy.agent.localPreviewImages(snapshot.attachments.length) : "",
            latestUserText ? args.copy.agent.localPreviewQuestion(latestUserText) : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          for await (const partial of streamAssistantText(local, options.abortSignal, args.copy.errors.generationStopped)) {
            persistPartial(partial, "streaming");
            yield {
              content: [{ type: "text", text: partial }] satisfies ThreadAssistantMessagePart[],
              status: { type: "running" },
            };
          }
          persistPartial(local, "completed", true);
          await persistQueue;
          yield {
            content: [{ type: "text", text: local }] satisfies ThreadAssistantMessagePart[],
            status: { type: "complete", reason: "stop" },
          };
        } catch (localError) {
          persistPartial((localError as Error).name === "AbortError" ? "" : (localError as Error).message, (localError as Error).name === "AbortError" ? "stopped" : "failed", true);
          await persistQueue;
          throw localError;
        }
      } finally {
        args.clearSelectedContext();
      }
    },
  };
}

export function selectedContextPayload(context: SelectedContext) {
  return {
    id: context.id,
    text: context.text,
    sourceType: context.sourceType,
    documentTitle: context.documentTitle,
    pageNumber: context.pageNumber,
    pdfPageNumber: context.pdfPageNumber,
    generatedPageNumber: context.generatedPageNumber,
    sectionTitle: context.sectionTitle,
    messageId: context.messageId,
    rect: context.rect,
    selectionRects: context.selectionRects,
    viewportScale: context.viewportScale,
    viewportRotation: context.viewportRotation,
    pdfSource: context.pdfSource,
  };
}

function selectedContextToAgentContext(context: SelectedContext, copy: AppCopy): AgentContextItem {
  const pageNo = context.pdfPageNumber || context.generatedPageNumber || context.pageNumber || 1;
  return {
    id: context.id,
    type: detectContextType(context.text),
    title: selectedContextSourceLabel(context, copy),
    source: context.sectionTitle || selectedContextSourceLabel(context, copy),
    page_no: pageNo,
    text: context.text,
  };
}

function selectedContextPdfSourceContext(context: SelectedContext, copy: AppCopy): AgentContextItem | null {
  const pdfSource = context.pdfSource;
  if (!pdfSource?.pageNumber || !pdfSource.text?.trim()) return null;
  return {
    id: `${context.id}:pdf-source`,
    type: "pdf_reference",
    title: copy.common.sourcePdfPage(pdfSource.pageNumber),
    source: pdfSource.title || pdfSource.ref || copy.common.sourcePdfPage(pdfSource.pageNumber),
    page_no: pdfSource.pageNumber,
    text: pdfSource.text,
  };
}

function selectedContextSourceLabel(context: SelectedContext, copy: AppCopy) {
  if (context.sourceType === "pdf-page") return copy.agent.selectedPdfPage(context.pdfPageNumber || context.pageNumber || "?");
  if (context.sourceType === "generated-explanation") return copy.agent.selectedNotesPage(context.generatedPageNumber || context.pageNumber || "?");
  if (context.sourceType === "assistant-message") return copy.agent.assistantMessage;
  if (context.sourceType === "page") return copy.agent.pageSource(context.pageNumber || "?");
  return copy.common.selectedContent;
}

function buildSelectedQuestionPrompt(
  question: string,
  selectedContext: SelectedContext | null,
  pdfContext: PdfContextPayload | null,
  copy: AppCopy,
) {
  const userQuestion = question.trim() || copy.agent.continuePrompt;
  if (!selectedContext?.text.trim()) return userQuestion;
  const selectedPage = selectedContextPageNumber(selectedContext);
  const pdfSource = selectedContext.pdfSource;
  const sourceLines = [
    selectedContext.sourceType === "generated-explanation" && selectedContext.generatedPageNumber
      ? `Selected explanation page: ${selectedContext.generatedPageNumber}`
      : null,
    selectedPage
      ? selectedContext.sourceType === "generated-explanation"
        ? `Corresponding original PDF page: ${selectedPage}`
        : `PDF page: ${selectedPage}`
      : null,
    selectedContext.sectionTitle ? `Source: ${selectedContext.sectionTitle}` : null,
    pdfSource?.title ? `PDF page title: ${pdfSource.title}` : null,
    pdfSource?.ref ? `PDF page reference: ${pdfSource.ref}` : null,
  ].filter((line): line is string => Boolean(line));
  if (pdfContext?.truncated) {
    const includedPages = formatPageRanges(pdfContext.includedPageNumbers);
    const selectedIncluded = selectedPage ? pdfContext.includedPageNumbers.includes(selectedPage) : false;
    sourceLines.push(
      `PDF context is truncated: original PDF has ${pdfContext.pageCount} pages, configured full-context limit is ${pdfContext.fullPageLimit} pages, and the model received pages ${includedPages || "none"} (${pdfContext.edgePageCount} pages from each edge).`,
    );
    if (selectedPage) {
      sourceLines.push(
        selectedIncluded
          ? `The selected text is on PDF page ${selectedPage}, which is included in the truncated PDF context.`
          : `The selected text is on PDF page ${selectedPage}, which is outside the truncated PDF context; use the selected text as the exact evidence for that page.`,
      );
    }
  }
  const promptSections = [
    "Selected source:",
    ...sourceLines,
    selectedContext.sourceType === "generated-explanation" ? "Selected explanation text:" : "Selected text:",
    selectedContext.text.trim(),
  ];
  if (pdfSource?.text?.trim()) {
    promptSections.push(
      "Corresponding original PDF page text:",
      truncatePromptContext(pdfSource.text),
    );
  }
  promptSections.push("User question:", userQuestion);
  return promptSections.join("\n\n");
}

function selectedContextPageNumber(context: SelectedContext | null) {
  if (!context) return null;
  const pageNo = context.pdfPageNumber || context.generatedPageNumber || context.pageNumber;
  return typeof pageNo === "number" && Number.isFinite(pageNo) ? pageNo : null;
}

function formatPageRanges(pages: number[]) {
  const sorted = Array.from(new Set(pages)).sort((left, right) => left - right);
  const ranges: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  for (const pageNo of sorted) {
    if (start === null || previous === null || pageNo !== previous + 1) {
      if (start !== null && previous !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
      start = pageNo;
    }
    previous = pageNo;
  }
  if (start !== null && previous !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(", ");
}

function truncatePromptContext(text: string, max = 6000) {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[Truncated to keep the selected prompt concise.]`;
}

function detectContextType(text: string): AgentContextItem["type"] {
  return /(\$\$?[^$]+\$\$?|\\\(|\\\[|\\begin\{|[∑∫√∞≈≠≤≥πθλμ])/.test(text)
    ? "formula"
    : "selection";
}

function messageText(message: unknown): string {
  const msg = message as { content?: unknown[]; role?: string };
  return (msg.content || [])
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === "text" ? p.text || "" : "";
    })
    .join("\n")
    .trim();
}

function agentFailureText(error: unknown, copy: AppCopy) {
  const message = error instanceof Error ? error.message.trim() : String(error || "").trim();
  if (!message || message === copy.agent.generationFailed) return copy.agent.generationFailed;
  return `${copy.agent.generationFailed}\n\n${message}`;
}

function asPersistedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
