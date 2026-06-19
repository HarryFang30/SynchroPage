import { ExportedMessageRepository, type ThreadMessageLike } from "@assistant-ui/react";
import { PersistenceError } from "./autosave";
import { pagePairDb } from "./db";
import {
  lastWorkspaceStorageKey,
  persistenceSchemaVersion,
  type ChatMessageRecord,
  type ChatMessageStatus,
  type ChatThreadRecord,
  type DocumentSidebarItem,
  type DocumentRecord,
  type ExportedWorkspace,
  type FileBlobRecord,
  type GeneratedPageRecord,
  type LoadedWorkspace,
  type PersistedJson,
  type SelectedContextRecord,
  type SettingsRecord,
  type StorageEstimate,
  type StorageRepairResult,
  type WorkspaceRecord,
} from "./schema";
import type { UiPreferences } from "../../settings";

type PagePackLike = {
  document: {
    id: string;
    title: string;
    source_pdf_url?: string;
    page_count?: number;
  };
  pages: Array<{
    page_no?: number;
    status?: string;
    teaching?: {
      slide_title?: string;
      speaker_notes_md?: string;
      confidence?: number;
    };
  } & PersistedJson>;
};

type LayoutPatch = PersistedJson & {
  activeTab?: string;
  panels?: PersistedJson;
  contexts?: unknown[];
  attachments?: unknown[];
};

export function createRecordId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getLastWorkspaceId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(lastWorkspaceStorageKey);
}

export function setLastWorkspaceId(workspaceId: string | null) {
  if (typeof window === "undefined") return;
  if (workspaceId) window.localStorage.setItem(lastWorkspaceStorageKey, workspaceId);
  else window.localStorage.removeItem(lastWorkspaceStorageKey);
}

export async function createWorkspace(input: {
  title?: string;
  settingsSnapshot?: UiPreferences;
  layoutState?: LayoutPatch;
} = {}) {
  const now = Date.now();
  const workspace: WorkspaceRecord = {
    id: createRecordId("ws"),
    title: input.title || "PagePair Workspace",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    currentGeneratedPageIndex: 0,
    currentPdfPageNumber: 1,
    layoutState: input.layoutState,
    settingsSnapshot: input.settingsSnapshot,
    version: persistenceSchemaVersion,
  };
  await pagePairDb.workspaces.put(workspace);
  if (input.settingsSnapshot) {
    await saveSettings(input.settingsSnapshot, workspace.id);
  }
  setLastWorkspaceId(workspace.id);
  return workspace;
}

export async function loadLastWorkspace() {
  const workspaceId = getLastWorkspaceId();
  if (!workspaceId) return null;
  return loadWorkspace(workspaceId);
}

export async function loadWorkspaceDocuments(
  workspaceId: string,
  activeDocumentId?: string | null,
): Promise<DocumentSidebarItem[]> {
  const [documents, generatedPages] = await Promise.all([
    pagePairDb.documents.where("workspaceId").equals(workspaceId).toArray(),
    pagePairDb.generatedPages.where("workspaceId").equals(workspaceId).toArray(),
  ]);
  const generatedCounts = generatedPages.reduce((counts, page) => {
    if (page.status === "completed" && page.markdown.trim()) {
      counts.set(page.documentId, (counts.get(page.documentId) || 0) + 1);
    }
    return counts;
  }, new Map<string, number>());

  return documents
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((document) => ({
      id: document.id,
      workspaceId: document.workspaceId,
      documentId: document.id,
      title: document.title,
      fileName: document.fileName,
      mimeType: document.mimeType,
      pageCount: document.pageCount,
      currentPdfPageNumber: document.currentPdfPageNumber,
      generatedPageCount: generatedCounts.get(document.id) || 0,
      status: document.status,
      updatedAt: document.updatedAt,
      uploadedAt: document.uploadedAt,
      isActive: document.id === activeDocumentId,
    }));
}

