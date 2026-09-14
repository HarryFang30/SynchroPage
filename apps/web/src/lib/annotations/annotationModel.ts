import type { AnnotationColor, AnnotationRecord, AnnotationRect } from "../persistence/schema";

export const ANNOTATION_COLORS: AnnotationColor[] = ["yellow", "green", "blue", "pink"];
export const annotationColorStorageKey = "synchropage.annotationColor.v1";
export const DEFAULT_ANNOTATION_COLOR: AnnotationColor = "yellow";

export function isAnnotationColor(value: unknown): value is AnnotationColor {
  return typeof value === "string" && (ANNOTATION_COLORS as string[]).includes(value);
}

/** The colour used by the next "Highlight" action (remembered per browser). */
export function loadPreferredAnnotationColor(): AnnotationColor {
  try {
    const raw = window.localStorage.getItem(annotationColorStorageKey);
    return isAnnotationColor(raw) ? raw : DEFAULT_ANNOTATION_COLOR;
  } catch {
    return DEFAULT_ANNOTATION_COLOR;
  }
}

export function savePreferredAnnotationColor(color: AnnotationColor) {
  try {
    window.localStorage.setItem(annotationColorStorageKey, color);
  } catch {
    // Private mode or blocked storage: the preference is only a convenience.
  }
}

type PixelRect = { x: number; y: number; width: number; height: number };

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Convert selection client rects (pixels relative to the page layer) into
 * page fractions so a highlight keeps its place at any zoom level. Rects on
 * the same text line are merged into one bar; slivers are dropped.
 */
export function normalizeSelectionRects(rects: PixelRect[], pageWidth: number, pageHeight: number): AnnotationRect[] {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return [];
  const fractional = rects
    .filter((rect) => rect.width > 1 && rect.height > 1)
    .map((rect) => ({
      x: clamp01(rect.x / pageWidth),
      y: clamp01(rect.y / pageHeight),
      width: clamp01(rect.width / pageWidth),
      height: clamp01(rect.height / pageHeight),
    }))
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const merged: AnnotationRect[] = [];
  for (const rect of fractional) {
    const last = merged[merged.length - 1];
    if (last && sameLine(last, rect)) {
      const x = Math.min(last.x, rect.x);
      const y = Math.min(last.y, rect.y);
      const right = Math.max(last.x + last.width, rect.x + rect.width);
      const bottom = Math.max(last.y + last.height, rect.y + rect.height);
      merged[merged.length - 1] = { x, y, width: right - x, height: bottom - y };
      continue;
    }
    merged.push({ ...rect });
  }
  return merged.map((rect) => ({
    x: round4(rect.x),
    y: round4(rect.y),
    width: round4(rect.width),
    height: round4(rect.height),
  }));
}

function sameLine(left: AnnotationRect, right: AnnotationRect) {
  const overlap = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  const minHeight = Math.min(left.height, right.height);
  return minHeight > 0 && overlap / minHeight >= 0.5;
}

/** Vertical position used to order notes the way they appear on the page. */
export function annotationTop(annotation: Pick<AnnotationRecord, "rects">) {
  if (!annotation.rects.length) return 1;
  return Math.min(...annotation.rects.map((rect) => rect.y));
}

export function sortAnnotations(list: AnnotationRecord[]) {
  return [...list].sort(
    (left, right) =>
      left.pageNumber - right.pageNumber ||
      annotationTop(left) - annotationTop(right) ||
      left.createdAt - right.createdAt,
  );
}

export function groupAnnotationsByPage(list: AnnotationRecord[]) {
  const groups = new Map<number, AnnotationRecord[]>();
  for (const annotation of sortAnnotations(list)) {
    const bucket = groups.get(annotation.pageNumber);
    if (bucket) {
      bucket.push(annotation);
    } else {
      groups.set(annotation.pageNumber, [annotation]);
    }
  }
  return groups;
}

/** Smallest highlight whose rects contain `point` (page fractions), if any. */
export function annotationHitTest(list: AnnotationRecord[], point: { x: number; y: number }, padding = 0.004) {
  let best: AnnotationRecord | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const annotation of list) {
    for (const rect of annotation.rects) {
      const inside =
        point.x >= rect.x - padding &&
        point.x <= rect.x + rect.width + padding &&
        point.y >= rect.y - padding &&
        point.y <= rect.y + rect.height + padding;
      if (!inside) continue;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = annotation;
        bestArea = area;
      }
    }
  }
  return best;
}

export function compactQuote(quote: string, max = 180) {
  const text = quote.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function annotationsToMarkdown(
  documentTitle: string,
  list: AnnotationRecord[],
  labels: { title: (documentTitle: string) => string; page: (pageNo: number) => string; emptyNote: string },
) {
  const lines: string[] = [`# ${labels.title(documentTitle)}`, ""];
  for (const [pageNo, items] of groupAnnotationsByPage(list)) {
    lines.push(`## ${labels.page(pageNo)}`, "");
    for (const item of items) {
      if (item.quote.trim()) {
        for (const quoteLine of item.quote.replace(/\s+/g, " ").trim().split(/\n/)) {
          lines.push(`> ${quoteLine}`);
        }
        lines.push("");
      }
      lines.push(item.note.trim() || labels.emptyNote, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatAnnotationTime(timestamp: number, language: string) {
  try {
    return new Intl.DateTimeFormat(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}
