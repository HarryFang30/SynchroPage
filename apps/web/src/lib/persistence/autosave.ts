export type DebouncedAsyncTask<TArgs extends unknown[]> = {
  schedule: (...args: TArgs) => void;
  flush: () => Promise<void>;
  cancel: () => void;
};

export type PersistenceErrorKind =
  | "quota"
  | "not_found"
  | "validation"
  | "corrupt_export"
  | "too_large"
  | "transaction_failed"
  | "unavailable"
  | "unknown";

export class PersistenceError extends Error {
  readonly kind: PersistenceErrorKind;
  readonly cause?: unknown;

  constructor(kind: PersistenceErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "PersistenceError";
    this.kind = kind;
    this.cause = options.cause;
  }
}

export function createDebouncedAsyncTask<TArgs extends unknown[]>(
  task: (...args: TArgs) => Promise<void>,
  delayMs = 450,
): DebouncedAsyncTask<TArgs> {
  let timer: number | undefined;
  let latestArgs: TArgs | null = null;

  const run = async () => {
    if (!latestArgs) return;
    const args = latestArgs;
    latestArgs = null;
    await task(...args);
  };

  return {
    schedule: (...args: TArgs) => {
      latestArgs = args;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void run();
      }, delayMs);
    },
    flush: async () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      await run();
    },
    cancel: () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      latestArgs = null;
    },
  };
}

export function isQuotaError(error: unknown) {
  return classifyPersistenceError(error).kind === "quota";
}

export function classifyPersistenceError(error: unknown): {
  kind: PersistenceErrorKind;
  message: string;
  original: unknown;
} {
  if (error instanceof PersistenceError) {
    return { kind: error.kind, message: error.message, original: error };
  }
  const name = (error as { name?: string } | null)?.name;
  const message = (error as { message?: string } | null)?.message || "Persistence operation failed";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return { kind: "quota", message, original: error };
  }
  if (name === "NotFoundError") {
    return { kind: "not_found", message, original: error };
  }
  if (name === "InvalidStateError" || name === "UnknownError" || name === "TransactionInactiveError") {
    return { kind: "transaction_failed", message, original: error };
  }
  if (/unsupported|corrupt export|invalid export/i.test(message)) {
    return { kind: "corrupt_export", message, original: error };
  }
  if (/validation|invalid|missing|required|mismatch/i.test(message)) {
    return { kind: "validation", message, original: error };
  }
  if (/indexeddb|database|storage unavailable|blocked/i.test(message)) {
    return { kind: "unavailable", message, original: error };
  }
  return { kind: "unknown", message, original: error };
}
