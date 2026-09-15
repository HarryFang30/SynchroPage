/**
 * Lesson plan: one planning pass over the whole document decides, page by
 * page, which segment a page belongs to, what it is for, and how much
 * explaining it deserves. Page generation then follows the plan.
 *
 * Pure module: no React, no DOM.
 */
import { TRANSCRIPTION_PARSER } from "../pdf/textQuality";
import type { PageData, TeachingOutputLanguage } from "./teachingGeneration";

export type LessonPlanDepth = "skim" | "brief" | "full";
export type LessonPlanRole =
  | "title"
  | "agenda"
  | "transition"
  | "concept"
  | "derivation"
  | "example"
  | "exercise"
  | "recap"
  | "summary"
  | "blank";

export type LessonPlanSegment = {
  id: number;
  title: string;
  goal: string;
  /** First and last page of the segment, inclusive. */
  pages: [number, number];
};

export type LessonPlanPage = {
  page_no: number;
  segment: number;
  role: LessonPlanRole;
  depth: LessonPlanDepth;
  /** One of the few pages of the deck worth the most time; may run longer than full. */
  key: boolean;
  /** One line for the teacher: what this page must get across, or why it needs no more. */
  cue: string;
};

export type LessonPlan = {
  version: string;
  model?: string;
  output_language?: TeachingOutputLanguage;
  document_summary: string;
  segments: LessonPlanSegment[];
  pages: LessonPlanPage[];
};

/** The slice of the plan one generation request carries. */
export type LessonPlanRequestSlice = {
  document_summary: string;
  segment?: LessonPlanSegment;
  pages: LessonPlanPage[];
  /** What the previous page left the student with, when it was already taught. */
  handoff: string;
};

/** Role, depth and segment of one page, for the notes header. */
export type LessonPlanNoteInfo = {
  role: LessonPlanRole;
  depth: LessonPlanDepth;
  key: boolean;
  segmentTitle: string;
  segmentStartPage: number;
};

export const LESSON_PLAN_VERSION = "synchropage.lesson-plan.v1";
/** Characters of page text the planner sees per page. */
export const LESSON_PLAN_PAGE_TEXT_CHARS = 400;
/** Pages of one segment taught in one request when no PDF page is attached. */
export const LESSON_PLAN_SEGMENT_CHUNK_PAGES = 8;

const LESSON_PLAN_DEPTHS = new Set<string>(["skim", "brief", "full"]);
const LESSON_PLAN_ROLES = new Set<string>([
  "title", "agenda", "transition", "concept", "derivation", "example", "exercise", "recap", "summary", "blank",
]);
const SKIM_ROLES = new Set<string>(["title", "agenda", "blank", "transition"]);

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function positiveInt(value: unknown) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Coerce a plan from the backend, a persisted record, or an imported pack.
 * Segments are rebuilt by walking the pages in order (mirroring the backend),
 * so they are always consecutive even when the source numbering was not.
 * Returns undefined when nothing usable is there.
 */
export function normalizeLessonPlan(value: unknown): LessonPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const rawSegments = new Map<number, Record<string, unknown>>();
  for (const item of Array.isArray(raw.segments) ? raw.segments : []) {
    if (!item || typeof item !== "object") continue;
    const id = positiveInt((item as Record<string, unknown>).id);
    if (id && !rawSegments.has(id)) rawSegments.set(id, item as Record<string, unknown>);
  }
  const rows = new Map<number, LessonPlanPage>();
  for (const item of Array.isArray(raw.pages) ? raw.pages : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const page_no = positiveInt(row.page_no);
    if (!page_no || rows.has(page_no)) continue;
    const role = (LESSON_PLAN_ROLES.has(String(row.role)) ? String(row.role) : "concept") as LessonPlanRole;
    const depth = (
      LESSON_PLAN_DEPTHS.has(String(row.depth)) ? String(row.depth) : SKIM_ROLES.has(role) ? "skim" : "full"
    ) as LessonPlanDepth;
    rows.set(page_no, {
      page_no,
      segment: positiveInt(row.segment),
      role,
      depth,
      key: Boolean(row.key) && depth === "full",
      cue: cleanText(row.cue),
    });
  }
  const pages = [...rows.values()].sort((left, right) => left.page_no - right.page_no);
  if (!pages.length) return undefined;

  const segments: LessonPlanSegment[] = [];
  let sourceId = 0;
  for (const row of pages) {
    const requested = row.segment || sourceId || 1;
    if (!segments.length || requested !== sourceId) {
      sourceId = requested;
      const source = rawSegments.get(requested);
      segments.push({
        id: segments.length + 1,
        title: cleanText(source?.title) || `Part ${segments.length + 1}`,
        goal: cleanText(source?.goal),
        pages: [row.page_no, row.page_no],
      });
    }
    const current = segments[segments.length - 1];
    current.pages[1] = row.page_no;
    row.segment = current.id;
  }

  const language = raw.output_language === "zh-CN" || raw.output_language === "en-US" ? raw.output_language : undefined;
  const model = cleanText(raw.model);
  return {
    version: cleanText(raw.version) || LESSON_PLAN_VERSION,
    ...(model ? { model } : {}),
    ...(language ? { output_language: language } : {}),
    document_summary: cleanText(raw.document_summary),
    segments,
    pages,
  };
}

