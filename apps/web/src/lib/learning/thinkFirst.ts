import type { LessonPlanNoteInfo } from "../generation/lessonPlan";
import type { PageData } from "../generation/teachingGeneration";
import type { AnnotationRecord } from "../persistence/schema";

/**
 * Think first, then compare: each page asks the learner to write their own
 * take before its explanation opens. What they write is a page note that
 * carries the question it answers (`AnnotationRecord.prompt`), so it lives
 * with their other notes, under the PDF page and in the notes tab.
 */

export const revealedPagesStorageKey = "synchropage.revealedPages.v1";
/** Documents remembered in the revealed-pages map; the oldest drop out first. */
const REVEALED_DOCUMENT_LIMIT = 60;

type RevealedPagesStore = Record<string, { pages: number[]; at: number }>;

/** Pages opened this session, so a reveal holds even where localStorage is blocked. */
const sessionRevealed = new Map<string, Set<number>>();

function readStore(): RevealedPagesStore {
  try {
    const raw = window.localStorage.getItem(revealedPagesStorageKey);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as RevealedPagesStore) : {};
  } catch {
    return {};
  }
}

/** Pages of a document whose explanation the learner chose to open without writing first. */
export function loadRevealedPages(documentId: string | null | undefined): Set<number> {
  if (!documentId) return new Set();
  const entry = readStore()[documentId];
  const stored = Array.isArray(entry?.pages) ? entry.pages.filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0) : [];
  return new Set([...stored, ...(sessionRevealed.get(documentId) || [])]);
}

export function rememberRevealedPage(documentId: string | null | undefined, pageNo: number) {
  if (!documentId) return;
  const session = sessionRevealed.get(documentId) || new Set<number>();
  session.add(pageNo);
  sessionRevealed.set(documentId, session);
  try {
    const store = readStore();
    const pages = new Set(store[documentId]?.pages || []);
    pages.add(pageNo);
    store[documentId] = { pages: Array.from(pages).sort((left, right) => left - right), at: Date.now() };
    const kept = Object.entries(store)
      .sort(([, left], [, right]) => (right.at || 0) - (left.at || 0))
      .slice(0, REVEALED_DOCUMENT_LIMIT);
    window.localStorage.setItem(revealedPagesStorageKey, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Blocked storage: the page stays open for this session only.
  }
}

/** Page types with nothing to work out, for documents without a lesson plan. */
const NOTHING_TO_THINK_PAGE_TYPES = new Set(["title", "agenda", "blank"]);

/**
 * Whether a page asks the learner to think before its explanation opens.
 * Pages the lesson plan only skims (a cover, an outline, a section title)
 * have nothing to work out and open directly; without a plan the page type
 * decides. Only saved documents take part: the sample pack is a demo and a
 * reflection could not be kept there.
 */
export function thinkFirstApplies(input: {
  enabled: boolean;
  hasDocument: boolean;
  plan: LessonPlanNoteInfo | undefined;
  page: PageData;
}) {
  if (!input.enabled || !input.hasDocument) return false;
  if (input.plan) return input.plan.depth !== "skim";
  return !NOTHING_TO_THINK_PAGE_TYPES.has(String(input.page.source.page_type || "").trim().toLowerCase());
}

/** The page's own think-first question, when its explanation was generated with one. */
export function pageThinkFirstQuestion(page: PageData) {
  return (page.teaching.question || "").trim();
}

/**
 * The learner's reflection on a page: the first page note that answers a
 * think-first question. Filtered by document, because right after a document
 * switch the annotation list still holds the previous document's notes.
 */
export function pageReflection(annotations: AnnotationRecord[], pageNo: number, documentId: string | null | undefined) {
  if (!documentId) return undefined;
  return annotations.find(
    (item) => item.documentId === documentId && item.pageNumber === pageNo && item.kind === "note" && Boolean(item.prompt?.trim()),
  );
}
