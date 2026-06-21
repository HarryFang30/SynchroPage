export async function* streamAssistantText(text: string, signal: AbortSignal, stopMessage: string) {
  let partial = "";
  for (const chunk of chunkAssistantText(text)) {
    if (signal.aborted) throw new DOMException(stopMessage, "AbortError");
    partial += chunk;
    yield partial;
    await new Promise((resolve) => window.setTimeout(resolve, 12));
  }
}

export function chunkAssistantText(text: string) {
  if (!text) return [text];
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += 24) {
    chunks.push(chars.slice(index, index + 24).join(""));
  }
  return chunks;
}
