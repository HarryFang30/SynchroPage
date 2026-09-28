/** A half-written message stays: the prefill starts a new line under it. */
export function composerTextWithPrefill(current: string | undefined, prefill: string) {
  const draft = (current || "").trimEnd();
  if (!draft) return prefill;
  if (draft.endsWith(prefill.trim())) return `${draft} `;
  return `${draft}\n${prefill}`;
}
