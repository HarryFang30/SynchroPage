export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  accountNotFoundMessage = "请先连接 OpenAI OAuth 后再发送。",
) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    let parsed: { error?: string; message?: string } | null = null;
    try {
      parsed = JSON.parse(detail) as { error?: string; message?: string };
    } catch {
      parsed = null;
    }
    if (parsed?.error === "account_not_found") {
      throw new Error(accountNotFoundMessage);
    }
    throw new Error(parsed?.message || parsed?.error || detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