export async function loadWorkspace(workspaceId: string): Promise<LoadedWorkspace | null> {
  const workspace = await pagePairDb.workspaces.get(workspaceId);
  if (!workspace) {
    setLastWorkspaceId(null);
    return null;
  }

  let document = workspace.activeDocumentId
    ? (await pagePairDb.documents.get(workspace.activeDocumentId)) || null
    : null;
  if (!document) {
    const documents = await pagePairDb.documents.where("workspaceId").equals(workspace.id).sortBy("updatedAt");
    document = documents.at(-1) || null;
  }
  const pdfBlob = document?.pdfBlobId
    ? (await pagePairDb.fileBlobs.get(document.pdfBlobId)) || null
    : null;
  const generatedPages = document
    ? await pagePairDb.generatedPages
        .where("documentId")
        .equals(document.id)
        .sortBy("generatedPageIndex")
    : [];
  let thread = workspace.activeThreadId
    ? (await pagePairDb.chatThreads.get(workspace.activeThreadId)) || null
    : document
      ? (await pagePairDb.chatThreads.where("documentId").equals(document.id).last()) || null
      : null;
  if (document && thread?.documentId !== document.id) {
    const threads = await pagePairDb.chatThreads.where("documentId").equals(document.id).sortBy("updatedAt");
    thread = threads.at(-1) || null;
  }
  const messages = thread
    ? await pagePairDb.chatMessages.where("threadId").equals(thread.id).sortBy("createdAt")
    : [];
  const selectedContext = document
    ? (await pagePairDb.selectedContexts.where("documentId").equals(document.id).last()) || null
    : null;
  const settings = (await loadSettings(workspaceId)) || null;
  const documentItems = await loadWorkspaceDocuments(workspace.id, document?.id || workspace.activeDocumentId);

  await pagePairDb.workspaces.update(workspace.id, {
    activeDocumentId: document?.id || workspace.activeDocumentId,
    activeThreadId: thread?.id || workspace.activeThreadId,
    lastOpenedAt: Date.now(),
  });
  setLastWorkspaceId(workspace.id);

  return {
    workspace: {
      ...workspace,
      activeDocumentId: document?.id || workspace.activeDocumentId,
      activeThreadId: thread?.id || workspace.activeThreadId,
    },
    document,
    documentItems,
    pdfBlob,
    generatedPages,
    thread,
    messages: messages.sort((left, right) => left.createdAt - right.createdAt),
    selectedContext,
    settings,
  };
}

export async function loadWorkspaceDocument(
  workspaceId: string,
  documentId: string,
): Promise<LoadedWorkspace> {
  const [workspace, document] = await Promise.all([
    pagePairDb.workspaces.get(workspaceId),
    pagePairDb.documents.get(documentId),
  ]);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  if (!document || document.workspaceId !== workspaceId) {
    throw new PersistenceError("not_found", "Document not found");
  }

  const pdfBlob = document.pdfBlobId
    ? (await pagePairDb.fileBlobs.get(document.pdfBlobId)) || null
    : null;
  const generatedPages = await pagePairDb.generatedPages
    .where("documentId")
    .equals(document.id)
    .sortBy("generatedPageIndex");
  let thread = workspace.activeThreadId
    ? (await pagePairDb.chatThreads.get(workspace.activeThreadId)) || null
    : null;
  if (thread?.documentId !== document.id) thread = null;
  if (!thread) {
    const threads = await pagePairDb.chatThreads.where("documentId").equals(document.id).sortBy("updatedAt");
    thread = threads.at(-1) || null;
  }
  if (!thread) {
    thread = await createChatThread({
      workspaceId,
      documentId: document.id,
      title: "Main chat",
    });
  }
  const messages = await pagePairDb.chatMessages.where("threadId").equals(thread.id).sortBy("createdAt");
  const selectedContext = (await pagePairDb.selectedContexts.where("documentId").equals(document.id).last()) || null;
  const settings = (await loadSettings(workspaceId)) || null;
  const now = Date.now();
  const nextWorkspace: WorkspaceRecord = {
    ...workspace,
    activeDocumentId: document.id,
    activeThreadId: thread.id,
    currentPdfPageNumber: document.currentPdfPageNumber || 1,
    updatedAt: now,
    lastOpenedAt: now,
  };
  await pagePairDb.workspaces.update(workspace.id, {
    activeDocumentId: document.id,
    activeThreadId: thread.id,
    currentPdfPageNumber: document.currentPdfPageNumber || 1,
    updatedAt: now,
    lastOpenedAt: now,
  });
  setLastWorkspaceId(workspace.id);

  return {
    workspace: nextWorkspace,
    document,
    documentItems: await loadWorkspaceDocuments(workspace.id, document.id),
    pdfBlob,
    generatedPages,
    thread,
    messages: messages.sort((left, right) => left.createdAt - right.createdAt),
    selectedContext,
    settings,
  };
}

export async function saveWorkspacePatch(workspaceId: string, patch: Partial<WorkspaceRecord>) {
  await pagePairDb.workspaces.update(workspaceId, {
    ...patch,
    updatedAt: Date.now(),
  });
}

export async function ensureWorkspace(input: {
  workspaceId?: string | null;
  title?: string;
  settingsSnapshot?: UiPreferences;
  layoutState?: LayoutPatch;
}) {
  if (input.workspaceId) {
    const existing = await pagePairDb.workspaces.get(input.workspaceId);
    if (existing) return existing;
  }
  return createWorkspace(input);
}

