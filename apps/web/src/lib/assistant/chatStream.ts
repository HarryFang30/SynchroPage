import { HttpRequestError, httpRequestErrorFromResponse } from "../http/requestJson";

/** What `/api/agent/chat` reports while an answer is being written. */
export type ChatStreamEvent =
  /** The model is reasoning and has not written any of the answer yet. */
  | { type: "thinking" }
  /** The next piece of the answer. */
  | { type: "delta"; text: string }
  /** The whole answer; `truncated` when it stopped at the output limit or failed midway. */
  | { type: "done"; content: string; truncated: boolean };

type ChatResponseBody = {
  message?: { content?: string };
  content?: string;
  truncated?: boolean;
};

export type ChatStreamMessages = {
  accountNotFound?: string;
  /** Shown when the connection closes before the answer was complete. */
  streamEndedEarly?: string;
};

/**
 * Ask the assistant and read the answer as it is written.
 *
 * The backend streams Server-Sent Events. A backend (or a test double) that
 * answers with plain JSON yields a single `done` event, so callers need no
 * second code path.
 */
export async function* streamAgentChat(
  payload: Record<string, unknown>,
  signal: AbortSignal,
  messages: ChatStreamMessages = {},
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });
  if (!response.ok) throw await httpRequestErrorFromResponse(response, messages.accountNotFound);
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    yield doneEvent((await response.json()) as ChatResponseBody);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() || "";
      for (const line of lines) {
        const event = parseEventLine(line);
        if (!event) continue;
        if (event.type === "done") finished = true;
        yield event;
      }
      if (done) break;
    }
  } finally {
    // Stops the backend (and the model behind it) when the reader gives up.
    void reader.cancel().catch(() => undefined);
  }
  // The connection closed before the answer was complete.
  if (!finished) throw new HttpRequestError(messages.streamEndedEarly || "The answer stream ended early", { status: 502, code: "network_error" });
}

function parseEventLine(line: string): ChatStreamEvent | null {
  if (!line.startsWith("data:")) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line.slice(5)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.type === "delta") return typeof value.text === "string" && value.text ? { type: "delta", text: value.text } : null;
  if (value.type === "thinking") return { type: "thinking" };
  if (value.type === "done") return doneEvent(value as ChatResponseBody);
  if (value.type === "error") {
    throw new HttpRequestError(String(value.message || value.error || "The assistant request failed"), {
      status: Number(value.status) || 502,
      code: typeof value.error === "string" ? value.error : undefined,
    });
  }
  return null;
}

function doneEvent(body: ChatResponseBody): ChatStreamEvent {
  return { type: "done", content: body.message?.content || body.content || "", truncated: body.truncated === true };
}
