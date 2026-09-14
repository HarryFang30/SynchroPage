import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRecordId,
  deleteAnnotation,
  loadDocumentAnnotations,
  saveAnnotation,
  type AnnotationColor,
  type AnnotationRecord,
  type AnnotationRect,
} from "../lib/persistence";
import {
  groupAnnotationsByPage,
  loadPreferredAnnotationColor,
  savePreferredAnnotationColor,
  sortAnnotations,
} from "../lib/annotations/annotationModel";

const NOTE_SAVE_DEBOUNCE_MS = 600;

export type AnnotationDraft = {
  pageNumber: number;
  kind: AnnotationRecord["kind"];
  quote?: string;
  rects?: AnnotationRect[];
  note?: string;
  color?: AnnotationColor;
};

/**
 * Highlights and margin notes for the open document.
 *
 * Structural changes (create, delete, recolour) persist immediately through
 * `persist` so the save pill reflects them; note text is saved in the
 * background with a short debounce so typing never waits on IndexedDB.
 */
export function useDocumentAnnotations(input: {
  workspaceId: string | null;
  documentId: string | null;
  persist: <T>(operation: () => Promise<T>) => Promise<T>;
  onError: (message: string) => void;
}) {
  const { workspaceId, documentId, persist, onError } = input;
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusRequestId, setFocusRequestId] = useState<string | null>(null);
  const [preferredColor, setPreferredColorState] = useState<AnnotationColor>(() => loadPreferredAnnotationColor());
  const annotationsRef = useRef(annotations);
  const pendingTimersRef = useRef(new Map<string, number>());
  const onErrorRef = useRef(onError);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const flushPending = useCallback(() => {
    const timers = pendingTimersRef.current;
    for (const [id, timer] of timers) {
      window.clearTimeout(timer);
      timers.delete(id);
      const record = annotationsRef.current.find((item) => item.id === id);
      if (record) {
        void saveAnnotation(record).catch((error: unknown) => {
          onErrorRef.current((error as Error).message || String(error));
        });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    flushPending();
    setActiveId(null);
    setFocusRequestId(null);
    if (!documentId) {
      setAnnotations([]);
      return undefined;
    }
    void loadDocumentAnnotations(documentId)
      .then((list) => {
        if (!cancelled) setAnnotations(sortAnnotations(list));
      })
      .catch((error: unknown) => {
        if (!cancelled) onErrorRef.current((error as Error).message || String(error));
      });
    return () => {
      cancelled = true;
      flushPending();
    };
  }, [documentId, flushPending]);

  useEffect(() => flushPending, [flushPending]);

  const byPage = useMemo(() => groupAnnotationsByPage(annotations), [annotations]);

  const setPreferredColor = useCallback((color: AnnotationColor) => {
    setPreferredColorState(color);
    savePreferredAnnotationColor(color);
  }, []);

  const add = useCallback(async (draft: AnnotationDraft) => {
    if (!workspaceId || !documentId) return null;
    const now = Date.now();
    const record: AnnotationRecord = {
      id: createRecordId("annotation"),
      workspaceId,
      documentId,
      pageNumber: Math.max(1, Math.round(draft.pageNumber)),
      kind: draft.kind,
      color: draft.color || preferredColor,
      quote: draft.quote || "",
      rects: draft.rects || [],
      note: draft.note || "",
      createdAt: now,
      updatedAt: now,
    };
    setAnnotations((current) => sortAnnotations([...current, record]));
    setActiveId(record.id);
    try {
      await persist(() => saveAnnotation(record));
    } catch (error) {
      setAnnotations((current) => current.filter((item) => item.id !== record.id));
      onErrorRef.current((error as Error).message || String(error));
      return null;
    }
    return record;
  }, [documentId, persist, preferredColor, workspaceId]);

  const updateNote = useCallback((id: string, note: string) => {
    setAnnotations((current) =>
      current.map((item) => (item.id === id ? { ...item, note, updatedAt: Date.now() } : item)),
    );
    const timers = pendingTimersRef.current;
    const existing = timers.get(id);
    if (existing) window.clearTimeout(existing);
    timers.set(id, window.setTimeout(() => {
      timers.delete(id);
      const record = annotationsRef.current.find((item) => item.id === id);
      if (!record) return;
      void saveAnnotation(record).catch((error: unknown) => {
        onErrorRef.current((error as Error).message || String(error));
      });
    }, NOTE_SAVE_DEBOUNCE_MS));
  }, []);

  const updateColor = useCallback(async (id: string, color: AnnotationColor) => {
    let next: AnnotationRecord | undefined;
    setAnnotations((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        next = { ...item, color, updatedAt: Date.now() };
        return next;
      }),
    );
    setPreferredColor(color);
    const record = next || annotationsRef.current.find((item) => item.id === id);
    if (!record) return;
    try {
      await persist(() => saveAnnotation({ ...record, color }));
    } catch (error) {
      onErrorRef.current((error as Error).message || String(error));
    }
  }, [persist, setPreferredColor]);

  const remove = useCallback(async (id: string) => {
    const timer = pendingTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      pendingTimersRef.current.delete(id);
    }
    const removed = annotationsRef.current.find((item) => item.id === id);
    setAnnotations((current) => current.filter((item) => item.id !== id));
    setActiveId((current) => (current === id ? null : current));
    try {
      await persist(() => deleteAnnotation(id));
    } catch (error) {
      if (removed) setAnnotations((current) => sortAnnotations([...current, removed]));
      onErrorRef.current((error as Error).message || String(error));
    }
  }, [persist]);

  const requestFocus = useCallback((id: string | null) => {
    setActiveId(id);
    setFocusRequestId(id);
  }, []);

  const consumeFocusRequest = useCallback((id: string) => {
    setFocusRequestId((current) => (current === id ? null : current));
  }, []);

  return {
    annotations,
    byPage,
    activeId,
    setActiveId,
    focusRequestId,
    requestFocus,
    consumeFocusRequest,
    preferredColor,
    setPreferredColor,
    add,
    updateNote,
    updateColor,
    remove,
  };
}

export type DocumentAnnotationsApi = ReturnType<typeof useDocumentAnnotations>;
