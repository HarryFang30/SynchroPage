import { requestJson } from "../http/requestJson";

export type PdfDirectFileInput = {
  filename: string;
  mimeType: string;
  size: number;
  sha256?: string;
  fileData?: string;
};

const PDF_DIRECT_FILE_CACHE_MAX_ENTRIES = 16;
const cachedPdfDirectFilesByUrl = new Map<string, Promise<PdfDirectFileInput | null>>();
const cachedPdfDirectFilesByKey = new Map<string, Promise<PdfDirectFileInput | null>>();
const cachedPdfDirectFilesByBlob = new WeakMap<Blob, Promise<PdfDirectFileInput | null>>();

export function pdfDirectFileCacheKey(...parts: string[]) {
  return parts.join("\u001f");
}

export function cachedPdfDirectFileInputFromUrl(url: string, filename: string): Promise<PdfDirectFileInput | null> {
  if (!url) return Promise.resolve(null);
  const key = pdfDirectFileCacheKey("url", filename || "document.pdf", url);
  return rememberPdfDirectFileByKey(cachedPdfDirectFilesByUrl, key, () =>
    pdfDirectFileInputFromUrl(url, filename).then(cachedPdfDirectFileInput),
  );
}

export function cachedPdfDirectFileInputFromBlob(
  blob: Blob,
  filename: string,
  cacheKey?: string,
): Promise<PdfDirectFileInput | null> {
  if (!blob.size) return Promise.resolve(null);
  const create = () => pdfDirectFileInputFromBlob(blob, filename).then(cachedPdfDirectFileInput);
  if (!cacheKey) return rememberPdfDirectFileByBlob(blob, create);
  const key = pdfDirectFileCacheKey("blob", cacheKey, filename || "document.pdf", String(blob.size), blob.type || "application/pdf");
  return rememberPdfDirectFileByKey(cachedPdfDirectFilesByKey, key, create);
}

async function pdfDirectFileInputFromUrl(url: string, filename: string): Promise<PdfDirectFileInput | null> {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF file read failed: HTTP ${response.status}`);
  const blob = await response.blob();
  return pdfDirectFileInputFromBlob(blob, filename);
}

async function pdfDirectFileInputFromBlob(blob: Blob, filename: string): Promise<PdfDirectFileInput | null> {
  if (!blob.size) return null;
  const buffer = await blob.arrayBuffer();
  const sha256 = await sha256ArrayBuffer(buffer).catch(() => undefined);
  return {
    filename: filename || "document.pdf",
    mimeType: blob.type || "application/pdf",
    size: blob.size,
    sha256,
    fileData: arrayBufferToBase64(buffer),
  };
}

async function cachedPdfDirectFileInput(file: PdfDirectFileInput | null): Promise<PdfDirectFileInput | null> {
  if (!file?.fileData) return file;
  const cached = await requestJson<PdfDirectFileInput>(
    "/api/pdf/cache",
    {
      method: "POST",
      body: JSON.stringify({ documentFile: file }),
    },
  ).catch(() => null);
  if (!cached?.sha256) return file;
  return {
    filename: cached.filename || file.filename,
    mimeType: cached.mimeType || file.mimeType,
    size: cached.size || file.size,
    sha256: cached.sha256,
  };
}

function rememberPdfDirectFileByKey(
  cache: Map<string, Promise<PdfDirectFileInput | null>>,
  key: string,
  create: () => Promise<PdfDirectFileInput | null>,
) {
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = create()
    .then((file) => {
      if (file?.fileData) cache.delete(key);
      return file;
    })
    .catch(() => {
      cache.delete(key);
      return null;
    });
  cache.set(key, promise);
  while (cache.size > PDF_DIRECT_FILE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return promise;
}

function rememberPdfDirectFileByBlob(
  blob: Blob,
  create: () => Promise<PdfDirectFileInput | null>,
) {
  const existing = cachedPdfDirectFilesByBlob.get(blob);
  if (existing) return existing;
  const promise = create()
    .then((file) => {
      if (file?.fileData) cachedPdfDirectFilesByBlob.delete(blob);
      return file;
    })
    .catch(() => {
      cachedPdfDirectFilesByBlob.delete(blob);
      return null;
    });
  cachedPdfDirectFilesByBlob.set(blob, promise);
  return promise;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

async function sha256ArrayBuffer(buffer: ArrayBuffer) {
  if (!window.crypto?.subtle) return undefined;
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