export async function savePdfBlob(input: {
  workspaceId?: string | null;
  file: File;
  settingsSnapshot?: UiPreferences;
  layoutState?: LayoutPatch;
}) {
  const now = Date.now();
  const title = input.file.name.replace(/\.pdf$/i, "") || input.file.name || "Untitled PDF";
  const workspace = await ensureWorkspace({
    workspaceId: input.workspaceId,
    title,
    settingsSnapshot: input.settingsSnapshot,
    layoutState: input.layoutState,
  });
  const documentId = createRecordId("doc");
  const blobId = createRecordId("blob");
  const threadId = createRecordId("thread");
  const hash = await hashBlob(input.file).catch(() => undefined);
  const document: DocumentRecord = {
    id: documentId,
    workspaceId: workspace.id,
    title,
    fileName: input.file.name || `${title}.pdf`,
    mimeType: input.file.type || "application/pdf",
    size: input.file.size || 0,
    hash,
    pageCount: 0,
    uploadedAt: now,
    updatedAt: now,
    pdfBlobId: blobId,
    currentPdfPageNumber: 1,
    status: "ready",
  };
  const fileBlob: FileBlobRecord = {
    id: blobId,
    workspaceId: workspace.id,
    documentId,
    blob: input.file,
    fileName: document.fileName,
    mimeType: document.mimeType,
    size: document.size,
    createdAt: now,
  };
  const thread: ChatThreadRecord = {
    id: threadId,
    workspaceId: workspace.id,
    documentId,
    title: "Main chat",
    createdAt: now,
    updatedAt: now,
  };

  await pagePairDb.transaction("rw", pagePairDb.workspaces, pagePairDb.documents, pagePairDb.fileBlobs, pagePairDb.chatThreads, pagePairDb.selectedContexts, async () => {
    await pagePairDb.documents.put(document);
    await pagePairDb.fileBlobs.put(fileBlob);
    await pagePairDb.chatThreads.put(thread);
    await pagePairDb.selectedContexts.where("workspaceId").equals(workspace.id).delete();
    await pagePairDb.workspaces.update(workspace.id, {
      title,
      activeDocumentId: document.id,
      activeThreadId: thread.id,
      currentGeneratedPageIndex: 0,
      currentPdfPageNumber: 1,
      layoutState: input.layoutState,
      settingsSnapshot: input.settingsSnapshot,
      updatedAt: now,
      lastOpenedAt: now,
    });
  });
  setLastWorkspaceId(workspace.id);
  return { workspace: { ...workspace, activeDocumentId: document.id, activeThreadId: thread.id }, document, fileBlob, thread };
}

export async function loadPdfBlob(blobId: string) {
  return (await pagePairDb.fileBlobs.get(blobId)) || null;
}

export async function saveDocumentPatch(documentId: string, patch: Partial<DocumentRecord>) {
  await pagePairDb.documents.update(documentId, {
    ...patch,
    updatedAt: Date.now(),
  });
}

export async function saveGeneratedPagesFromPack(input: {
  workspaceId: string;
  documentId: string;
  pack: PagePackLike;
}) {
  const now = Date.now();
  const records: GeneratedPageRecord[] = input.pack.pages.map((page, index) => {
    const teaching = page.teaching || {};
    const pageNo = Number(page.page_no || index + 1);
    return {
      id: `${input.documentId}:page:${pageNo}`,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      generatedPageIndex: index,
      sourcePdfPageNumber: pageNo,
      title: teaching.slide_title || `Page ${pageNo}`,
      markdown: teaching.speaker_notes_md || "",
      json: page,
      confidence: typeof teaching.confidence === "number" ? teaching.confidence : undefined,
      status: page.status === "failed" ? "failed" : "completed",
      createdAt: now,
      updatedAt: now,
    };
  });
  await pagePairDb.transaction("rw", pagePairDb.documents, pagePairDb.generatedPages, pagePairDb.workspaces, async () => {
    await pagePairDb.generatedPages.where("documentId").equals(input.documentId).delete();
    if (records.length) await pagePairDb.generatedPages.bulkPut(records);
    await pagePairDb.documents.update(input.documentId, {
      title: input.pack.document.title,
      pageCount: Math.max(input.pack.document.page_count || 0, records.length),
      updatedAt: now,
    });
    await pagePairDb.workspaces.update(input.workspaceId, {
      title: input.pack.document.title,
      updatedAt: now,
    });
  });
}

