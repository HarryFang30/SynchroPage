import type { AnnotationRecord } from "../../lib/persistence";

/**
 * Marker-style highlight boxes drawn under the PDF text layer. Positions are
 * page fractions, so the layer needs no knowledge of the current zoom.
 */
export function PageHighlightLayer({
  annotations,
  activeId,
  label,
}: {
  annotations: AnnotationRecord[];
  activeId: string | null;
  label: string;
}) {
  const highlights = annotations.filter((annotation) => annotation.rects.length > 0);
  if (!highlights.length) return null;
  return (
    <div className="pdf-highlight-layer" aria-label={label} role="presentation">
      {highlights.map((annotation) =>
        annotation.rects.map((rect, index) => (
          <span
            key={`${annotation.id}:${index}`}
            className={`pdf-highlight ${annotation.id === activeId ? "active" : ""}`}
            data-color={annotation.color}
            data-annotation-id={annotation.id}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        )),
      )}
    </div>
  );
}
