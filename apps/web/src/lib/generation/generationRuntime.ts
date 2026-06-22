import {
  normalizeTeachingOutputLanguage,
  type AsyncLimiterPriority,
  type GeneratedTeachingPageResponse,
  type PageData,
  type PagePack,
  type TeachingOutputLanguage,
} from "./teachingGeneration";

export type GenerationPageStatus = "done" | "running" | "retrying" | "failed" | "pending";

export function normalizeGeneratedPage(rawPage: GeneratedTeachingPageResponse["page"], fallback: PageData): PageData {
  const rawSource: Partial<PageData["source"]> = rawPage.source ?? {};
  const rawTeaching = (rawPage.teaching || rawPage) as Partial<PageData["teaching"]> & {
    title?: string;
    notes?: string;
  };
  const rawPageNo = Number(rawPage.page_no || fallback.page_no);
  const normalized: PageData = {
    page_no: Number.isFinite(rawPageNo) ? rawPageNo : fallback.page_no,
    source: {
      pdf_page_ref: rawSource.pdf_page_ref || `#page=${rawPage.page_no || fallback.page_no}`,
      text_md: rawSource.text_md || "",
      ocr_used: Boolean(rawSource.ocr_used),
      parser: rawSource.parser || "imported",
      page_type: rawSource.page_type,
    },
    teaching: {
      output_language: normalizeTeachingOutputLanguage(rawTeaching.output_language),
      slide_title: rawTeaching.slide_title || rawTeaching.title || "",
      speaker_notes_md: rawTeaching.speaker_notes_md || rawTeaching.notes || "",
      concepts: Array.isArray(rawTeaching.concepts) ? rawTeaching.concepts : [],
      visual_explanations: Array.isArray(rawTeaching.visual_explanations)
        ? rawTeaching.visual_explanations
        : [],
      prerequisites: Array.isArray(rawTeaching.prerequisites) ? rawTeaching.prerequisites : [],
      contextual_bridge: rawTeaching.contextual_bridge || "",
      formula_explanations: Array.isArray(rawTeaching.formula_explanations) ? rawTeaching.formula_explanations : [],
      evidence: Array.isArray(rawTeaching.evidence) ? rawTeaching.evidence : [],
      needs_review: Boolean(rawTeaching.needs_review),
      needs_parser_fallback: Boolean(rawTeaching.needs_parser_fallback),
      confidence: Number(rawTeaching.confidence ?? 0.72),
    },
    status: rawPage.status || "ready",
  };
  return {
    ...fallback,
    ...normalized,
    page_no: fallback.page_no,
    source: {
      ...fallback.source,
      ...normalized.source,
      pdf_page_ref: normalized.source.pdf_page_ref || fallback.source.pdf_page_ref || `#page=${fallback.page_no}`,
      text_md: fallback.source.text_md || normalized.source.text_md,
      ocr_used: Boolean(normalized.source.ocr_used || fallback.source.ocr_used),
      parser: normalized.source.parser || fallback.source.parser || "pdfjs",
    },
    teaching: {
      ...fallback.teaching,
      ...normalized.teaching,
      slide_title: normalized.teaching.slide_title || fallback.teaching.slide_title || `PDF p.${fallback.page_no}`,
      speaker_notes_md: normalized.teaching.speaker_notes_md || fallback.teaching.speaker_notes_md,
      concepts: normalized.teaching.concepts.length ? normalized.teaching.concepts : fallback.teaching.concepts,
      visual_explanations: normalized.teaching.visual_explanations.length ? normalized.teaching.visual_explanations : fallback.teaching.visual_explanations,
      prerequisites: normalized.teaching.prerequisites.length ? normalized.teaching.prerequisites : fallback.teaching.prerequisites,
      confidence: Number.isFinite(normalized.teaching.confidence) ? normalized.teaching.confidence : fallback.teaching.confidence,
    },
    status: normalized.status || "ready",
  };
}