export async function saveImportedPagePack(input: {
  workspaceId?: string | null;
  pack: PagePackLike;
  settingsSnapshot?: UiPreferences;
  layoutState?: LayoutPatch;
}) {
  const now = Date.now();
  const title = input.pack.document.title || "Imported PagePair";
  const workspace = await ensureWorkspace({
    workspaceId: input.workspaceId,
    title,
    settingsSnapshot: input.settingsSnapshot,
    layoutState: input.layoutState,
  });
  const documentId = createRecordId("doc");
  const threadId = createRecordId("thread");
  const document: DocumentRecord = {
    id: documentId,
    workspaceId: workspace.id,
    title,
    fileName: input.pack.document.source_pdf_url || `${title}.json`,
    mimeType: "application/json",
    size: 0,
    pageCount: input.pack.document.page_count || input.pack.pages.length,
    uploadedAt: now,
    updatedAt: now,
    currentPdfPageNumber: input.pack.pages[0]?.page_no || 1,
    status: "ready",
  };
  const thread: ChatThreadRecord = {
    id: threadId,
    workspaceId: workspace.id,
    documentId,
    title: "Main chat",
    createdAt: now,
    updatedAt: now,
  };

  await pagePairDb.transaction("rw", pagePairDb.workspaces, pagePairDb.documents, pagePairDb.generatedPages, pagePairDb.chatThreads, pagePairDb.selectedContexts, async () => {
    await pagePairDb.documents.put(document);
    await pagePairDb.chatThreads.put(thread);
    await pagePairDb.selectedContexts.where("workspaceId").equals(workspace.id).delete();
    await pagePairDb.workspaces.update(workspace.id, {
      title,
      activeDocumentId: document.id,
      activeThreadId: thread.id,
      currentGeneratedPageIndex: 0,
      currentPdfPageNumber: document.currentPdfPageNumber,
      layoutState: input.layoutState,
      settingsSnapshot: input.settingsSnapshot,
      updatedAt: now,
      lastOpenedAt: now,
    });
  });
  await saveGeneratedPagesFromPack({ workspaceId: workspace.id, documentId, pack: input.pack });
  setLastWorkspaceId(workspace.id);
  return { workspace: { ...workspace, activeDocumentId: document.id, activeThreadId: thread.id }, document, thread };
}

export async function saveGeneratedPage(record: GeneratedPageRecord) {
  await pagePairDb.generatedPages.put({
    ...record,
    updatedAt: Date.now(),
  });
}

export async function createChatThread(input: {
  workspaceId: string;
  documentId?: string;
  title?: string;
}) {
  const now = Date.now();
  const thread: ChatThreadRecord = {
    id: createRecordId("thread"),
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    title: input.title || "Main chat",
    createdAt: now,
    updatedAt: now,
  };
  await pagePairDb.transaction("rw", pagePairDb.chatThreads, pagePairDb.workspaces, async () => {
    await pagePairDb.chatThreads.put(thread);
    await pagePairDb.workspaces.update(input.workspaceId, {
      activeThreadId: thread.id,
      updatedAt: now,
    });
  });
  return thread;
}

export async function saveChatMessage(message: ChatMessageRecord) {
  const now = Date.now();
  await pagePairDb.transaction("rw", pagePairDb.chatMessages, pagePairDb.chatThreads, pagePairDb.workspaces, async () => {
    await pagePairDb.chatMessages.put({
      ...message,
      updatedAt: now,
    });
    await pagePairDb.chatThreads.update(message.threadId, { updatedAt: now });
    await pagePairDb.workspaces.update(message.workspaceId, { updatedAt: now });
  });
}

