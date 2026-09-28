export type HttpRequestErrorInit = {
  status: number;
  code?: string;
  retryAfterSeconds?: number;
  body?: string;
};

/**
 * Transport/protocol error carrying everything a retry classifier needs:
 * the HTTP status, the backend error code ({"error": <code>, "message": <text>})
 * and the parsed Retry-After header. Never classify by message text.
 */
export class HttpRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly body?: string;

  constructor(message: string, init: HttpRequestErrorInit) {
    super(message);
    this.name = "HttpRequestError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.body = init.body;
  }
}

export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  return undefined;
}

function readStringField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The error a failed response stands for: backend code, message and Retry-After. */
export async function httpRequestErrorFromResponse(
  response: Response,
  accountNotFoundMessage = "请先连接 OpenAI OAuth 后再发送。",
) {
  const detail = await response.text().catch(() => "");
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(detail) as unknown;
    parsed = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : null;
  } catch {
    parsed = null;
  }
  const code = readStringField(parsed, "error");
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("Retry-After"));
  const message = code === "account_not_found"
    ? accountNotFoundMessage
    : readStringField(parsed, "message") || code || detail || `HTTP ${response.status}`;
  return new HttpRequestError(message, {
    status: response.status,
    code,
    retryAfterSeconds,
    body: detail || undefined,
  });
}

export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  accountNotFoundMessage?: string,
) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw await httpRequestErrorFromResponse(response, accountNotFoundMessage);
  return (await response.json()) as T;
}