export function lessonPlanRow(plan: LessonPlan | undefined, pageNo: number) {
  return plan?.pages.find((row) => row.page_no === pageNo);
}

export function lessonPlanSegmentById(plan: LessonPlan | undefined, segmentId: number) {
  return plan?.segments.find((segment) => segment.id === segmentId);
}

export function lessonPlanDepthForPage(plan: LessonPlan | undefined, pageNo: number): LessonPlanDepth | undefined {
  return lessonPlanRow(plan, pageNo)?.depth;
}

/** A plan written for another explanation language is not reused. */
export function lessonPlanMatchesLanguage(plan: LessonPlan | undefined, language: TeachingOutputLanguage) {
  return Boolean(plan && (!plan.output_language || plan.output_language === language));
}

export function lessonPlanKeyPages(plan: LessonPlan | undefined): ReadonlySet<number> {
  return new Set(plan?.pages.filter((row) => row.key).map((row) => row.page_no) ?? []);
}

export function lessonPlanNoteInfo(plan: LessonPlan | undefined, pageNo: number): LessonPlanNoteInfo | undefined {
  const row = lessonPlanRow(plan, pageNo);
  if (!row) return undefined;
  const segment = lessonPlanSegmentById(plan, row.segment);
  return {
    role: row.role,
    depth: row.depth,
    key: row.key,
    segmentTitle: segment?.title ?? "",
    segmentStartPage: segment?.pages[0] ?? pageNo,
  };
}

/** The plan rows and segment a request for these pages carries. */
export function lessonPlanRequestSlice(
  plan: LessonPlan | undefined,
  pageNumbers: number[],
  handoff = "",
): LessonPlanRequestSlice | undefined {
  if (!plan) return undefined;
  const pages = pageNumbers
    .map((pageNo) => lessonPlanRow(plan, pageNo))
    .filter((row): row is LessonPlanPage => Boolean(row));
  const segment = pages[0] ? lessonPlanSegmentById(plan, pages[0].segment) : undefined;
  return { document_summary: plan.document_summary, segment, pages, handoff };
}

/**
 * Compact page texts for the planning request. A page whose text layer is
 * noise is flagged so the planner judges it from its title and neighbours (or
 * from the attached PDF page); a transcribed page is marked as such.
 */
export function lessonPlanRequestPages(pages: PageData[]) {
  return pages.map((page) => {
    const text = page.source.text_md.replace(/\s+/g, " ").trim();
    const transcribed = page.source.parser === TRANSCRIPTION_PARSER && Boolean(text);
    return {
      page_no: page.page_no,
      text_md: text.length > LESSON_PLAN_PAGE_TEXT_CHARS ? `${text.slice(0, LESSON_PLAN_PAGE_TEXT_CHARS - 1)}…` : text,
      ...(transcribed ? { transcribed: true } : page.source.text_garbled ? { garbled: true } : {}),
    };
  });
}

/** Segment index of a page, for ordering work around the reader's position. */
export function lessonPlanSegmentIndex(plan: LessonPlan | undefined, pageNo: number) {
  if (!plan) return -1;
  const row = lessonPlanRow(plan, pageNo);
  return row ? plan.segments.findIndex((segment) => segment.id === row.segment) : -1;
}