export async function updateStreamingMessage(input: {
  id: string;
  threadId: string;
  workspaceId: string;
  documentId?: string;
  content: string;
  status: ChatMessageStatus;
  selectedContext?: PersistedJson | null;
  sourceRefs?: PersistedJson[];
}) {
  const existing = await pagePairDb.chatMessages.get(input.id);
  await saveChatMessage({
    id: input.id,
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    role: "assistant",
    content: input.content,
    contentMarkdown: input.content,
    selectedContext: input.selectedContext ?? existing?.selectedContext ?? null,
    sourceRefs: input.sourceRefs ?? existing?.sourceRefs ?? [],
    status: input.status,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
}

export async function saveSelectedContext(input: {
  workspaceId: string;
  documentId?: string;
  context: PersistedJson & {
    id?: string;
    text?: string;
    sourceType?: string;
    pdfPageNumber?: number;
    generatedPageNumber?: number;
    sectionTitle?: string;
    selectionRects?: PersistedJson[];
  };
}) {
  const now = Date.now();
  const record: SelectedContextRecord = {
    id: input.context.id || createRecordId("selected"),
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    text: String(input.context.text || ""),
    sourceType: String(input.context.sourceType || "unknown"),
    pdfPageNumber: input.context.pdfPageNumber,
    generatedPageNumber: input.context.generatedPageNumber,
    sectionTitle: input.context.sectionTitle,
    rects: input.context.selectionRects,
    payload: input.context,
    createdAt: now,
  };
  await pagePairDb.selectedContexts.put(record);
  return record;
}

export async function clearSelectedContext(workspaceId: string, documentId?: string) {
  if (documentId) {
    await pagePairDb.selectedContexts.where("documentId").equals(documentId).delete();
    return;
  }
  await pagePairDb.selectedContexts.where("workspaceId").equals(workspaceId).delete();
}

export async function saveSettings(settings: UiPreferences, workspaceId = "global") {
  const record: SettingsRecord = {
    ...settings,
    id: workspaceId,
    updatedAt: Date.now(),
  };
  await pagePairDb.settings.put(record);
  if (workspaceId !== "global") {
    await pagePairDb.workspaces.update(workspaceId, {
      settingsSnapshot: settings,
      updatedAt: record.updatedAt,
    });
  }
  return record;
}

export async function loadSettings(workspaceId = "global") {
  return (await pagePairDb.settings.get(workspaceId)) || (workspaceId !== "global" ? await pagePairDb.settings.get("global") : null);
}

export async function estimateStorage(): Promise<StorageEstimate> {
  const [estimate, persisted, workspaceCount, documentCount] = await Promise.all([
    navigator.storage?.estimate?.().catch(() => null),
    navigator.storage?.persisted?.().catch(() => null),
    pagePairDb.workspaces.count(),
    pagePairDb.documents.count(),
  ]);
  return {
    usage: Number(estimate?.usage || 0),
    quota: Number(estimate?.quota || 0),
    persisted: typeof persisted === "boolean" ? persisted : null,
    workspaceCount,
    documentCount,
  };
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return null;
  return navigator.storage.persist();
}

export async function repairWorkspaceStorage(workspaceId?: string | null): Promise<StorageRepairResult> {
  const result: StorageRepairResult = {
    orphanFileBlobs: 0,
    orphanGeneratedPages: 0,
    orphanChatThreads: 0,
    orphanChatMessages: 0,
    orphanSelectedContexts: 0,
    workspacesRepaired: 0,
    documentsMarkedMissing: 0,
  };
  const [workspaces, documents, fileBlobs, generatedPages, chatThreads, chatMessages, selectedContexts] = await Promise.all([
    workspaceId ? pagePairDb.workspaces.where("id").equals(workspaceId).toArray() : pagePairDb.workspaces.toArray(),
    workspaceId ? pagePairDb.documents.where("workspaceId").equals(workspaceId).toArray() : pagePairDb.documents.toArray(),
    workspaceId ? pagePairDb.fileBlobs.where("workspaceId").equals(workspaceId).toArray() : pagePairDb.fileBlobs.toArray(),
    workspaceId ? pagePairDb.generatedPages.where("workspaceId").equals(workspaceId).toArray() : pagePairDb.generatedPages.toArray(),
    workspaceId ? pagePairDb.chatThreads.where("workspaceId").equals(workspaceId).toArray() : pagePairDb.chatThreads.toArray(),
    workspaceId ? pagePairDb.chatMessages.where("workspaceId").equals(workspaceId).toArray() : pagePairDb.chatMessages.toArray(),
    workspaceId ? pagePairDb.selectedContexts.where("workspaceId").equals(workspaceId).toArray() : pagePairDb.selectedContexts.toArray(),
  ]);

  const workspaceIds = new Set(workspaces.map((record) => record.id));
  const documentIds = new Set(documents.map((record) => record.id));
  const blobIds = new Set(fileBlobs.map((record) => record.id));
  const threadIds = new Set(chatThreads.map((record) => record.id));

  const orphanFileBlobIds = fileBlobs
    .filter((record) => !workspaceIds.has(record.workspaceId) || !documentIds.has(record.documentId))
    .map((record) => record.id);
  const orphanGeneratedPageIds = generatedPages
    .filter((record) => !workspaceIds.has(record.workspaceId) || !documentIds.has(record.documentId))
    .map((record) => record.id);
  const orphanThreadIds = chatThreads
    .filter((record) => !workspaceIds.has(record.workspaceId) || (record.documentId ? !documentIds.has(record.documentId) : false))
    .map((record) => record.id);
  const orphanMessageIds = chatMessages
    .filter((record) => !workspaceIds.has(record.workspaceId) || !threadIds.has(record.threadId) || (record.documentId ? !documentIds.has(record.documentId) : false))
    .map((record) => record.id);
  const orphanContextIds = selectedContexts
    .filter((record) => !workspaceIds.has(record.workspaceId) || (record.documentId ? !documentIds.has(record.documentId) : false))
    .map((record) => record.id);
  const missingBlobDocuments = documents
    .filter((record) => record.pdfBlobId && !blobIds.has(record.pdfBlobId))
    .map((record) => record.id);

  await pagePairDb.transaction(
    "rw",
    [
      pagePairDb.workspaces,
      pagePairDb.documents,
      pagePairDb.fileBlobs,
      pagePairDb.generatedPages,
      pagePairDb.chatThreads,
      pagePairDb.chatMessages,
      pagePairDb.selectedContexts,
    ],
    async () => {
      if (orphanFileBlobIds.length) await pagePairDb.fileBlobs.bulkDelete(orphanFileBlobIds);
      if (orphanGeneratedPageIds.length) await pagePairDb.generatedPages.bulkDelete(orphanGeneratedPageIds);
      if (orphanThreadIds.length) await pagePairDb.chatThreads.bulkDelete(orphanThreadIds);
      if (orphanMessageIds.length) await pagePairDb.chatMessages.bulkDelete(orphanMessageIds);
      if (orphanContextIds.length) await pagePairDb.selectedContexts.bulkDelete(orphanContextIds);
      for (const documentId of missingBlobDocuments) {
        await pagePairDb.documents.update(documentId, { status: "missing-file", updatedAt: Date.now() });
      }
      for (const workspace of workspaces) {
        const patch: Partial<WorkspaceRecord> = {};
        if (workspace.activeDocumentId && !documentIds.has(workspace.activeDocumentId)) patch.activeDocumentId = undefined;
        if (workspace.activeThreadId && !threadIds.has(workspace.activeThreadId)) patch.activeThreadId = undefined;
        if (Object.keys(patch).length) {
          patch.updatedAt = Date.now();
          await pagePairDb.workspaces.update(workspace.id, patch);
          result.workspacesRepaired += 1;
        }
      }
    },
  );

  result.orphanFileBlobs = orphanFileBlobIds.length;
  result.orphanGeneratedPages = orphanGeneratedPageIds.length;
  result.orphanChatThreads = orphanThreadIds.length;
  result.orphanChatMessages = orphanMessageIds.length;
  result.orphanSelectedContexts = orphanContextIds.length;
  result.documentsMarkedMissing = missingBlobDocuments.length;
  return result;
}

export async function clearWorkspace(workspaceId: string) {
  await pagePairDb.transaction(
    "rw",
    [
      pagePairDb.workspaces,
      pagePairDb.documents,
      pagePairDb.fileBlobs,
      pagePairDb.generatedPages,
      pagePairDb.chatThreads,
      pagePairDb.chatMessages,
      pagePairDb.selectedContexts,
      pagePairDb.settings,
    ],
    async () => {
      await Promise.all([
        pagePairDb.documents.where("workspaceId").equals(workspaceId).delete(),
        pagePairDb.fileBlobs.where("workspaceId").equals(workspaceId).delete(),
        pagePairDb.generatedPages.where("workspaceId").equals(workspaceId).delete(),
        pagePairDb.chatThreads.where("workspaceId").equals(workspaceId).delete(),
        pagePairDb.chatMessages.where("workspaceId").equals(workspaceId).delete(),
        pagePairDb.selectedContexts.where("workspaceId").equals(workspaceId).delete(),
        pagePairDb.settings.delete(workspaceId),
        pagePairDb.workspaces.delete(workspaceId),
      ]);
    },
  );
  if (getLastWorkspaceId() === workspaceId) setLastWorkspaceId(null);
}

export async function exportWorkspace(workspaceId: string): Promise<ExportedWorkspace> {
  const workspace = await pagePairDb.workspaces.get(workspaceId);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  const [documents, fileBlobRecords, generatedPages, chatThreads, chatMessages, selectedContexts, settings] = await Promise.all([
    pagePairDb.documents.where("workspaceId").equals(workspaceId).toArray(),
    pagePairDb.fileBlobs.where("workspaceId").equals(workspaceId).toArray(),
    pagePairDb.generatedPages.where("workspaceId").equals(workspaceId).toArray(),
    pagePairDb.chatThreads.where("workspaceId").equals(workspaceId).toArray(),
    pagePairDb.chatMessages.where("workspaceId").equals(workspaceId).toArray(),
    pagePairDb.selectedContexts.where("workspaceId").equals(workspaceId).toArray(),
    loadSettings(workspaceId),
  ]);
  const fileBlobs = await Promise.all(
    fileBlobRecords.map(async ({ blob, ...record }) => {
      const [dataUrl, hash] = await Promise.all([blobToDataUrl(blob), hashBlob(blob).catch(() => "")]);
      return {
        ...record,
        dataUrl,
        hash,
      };
    }),
  );
  const fileBlobHashes = Object.fromEntries(
    fileBlobs
      .filter((record): record is typeof record & { hash: string } => Boolean(record.hash))
      .map((record) => [record.id, record.hash]),
  );
  return {
    schema: "pagepair.workspace.export.v1",
    app: "pagepair-reader",
    schemaVersion: persistenceSchemaVersion,
    exportedAt: Date.now(),
    counts: {
      workspaces: 1,
      documents: documents.length,
      fileBlobs: fileBlobs.length,
      generatedPages: generatedPages.length,
      chatThreads: chatThreads.length,
      chatMessages: chatMessages.length,
      selectedContexts: selectedContexts.length,
      settings: settings ? 1 : 0,
    },
    integrity: {
      fileBlobHashes,
    },
    workspace,
    documents,
    fileBlobs: fileBlobs.map(({ hash: _hash, ...record }) => record),
    generatedPages,
    chatThreads,
    chatMessages,
    selectedContexts,
    settings: settings || null,
  };
}

export async function importWorkspace(payload: ExportedWorkspace) {
  validateWorkspaceExportPayload(payload);
  const fileBlobs = await Promise.all(
    payload.fileBlobs.map(async ({ dataUrl, ...record }) => {
      const blob = await dataUrlToBlob(dataUrl);
      if (record.size && blob.size !== record.size) {
        throw new PersistenceError("corrupt_export", `Blob size mismatch for ${record.fileName || record.id}`);
      }
      const expectedHash = payload.integrity?.fileBlobHashes?.[record.id];
      if (expectedHash) {
        const actualHash = await hashBlob(blob).catch(() => "");
        if (actualHash && actualHash !== expectedHash) {
          throw new PersistenceError("corrupt_export", `Blob hash mismatch for ${record.fileName || record.id}`);
        }
      }
      return {
        ...record,
        blob,
      };
    }),
  );
  validateWorkspaceExportRelations(payload);
  await pagePairDb.transaction(
    "rw",
    [
      pagePairDb.workspaces,
      pagePairDb.documents,
      pagePairDb.fileBlobs,
      pagePairDb.generatedPages,
      pagePairDb.chatThreads,
      pagePairDb.chatMessages,
      pagePairDb.selectedContexts,
      pagePairDb.settings,
    ],
    async () => {
      await pagePairDb.workspaces.put({
        ...payload.workspace,
        version: payload.workspace.version || persistenceSchemaVersion,
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
      });
      await pagePairDb.documents.bulkPut(payload.documents);
      if (fileBlobs.length) await pagePairDb.fileBlobs.bulkPut(fileBlobs);
      if (payload.generatedPages.length) await pagePairDb.generatedPages.bulkPut(payload.generatedPages);
      if (payload.chatThreads.length) await pagePairDb.chatThreads.bulkPut(payload.chatThreads);
      if (payload.chatMessages.length) await pagePairDb.chatMessages.bulkPut(payload.chatMessages);
      if (payload.selectedContexts.length) await pagePairDb.selectedContexts.bulkPut(payload.selectedContexts);
      if (payload.settings) await pagePairDb.settings.put(payload.settings);
    },
  );
  setLastWorkspaceId(payload.workspace.id);
  return payload.workspace.id;
}

function validateWorkspaceExportPayload(payload: ExportedWorkspace) {
  assertExport(Boolean(payload && typeof payload === "object"), "corrupt_export", "Invalid workspace export");
  assertExport(payload.schema === "pagepair.workspace.export.v1", "corrupt_export", "Unsupported workspace export");
  assertExport(Boolean(payload.workspace?.id), "validation", "Workspace export is missing a workspace id");
  assertExport(Array.isArray(payload.documents), "validation", "Workspace export documents must be an array");
  assertExport(Array.isArray(payload.fileBlobs), "validation", "Workspace export fileBlobs must be an array");
  assertExport(Array.isArray(payload.generatedPages), "validation", "Workspace export generatedPages must be an array");
  assertExport(Array.isArray(payload.chatThreads), "validation", "Workspace export chatThreads must be an array");
  assertExport(Array.isArray(payload.chatMessages), "validation", "Workspace export chatMessages must be an array");
  assertExport(Array.isArray(payload.selectedContexts), "validation", "Workspace export selectedContexts must be an array");

  assertUniqueIds("documents", payload.documents);
  assertUniqueIds("fileBlobs", payload.fileBlobs);
  assertUniqueIds("generatedPages", payload.generatedPages);
  assertUniqueIds("chatThreads", payload.chatThreads);
  assertUniqueIds("chatMessages", payload.chatMessages);
  assertUniqueIds("selectedContexts", payload.selectedContexts);

  for (const fileBlob of payload.fileBlobs) {
    assertExport(
      typeof fileBlob.dataUrl === "string" && fileBlob.dataUrl.startsWith("data:"),
      "corrupt_export",
      `Invalid blob payload for ${fileBlob.fileName || fileBlob.id}`,
    );
  }

  if (payload.counts) {
    assertExport(payload.counts.workspaces === 1, "validation", "Workspace export count mismatch");
    assertExport(payload.counts.documents === payload.documents.length, "validation", "Document count mismatch");
    assertExport(payload.counts.fileBlobs === payload.fileBlobs.length, "validation", "PDF blob count mismatch");
    assertExport(payload.counts.generatedPages === payload.generatedPages.length, "validation", "Generated page count mismatch");
    assertExport(payload.counts.chatThreads === payload.chatThreads.length, "validation", "Chat thread count mismatch");
    assertExport(payload.counts.chatMessages === payload.chatMessages.length, "validation", "Chat message count mismatch");
    assertExport(payload.counts.selectedContexts === payload.selectedContexts.length, "validation", "Selected context count mismatch");
  }

  validateWorkspaceExportRelations(payload);
}

function validateWorkspaceExportRelations(payload: ExportedWorkspace) {
  const workspaceId = payload.workspace.id;
  const documentIds = new Set(payload.documents.map((record) => record.id));
  const blobIds = new Set(payload.fileBlobs.map((record) => record.id));
  const threadIds = new Set(payload.chatThreads.map((record) => record.id));

  if (payload.workspace.activeDocumentId) {
    assertExport(documentIds.has(payload.workspace.activeDocumentId), "validation", "Workspace activeDocumentId does not exist");
  }
  if (payload.workspace.activeThreadId) {
    assertExport(threadIds.has(payload.workspace.activeThreadId), "validation", "Workspace activeThreadId does not exist");
  }

  for (const document of payload.documents) {
    assertExport(document.workspaceId === workspaceId, "validation", `Document ${document.id} points to a different workspace`);
    if (document.pdfBlobId) {
      assertExport(blobIds.has(document.pdfBlobId), "validation", `Document ${document.id} references a missing PDF blob`);
    }
  }
  for (const fileBlob of payload.fileBlobs) {
    assertExport(fileBlob.workspaceId === workspaceId, "validation", `PDF blob ${fileBlob.id} points to a different workspace`);
    assertExport(documentIds.has(fileBlob.documentId), "validation", `PDF blob ${fileBlob.id} references a missing document`);
  }
  for (const page of payload.generatedPages) {
    assertExport(page.workspaceId === workspaceId, "validation", `Generated page ${page.id} points to a different workspace`);
    assertExport(documentIds.has(page.documentId), "validation", `Generated page ${page.id} references a missing document`);
  }
  for (const thread of payload.chatThreads) {
    assertExport(thread.workspaceId === workspaceId, "validation", `Chat thread ${thread.id} points to a different workspace`);
    if (thread.documentId) {
      assertExport(documentIds.has(thread.documentId), "validation", `Chat thread ${thread.id} references a missing document`);
    }
  }
  for (const message of payload.chatMessages) {
    assertExport(message.workspaceId === workspaceId, "validation", `Chat message ${message.id} points to a different workspace`);
    assertExport(threadIds.has(message.threadId), "validation", `Chat message ${message.id} references a missing thread`);
    if (message.documentId) {
      assertExport(documentIds.has(message.documentId), "validation", `Chat message ${message.id} references a missing document`);
    }
  }
  for (const context of payload.selectedContexts) {
    assertExport(context.workspaceId === workspaceId, "validation", `Selected context ${context.id} points to a different workspace`);
    if (context.documentId) {
      assertExport(documentIds.has(context.documentId), "validation", `Selected context ${context.id} references a missing document`);
    }
  }
  if (payload.settings) {
    assertExport(payload.settings.id === workspaceId || payload.settings.id === "global", "validation", "Settings record scope does not match workspace");
  }
}

function assertUniqueIds(label: string, records: Array<{ id?: string }>) {
  const seen = new Set<string>();
  for (const record of records) {
    assertExport(Boolean(record.id), "validation", `${label} contains a record without id`);
    if (!record.id) continue;
    assertExport(!seen.has(record.id), "validation", `${label} contains duplicate id ${record.id}`);
    seen.add(record.id);
  }
}

function assertExport(
  condition: unknown,
  kind: "validation" | "corrupt_export",
  message: string,
): asserts condition {
  if (!condition) throw new PersistenceError(kind, message);
}

export function chatMessageToThreadMessageLike(message: ChatMessageRecord): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.contentMarkdown || message.content,
    createdAt: new Date(message.createdAt),
    status:
      message.role === "assistant"
        ? message.status === "failed"
          ? { type: "incomplete", reason: "error" }
          : message.status === "stopped"
            ? { type: "incomplete", reason: "cancelled" }
            : message.status === "pending" || message.status === "streaming"
              ? { type: "incomplete", reason: "cancelled" }
              : { type: "complete", reason: "stop" }
        : undefined,
    metadata: {
      custom: {
        selectedContext: message.selectedContext || null,
        sourceRefs: message.sourceRefs || [],
      },
    },
  };
}

export function threadMessagesToRepository(messages: ChatMessageRecord[]) {
  return ExportedMessageRepository.fromArray(messages.map(chatMessageToThreadMessageLike));
}

async function hashBlob(blob: Blob) {
  if (!crypto.subtle) return undefined;
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}