export function mergePageIntoPack(pack: PagePack, page: PageData): PagePack {
  const pages = pack.pages.some((item) => item.page_no === page.page_no)
    ? pack.pages.map((item) => (item.page_no === page.page_no ? page : item))
    : [...pack.pages, page];
  return {
    ...pack,
    document: {
      ...pack.document,
      page_count: Math.max(pack.document.page_count || 0, pages.length, page.page_no),
    },
    pages: pages.slice().sort((left, right) => left.page_no - right.page_no),
  };
}

export function pageWithSourceText(page: PageData, sourceText: string): PageData {
  return {
    ...page,
    source: {
      ...page.source,
      text_md: sourceText || page.source.text_md,
      parser: page.source.parser || "pdfjs",
    },
  };
}

export function missingSourceTextPageNumbers(pageNumbers: number[], sourceTextByPage: Map<number, string>) {
  return pageNumbers.filter((pageNo) => !(sourceTextByPage.get(pageNo) || "").trim());
}

export function hasCompletedTeaching(page: PageData | undefined, outputLanguage?: TeachingOutputLanguage) {
  if (!page) return false;
  if (page.status === "failed" || page.status === "running" || page.status === "retrying" || !page.teaching.speaker_notes_md.trim()) return false;
  return !outputLanguage || page.teaching.output_language === outputLanguage;
}

export function generationPageStatus(page: PageData | undefined, outputLanguage?: TeachingOutputLanguage): GenerationPageStatus {
  if (!page) return "pending";
  if (page.status === "running") return "running";
  if (page.status === "retrying") return "retrying";
  if (page.status === "failed") return "failed";
  if (!page.teaching.speaker_notes_md.trim()) return "pending";
  if (outputLanguage && page.teaching.output_language !== outputLanguage) return "pending";
  return "done";
}

export async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { continueOnError?: boolean } = {},
) {
  if (!items.length) return [];
  const concurrency = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let nextIndex = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        if (!options.continueOnError) throw error;
        errors.push(error);
      }
    }
  }));
  return errors;
}

export function createAsyncLimiter(limit: number) {
  const concurrency = Math.max(1, Math.floor(limit));
  type QueuedTask = {
    priority: AsyncLimiterPriority;
    signal?: AbortSignal;
    start: () => void;
    reject: (error: unknown) => void;
    abortHandler?: () => void;
  };
  const queues: Record<AsyncLimiterPriority, QueuedTask[]> = {
    now: [],
    next: [],
    later: [],
  };
  const priorityOrder: AsyncLimiterPriority[] = ["now", "next", "later"];
  let active = 0;

  const dequeue = () => {
    for (const priority of priorityOrder) {
      const task = queues[priority].shift();
      if (task) return task;
    }
    return undefined;
  };

  const removeQueuedTask = (task: QueuedTask) => {
    const queue = queues[task.priority];
    const index = queue.indexOf(task);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  };

  const cleanupTask = (task: QueuedTask) => {
    if (task.abortHandler) task.signal?.removeEventListener("abort", task.abortHandler);
    task.abortHandler = undefined;
  };

  const drain = () => {
    while (active < concurrency) {
      const task = dequeue();
      if (!task) return;
      cleanupTask(task);
      if (task.signal?.aborted) {
        task.reject(abortError());
        continue;
      }
      active += 1;
      task.start();
    }
  };

  const release = () => {
    active = Math.max(0, active - 1);
    drain();
  };

  return function runLimited<T>(
    worker: () => Promise<T>,
    options: { priority?: AsyncLimiterPriority; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask = {
        priority: options.priority || "next",
        signal: options.signal,
        reject,
        start: () => {
          void worker()
            .then(resolve, reject)
            .finally(release);
        },
      };
      if (task.signal) {
        task.abortHandler = () => {
          if (removeQueuedTask(task)) {
            cleanupTask(task);
            reject(abortError());
          }
        };
        task.signal.addEventListener("abort", task.abortHandler, { once: true });
      }
      queues[task.priority].push(task);
      drain();
    });
  };
}

function abortError(message = "Generation canceled") {
  return new DOMException(message, "AbortError");
}
