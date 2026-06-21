import { PersistenceError } from "./autosave";
import { synchroPageDb } from "./db";
import {
  lastWorkspaceStorageKey,
  persistenceSchemaVersion,
  type ChatMessageRole,
  type ChatMessageRecord,
  type ChatMessageStatus,
  type ChatThreadRecord,
  type CourseProjectRecord,
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
  activeProjectId?: string;
};

export type ThreadMessageLike = {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt?: Date;
  status?: unknown;
  metadata?: {
    custom?: {
      selectedContext?: PersistedJson | null;
      sourceRefs?: PersistedJson[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

const defaultCourseProjectName = "默认课程";

function defaultCourseProjectId(workspaceId: string) {
  return `course_${workspaceId}_default`;
}

export function createRecordId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function documentTitleFromFileName(fileName: string, fallback: string) {
  return fileName.replace(/\.pdf$/i, "").trim() || fallback || fileName || "Untitled PDF";
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
    title: input.title || "SynchroPage Workspace",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    currentGeneratedPageIndex: 0,
    currentPdfPageNumber: 1,
    layoutState: input.layoutState,
    settingsSnapshot: input.settingsSnapshot,
    version: persistenceSchemaVersion,
  };
  await synchroPageDb.workspaces.put(workspace);
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

async function ensureDefaultCourseProject(workspace: WorkspaceRecord) {
  const projectId = workspace.activeProjectId || defaultCourseProjectId(workspace.id);
  const now = Date.now();
  const existing = await synchroPageDb.courseProjects.get(projectId);
  const documents = await synchroPageDb.documents.where("workspaceId").equals(workspace.id).toArray();
  if (!existing) {
    const activeDocument = documents.find((document) => document.id === workspace.activeDocumentId) || documents[0];
    const project: CourseProjectRecord = {
      id: projectId,
      workspaceId: workspace.id,
      name: defaultCourseProjectName,
      description: "",
      color: "clay",
      icon: "book-open",
      createdAt: workspace.createdAt || now,
      updatedAt: workspace.updatedAt || now,
      lastOpenedAt: workspace.lastOpenedAt || now,
      documentCount: documents.length,
      activeDocumentId: activeDocument?.id,
    };
    await synchroPageDb.courseProjects.put(project);
  }
  for (const document of documents.filter((item) => !item.projectId)) {
    await synchroPageDb.documents.update(document.id, {
      projectId,
      lastOpenedAt: document.lastOpenedAt || document.updatedAt || now,
    });
  }
  if (!workspace.activeProjectId) {
    await synchroPageDb.workspaces.update(workspace.id, {
      activeProjectId: projectId,
      updatedAt: now,
      version: persistenceSchemaVersion,
    });
  }
  return projectId;
}

export async function loadCourseProjects(workspaceId: string, activeProjectId?: string | null) {
  const workspace = await synchroPageDb.workspaces.get(workspaceId);
  if (!workspace) return [];
  const ensuredActiveProjectId = activeProjectId || workspace.activeProjectId || await ensureDefaultCourseProject(workspace);
  const [projects, documents] = await Promise.all([
    synchroPageDb.courseProjects.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.documents.where("workspaceId").equals(workspaceId).toArray(),
  ]);
  const documentCounts = documents.reduce((counts, document) => {
    const projectId = document.projectId || ensuredActiveProjectId;
    counts.set(projectId, (counts.get(projectId) || 0) + 1);
    return counts;
  }, new Map<string, number>());

  return projects
    .slice()
    .sort((left, right) => (left.createdAt || left.updatedAt || 0) - (right.createdAt || right.updatedAt || 0))
    .map((project) => ({
      ...project,
      documentCount: documentCounts.get(project.id) || 0,
    }));
}

export async function createCourseProject(input: {
  workspaceId: string;
  name: string;
  description?: string;
}) {
  const now = Date.now();
  const name = input.name.trim() || defaultCourseProjectName;
  const project: CourseProjectRecord = {
    id: createRecordId("course"),
    workspaceId: input.workspaceId,
    name,
    description: input.description || "",
    color: "clay",
    icon: "book-open",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    documentCount: 0,
  };
  await synchroPageDb.transaction("rw", synchroPageDb.courseProjects, synchroPageDb.workspaces, async () => {
    await synchroPageDb.courseProjects.put(project);
    await synchroPageDb.workspaces.update(input.workspaceId, {
      activeProjectId: project.id,
      updatedAt: now,
      lastOpenedAt: now,
    });
  });
  return project;
}

export async function loadWorkspaceDocuments(
  workspaceId: string,
  activeDocumentId?: string | null,
  projectId?: string | null,
): Promise<DocumentSidebarItem[]> {
  const documents = projectId
    ? (await synchroPageDb.documents.where("projectId").equals(projectId).toArray())
        .filter((document) => document.workspaceId === workspaceId)
    : await synchroPageDb.documents.where("workspaceId").equals(workspaceId).toArray();
  const visibleDocuments = documents
    .sort((left, right) => (left.uploadedAt || left.updatedAt || 0) - (right.uploadedAt || right.updatedAt || 0));
  const generatedCounts = await loadGeneratedPageCounts(visibleDocuments.map((document) => document.id));

  return visibleDocuments.map((document) => ({
    id: document.id,
    workspaceId: document.workspaceId,
    documentId: document.id,
    projectId: document.projectId,
    title: document.mimeType === "application/pdf"
      ? documentTitleFromFileName(document.fileName, document.title)
      : document.title,
    fileName: document.fileName,
    mimeType: document.mimeType,
    pageCount: document.pageCount,
    currentPdfPageNumber: document.currentPdfPageNumber,
    generatedPageCount: generatedCounts.get(document.id) || 0,
    status: document.status,
    updatedAt: document.updatedAt,
    uploadedAt: document.uploadedAt,
    lastOpenedAt: document.lastOpenedAt,
    isStarred: document.isStarred,
    isActive: document.id === activeDocumentId,
  }));
}

async function loadGeneratedPageCounts(documentIds: string[]) {
  const counts = new Map<string, number>();
  if (!documentIds.length) return counts;
  const collection = documentIds.length === 1
    ? synchroPageDb.generatedPages.where("documentId").equals(documentIds[0])
    : synchroPageDb.generatedPages.where("documentId").anyOf(documentIds);
  await collection.each((page) => {
    if (page.status === "completed" && page.markdown.trim()) {
      counts.set(page.documentId, (counts.get(page.documentId) || 0) + 1);
    }
  });
  return counts;
}

export async function loadWorkspace(workspaceId: string): Promise<LoadedWorkspace | null> {
  const workspace = await synchroPageDb.workspaces.get(workspaceId);
  if (!workspace) {
    setLastWorkspaceId(null);
    return null;
  }

  const activeProjectId = workspace.activeProjectId || await ensureDefaultCourseProject(workspace);
  const courseProjects = await loadCourseProjects(workspace.id, activeProjectId);
  const activeProject = courseProjects.find((project) => project.id === activeProjectId) || courseProjects[0] || null;
  let document = activeProject?.activeDocumentId
    ? (await synchroPageDb.documents.get(activeProject.activeDocumentId)) || null
    : null;
  if (document && activeProject && document.projectId !== activeProject.id) document = null;
  if (!document && workspace.activeDocumentId) {
    const candidate = await synchroPageDb.documents.get(workspace.activeDocumentId);
    document = candidate && (!activeProject || candidate.projectId === activeProject.id) ? candidate : null;
  }
  if (!document) {
    const documents = await synchroPageDb.documents.where("workspaceId").equals(workspace.id).sortBy("updatedAt");
    const projectDocuments = activeProject ? documents.filter((item) => item.projectId === activeProject.id) : documents;
    document = projectDocuments.at(-1) || documents.at(-1) || null;
  }
  if (document && !document.projectId) {
    const projectId = activeProject?.id || activeProjectId;
    await synchroPageDb.documents.update(document.id, { projectId });
    document = { ...document, projectId };
  }
  const pdfBlob = document?.pdfBlobId
    ? (await synchroPageDb.fileBlobs.get(document.pdfBlobId)) || null
    : null;
  const generatedPages = document
    ? await synchroPageDb.generatedPages
        .where("documentId")
        .equals(document.id)
        .sortBy("generatedPageIndex")
    : [];
  let thread = workspace.activeThreadId
    ? (await synchroPageDb.chatThreads.get(workspace.activeThreadId)) || null
    : document
      ? (await synchroPageDb.chatThreads.where("documentId").equals(document.id).last()) || null
      : null;
  if (document && thread?.documentId !== document.id) {
    const threads = await synchroPageDb.chatThreads.where("documentId").equals(document.id).sortBy("updatedAt");
    thread = threads.at(-1) || null;
  }
  const messages = thread
    ? await synchroPageDb.chatMessages.where("threadId").equals(thread.id).sortBy("createdAt")
    : [];
  const selectedContext = document
    ? (await synchroPageDb.selectedContexts.where("documentId").equals(document.id).last()) || null
    : null;
  const settings = (await loadSettings(workspaceId)) || null;
  const documentItems = await loadWorkspaceDocuments(workspace.id, document?.id || workspace.activeDocumentId);

  await synchroPageDb.workspaces.update(workspace.id, {
    activeProjectId: activeProject?.id || activeProjectId,
    activeDocumentId: document?.id || workspace.activeDocumentId,
    activeThreadId: thread?.id || workspace.activeThreadId,
    lastOpenedAt: Date.now(),
  });
  setLastWorkspaceId(workspace.id);

  return {
    workspace: {
      ...workspace,
      activeProjectId: activeProject?.id || activeProjectId,
      activeDocumentId: document?.id || workspace.activeDocumentId,
      activeThreadId: thread?.id || workspace.activeThreadId,
    },
    courseProjects,
    activeProject,
    document,
    documentItems,
    pdfBlob,
    generatedPages,
    thread,
    messages,
    selectedContext,
    settings,
  };
}

export async function loadWorkspaceDocument(
  workspaceId: string,
  documentId: string,
): Promise<LoadedWorkspace> {
  const [workspace, document] = await Promise.all([
    synchroPageDb.workspaces.get(workspaceId),
    synchroPageDb.documents.get(documentId),
  ]);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  if (!document || document.workspaceId !== workspaceId) {
    throw new PersistenceError("not_found", "Document not found");
  }
  const projectId = document.projectId || workspace.activeProjectId || await ensureDefaultCourseProject(workspace);
  if (!document.projectId) await synchroPageDb.documents.update(document.id, { projectId });
  const project = (await synchroPageDb.courseProjects.get(projectId)) || null;

  const pdfBlob = document.pdfBlobId
    ? (await synchroPageDb.fileBlobs.get(document.pdfBlobId)) || null
    : null;
  const generatedPages = await synchroPageDb.generatedPages
    .where("documentId")
    .equals(document.id)
    .sortBy("generatedPageIndex");
  let thread = workspace.activeThreadId
    ? (await synchroPageDb.chatThreads.get(workspace.activeThreadId)) || null
    : null;
  if (thread?.documentId !== document.id) thread = null;
  if (!thread) {
    const threads = await synchroPageDb.chatThreads.where("documentId").equals(document.id).sortBy("updatedAt");
    thread = threads.at(-1) || null;
  }
  if (!thread) {
    thread = await createChatThread({
      workspaceId,
      documentId: document.id,
      title: "Main chat",
    });
  }
  const messages = await synchroPageDb.chatMessages.where("threadId").equals(thread.id).sortBy("createdAt");
  const selectedContext = (await synchroPageDb.selectedContexts.where("documentId").equals(document.id).last()) || null;
  const settings = (await loadSettings(workspaceId)) || null;
  const now = Date.now();
  const nextWorkspace: WorkspaceRecord = {
    ...workspace,
    activeProjectId: projectId,
    activeDocumentId: document.id,
    activeThreadId: thread.id,
    currentPdfPageNumber: document.currentPdfPageNumber || 1,
    updatedAt: now,
    lastOpenedAt: now,
  };
  await synchroPageDb.transaction("rw", synchroPageDb.workspaces, synchroPageDb.documents, synchroPageDb.courseProjects, async () => {
    await synchroPageDb.documents.update(document.id, {
      projectId,
      lastOpenedAt: now,
      updatedAt: now,
    });
    await synchroPageDb.courseProjects.update(projectId, {
      activeDocumentId: document.id,
      lastOpenedAt: now,
      updatedAt: now,
    });
    await synchroPageDb.workspaces.update(workspace.id, {
      activeProjectId: projectId,
      activeDocumentId: document.id,
      activeThreadId: thread.id,
      currentPdfPageNumber: document.currentPdfPageNumber || 1,
      updatedAt: now,
      lastOpenedAt: now,
    });
  });
  setLastWorkspaceId(workspace.id);
  const courseProjects = await loadCourseProjects(workspace.id, projectId);

  return {
    workspace: nextWorkspace,
    courseProjects,
    activeProject: courseProjects.find((item) => item.id === projectId) || project,
    document: { ...document, projectId, lastOpenedAt: now, updatedAt: now },
    documentItems: await loadWorkspaceDocuments(workspace.id, document.id),
    pdfBlob,
    generatedPages,
    thread,
    messages,
    selectedContext,
    settings,
  };
}

export async function loadDocumentGenerationBundle(
  workspaceId: string,
  documentId: string,
) {
  const document = await synchroPageDb.documents.get(documentId);
  if (!document || document.workspaceId !== workspaceId) {
    throw new PersistenceError("not_found", "Document not found");
  }
  const [pdfBlob, generatedPages] = await Promise.all([
    document.pdfBlobId ? synchroPageDb.fileBlobs.get(document.pdfBlobId) : Promise.resolve(null),
    synchroPageDb.generatedPages
      .where("documentId")
      .equals(document.id)
      .sortBy("generatedPageIndex"),
  ]);
  return {
    document,
    pdfBlob: pdfBlob || null,
    generatedPages,
  };
}

export async function loadWorkspaceProject(
  workspaceId: string,
  projectId: string,
): Promise<LoadedWorkspace> {
  const [workspace, project] = await Promise.all([
    synchroPageDb.workspaces.get(workspaceId),
    synchroPageDb.courseProjects.get(projectId),
  ]);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  if (!project || project.workspaceId !== workspaceId) {
    throw new PersistenceError("not_found", "Course project not found");
  }
  const documents = await synchroPageDb.documents.where("projectId").equals(projectId).sortBy("updatedAt");
  const activeDocument =
    (project.activeDocumentId ? documents.find((document) => document.id === project.activeDocumentId) : undefined) ||
    documents.slice().sort((left, right) => (right.lastOpenedAt || right.updatedAt) - (left.lastOpenedAt || left.updatedAt))[0];
  if (activeDocument) return loadWorkspaceDocument(workspaceId, activeDocument.id);

  const now = Date.now();
  await synchroPageDb.transaction("rw", synchroPageDb.workspaces, synchroPageDb.courseProjects, async () => {
    await synchroPageDb.courseProjects.update(projectId, {
      lastOpenedAt: now,
      updatedAt: now,
    });
    await synchroPageDb.workspaces.update(workspaceId, {
      activeProjectId: projectId,
      activeDocumentId: undefined,
      activeThreadId: undefined,
      updatedAt: now,
      lastOpenedAt: now,
    });
  });
  setLastWorkspaceId(workspace.id);
  const [courseProjects, settings] = await Promise.all([
    loadCourseProjects(workspaceId, projectId),
    loadSettings(workspaceId),
  ]);

  return {
    workspace: {
      ...workspace,
      activeProjectId: projectId,
      activeDocumentId: undefined,
      activeThreadId: undefined,
      updatedAt: now,
      lastOpenedAt: now,
    },
    courseProjects,
    activeProject: courseProjects.find((item) => item.id === projectId) || { ...project, lastOpenedAt: now, updatedAt: now },
    document: null,
    documentItems: await loadWorkspaceDocuments(workspaceId, null),
    pdfBlob: null,
    generatedPages: [],
    thread: null,
    messages: [],
    selectedContext: null,
    settings: settings || null,
  };
}

export async function saveWorkspacePatch(workspaceId: string, patch: Partial<WorkspaceRecord>) {
  await synchroPageDb.workspaces.update(workspaceId, {
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
    const existing = await synchroPageDb.workspaces.get(input.workspaceId);
    if (existing) return existing;
  }
  return createWorkspace(input);
}

export async function savePdfBlob(input: {
  workspaceId?: string | null;
  projectId?: string | null;
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
  const projectId = input.projectId || workspace.activeProjectId || await ensureDefaultCourseProject(workspace);
  const documentId = createRecordId("doc");
  const blobId = createRecordId("blob");
  const threadId = createRecordId("thread");
  const document: DocumentRecord = {
    id: documentId,
    workspaceId: workspace.id,
    projectId,
    title,
    fileName: input.file.name || `${title}.pdf`,
    mimeType: input.file.type || "application/pdf",
    size: input.file.size || 0,
    hash: undefined,
    pageCount: 0,
    uploadedAt: now,
    updatedAt: now,
    lastOpenedAt: now,
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

  const project = await synchroPageDb.courseProjects.get(projectId);
  await synchroPageDb.transaction("rw", [
    synchroPageDb.workspaces,
    synchroPageDb.courseProjects,
    synchroPageDb.documents,
    synchroPageDb.fileBlobs,
    synchroPageDb.chatThreads,
    synchroPageDb.selectedContexts,
  ], async () => {
    await synchroPageDb.documents.put(document);
    await synchroPageDb.fileBlobs.put(fileBlob);
    await synchroPageDb.chatThreads.put(thread);
    await synchroPageDb.selectedContexts.where("workspaceId").equals(workspace.id).delete();
    await synchroPageDb.courseProjects.update(projectId, {
      activeDocumentId: document.id,
      documentCount: (project?.documentCount || 0) + 1,
      updatedAt: now,
      lastOpenedAt: now,
    });
    await synchroPageDb.workspaces.update(workspace.id, {
      title,
      activeProjectId: projectId,
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
  void hashBlob(input.file)
    .then((hash) => {
      if (!hash) return undefined;
      return synchroPageDb.documents.update(documentId, { hash, updatedAt: Date.now() });
    })
    .catch(() => undefined);
  setLastWorkspaceId(workspace.id);
  return { workspace: { ...workspace, activeProjectId: projectId, activeDocumentId: document.id, activeThreadId: thread.id }, document, fileBlob, thread };
}

export async function loadPdfBlob(blobId: string) {
  return (await synchroPageDb.fileBlobs.get(blobId)) || null;
}

export async function saveDocumentPatch(documentId: string, patch: Partial<DocumentRecord>) {
  await synchroPageDb.documents.update(documentId, {
    ...patch,
    updatedAt: Date.now(),
  });
}

async function deleteDocumentCascade(documentIds: string[]) {
  if (!documentIds.length) return;
  const threads = await synchroPageDb.chatThreads.where("documentId").anyOf(documentIds).toArray();
  const threadIds = threads.map((thread) => thread.id);
  await Promise.all([
    synchroPageDb.documents.bulkDelete(documentIds),
    synchroPageDb.fileBlobs.where("documentId").anyOf(documentIds).delete(),
    synchroPageDb.generatedPages.where("documentId").anyOf(documentIds).delete(),
    synchroPageDb.chatThreads.where("documentId").anyOf(documentIds).delete(),
    threadIds.length ? synchroPageDb.chatMessages.where("threadId").anyOf(threadIds).delete() : Promise.resolve(),
    synchroPageDb.selectedContexts.where("documentId").anyOf(documentIds).delete(),
  ]);
}

async function loadWorkspaceAfterNavigationChange(workspaceId: string, preferredProjectId?: string | null) {
  const workspace = await synchroPageDb.workspaces.get(workspaceId);
  if (!workspace) return null;
  if (workspace.activeDocumentId) {
    const activeDocument = await synchroPageDb.documents.get(workspace.activeDocumentId);
    if (activeDocument?.workspaceId === workspaceId) return loadWorkspaceDocument(workspaceId, activeDocument.id);
  }

  const preferredProject = preferredProjectId ? await synchroPageDb.courseProjects.get(preferredProjectId) : null;
  if (preferredProject?.workspaceId === workspaceId) return loadWorkspaceProject(workspaceId, preferredProject.id);
  if (workspace.activeProjectId) {
    const activeProject = await synchroPageDb.courseProjects.get(workspace.activeProjectId);
    if (activeProject?.workspaceId === workspaceId) return loadWorkspaceProject(workspaceId, activeProject.id);
  }
  const projects = await loadCourseProjects(workspaceId);
  if (projects[0]) return loadWorkspaceProject(workspaceId, projects[0].id);
  const defaultProjectId = await ensureDefaultCourseProject(workspace);
  return loadWorkspaceProject(workspaceId, defaultProjectId);
}

export async function deleteWorkspaceDocument(workspaceId: string, documentId: string): Promise<LoadedWorkspace | null> {
  const [workspace, document] = await Promise.all([
    synchroPageDb.workspaces.get(workspaceId),
    synchroPageDb.documents.get(documentId),
  ]);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  if (!document || document.workspaceId !== workspaceId) {
    throw new PersistenceError("not_found", "Document not found");
  }
  const now = Date.now();
  const projectId = document.projectId || workspace.activeProjectId || await ensureDefaultCourseProject(workspace);
  const project = await synchroPageDb.courseProjects.get(projectId);

  await synchroPageDb.transaction(
    "rw",
    [
      synchroPageDb.workspaces,
      synchroPageDb.courseProjects,
      synchroPageDb.documents,
      synchroPageDb.fileBlobs,
      synchroPageDb.generatedPages,
      synchroPageDb.chatThreads,
      synchroPageDb.chatMessages,
      synchroPageDb.selectedContexts,
    ],
    async () => {
      await deleteDocumentCascade([documentId]);
      const workspacePatch: Partial<WorkspaceRecord> = {
        updatedAt: now,
        lastOpenedAt: now,
      };
      if (workspace.activeDocumentId === documentId) {
        workspacePatch.activeDocumentId = undefined;
        workspacePatch.activeThreadId = undefined;
        workspacePatch.currentGeneratedPageIndex = 0;
        workspacePatch.currentPdfPageNumber = 1;
      }
      await synchroPageDb.workspaces.update(workspaceId, workspacePatch);
      await synchroPageDb.courseProjects.update(projectId, {
        activeDocumentId: project?.activeDocumentId === documentId ? undefined : project?.activeDocumentId,
        updatedAt: now,
        lastOpenedAt: now,
      });
    },
  );

  return loadWorkspaceAfterNavigationChange(workspaceId, projectId);
}

export async function deleteCourseProject(workspaceId: string, projectId: string): Promise<LoadedWorkspace | null> {
  const [workspace, project] = await Promise.all([
    synchroPageDb.workspaces.get(workspaceId),
    synchroPageDb.courseProjects.get(projectId),
  ]);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  if (!project || project.workspaceId !== workspaceId) {
    throw new PersistenceError("not_found", "Course project not found");
  }
  const now = Date.now();
  const [documents, projects] = await Promise.all([
    synchroPageDb.documents.where("projectId").equals(projectId).toArray(),
    synchroPageDb.courseProjects.where("workspaceId").equals(workspaceId).toArray(),
  ]);
  const documentIds = documents.map((document) => document.id);
  const deletesActiveProject = workspace.activeProjectId === projectId;
  const deletesActiveDocument = Boolean(workspace.activeDocumentId && documentIds.includes(workspace.activeDocumentId));
  const nextProject = projects
    .filter((item) => item.id !== projectId)
    .sort((left, right) => (right.lastOpenedAt || right.updatedAt) - (left.lastOpenedAt || left.updatedAt))[0];

  await synchroPageDb.transaction(
    "rw",
    [
      synchroPageDb.workspaces,
      synchroPageDb.courseProjects,
      synchroPageDb.documents,
      synchroPageDb.fileBlobs,
      synchroPageDb.generatedPages,
      synchroPageDb.chatThreads,
      synchroPageDb.chatMessages,
      synchroPageDb.selectedContexts,
    ],
    async () => {
      await deleteDocumentCascade(documentIds);
      await synchroPageDb.courseProjects.delete(projectId);
      await synchroPageDb.workspaces.update(workspaceId, {
        activeProjectId: deletesActiveProject ? nextProject?.id : workspace.activeProjectId,
        activeDocumentId: deletesActiveDocument ? undefined : workspace.activeDocumentId,
        activeThreadId: deletesActiveDocument ? undefined : workspace.activeThreadId,
        currentGeneratedPageIndex: deletesActiveDocument ? 0 : workspace.currentGeneratedPageIndex,
        currentPdfPageNumber: deletesActiveDocument ? 1 : workspace.currentPdfPageNumber,
        updatedAt: now,
        lastOpenedAt: now,
      });
      if (deletesActiveProject && nextProject) {
        await synchroPageDb.courseProjects.update(nextProject.id, {
          activeDocumentId: undefined,
          updatedAt: now,
          lastOpenedAt: now,
        });
      }
    },
  );

  const nextWorkspace = await synchroPageDb.workspaces.get(workspaceId);
  if (!nextWorkspace) return null;
  if (!deletesActiveProject) return loadWorkspaceAfterNavigationChange(workspaceId, workspace.activeProjectId);
  const nextProjectId = nextProject?.id || await ensureDefaultCourseProject(nextWorkspace);
  return loadWorkspaceProject(workspaceId, nextProjectId);
}

export async function saveGeneratedPagesFromPack(input: {
  workspaceId: string;
  documentId: string;
  pack: PagePackLike;
}) {
  const now = Date.now();
  const document = await synchroPageDb.documents.get(input.documentId);
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
  await synchroPageDb.transaction("rw", synchroPageDb.documents, synchroPageDb.generatedPages, synchroPageDb.workspaces, async () => {
    await synchroPageDb.generatedPages.where("documentId").equals(input.documentId).delete();
    if (records.length) await synchroPageDb.generatedPages.bulkPut(records);
    await synchroPageDb.documents.update(input.documentId, {
      title: document?.mimeType === "application/pdf"
        ? documentTitleFromFileName(document.fileName, document.title)
        : input.pack.document.title,
      pageCount: Math.max(input.pack.document.page_count || 0, records.length),
      updatedAt: now,
    });
    await synchroPageDb.workspaces.update(input.workspaceId, {
      title: input.pack.document.title,
      updatedAt: now,
    });
  });
}

export async function saveImportedPagePack(input: {
  workspaceId?: string | null;
  projectId?: string | null;
  pack: PagePackLike;
  settingsSnapshot?: UiPreferences;
  layoutState?: LayoutPatch;
}) {
  const now = Date.now();
  const title = input.pack.document.title || "Imported SynchroPage";
  const workspace = await ensureWorkspace({
    workspaceId: input.workspaceId,
    title,
    settingsSnapshot: input.settingsSnapshot,
    layoutState: input.layoutState,
  });
  const projectId = input.projectId || workspace.activeProjectId || await ensureDefaultCourseProject(workspace);
  const documentId = createRecordId("doc");
  const threadId = createRecordId("thread");
  const document: DocumentRecord = {
    id: documentId,
    workspaceId: workspace.id,
    projectId,
    title,
    fileName: input.pack.document.source_pdf_url || `${title}.json`,
    mimeType: "application/json",
    size: 0,
    pageCount: input.pack.document.page_count || input.pack.pages.length,
    uploadedAt: now,
    updatedAt: now,
    lastOpenedAt: now,
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

  const project = await synchroPageDb.courseProjects.get(projectId);
  await synchroPageDb.transaction("rw", [
    synchroPageDb.workspaces,
    synchroPageDb.courseProjects,
    synchroPageDb.documents,
    synchroPageDb.generatedPages,
    synchroPageDb.chatThreads,
    synchroPageDb.selectedContexts,
  ], async () => {
    await synchroPageDb.documents.put(document);
    await synchroPageDb.chatThreads.put(thread);
    await synchroPageDb.selectedContexts.where("workspaceId").equals(workspace.id).delete();
    await synchroPageDb.courseProjects.update(projectId, {
      activeDocumentId: document.id,
      documentCount: (project?.documentCount || 0) + 1,
      updatedAt: now,
      lastOpenedAt: now,
    });
    await synchroPageDb.workspaces.update(workspace.id, {
      title,
      activeProjectId: projectId,
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
  return { workspace: { ...workspace, activeProjectId: projectId, activeDocumentId: document.id, activeThreadId: thread.id }, document, thread };
}

export async function saveGeneratedPage(record: GeneratedPageRecord) {
  await synchroPageDb.generatedPages.put({
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
  await synchroPageDb.transaction("rw", synchroPageDb.chatThreads, synchroPageDb.workspaces, async () => {
    await synchroPageDb.chatThreads.put(thread);
    await synchroPageDb.workspaces.update(input.workspaceId, {
      activeThreadId: thread.id,
      updatedAt: now,
    });
  });
  return thread;
}

export async function saveChatMessage(message: ChatMessageRecord) {
  const now = Date.now();
  await synchroPageDb.transaction("rw", synchroPageDb.chatMessages, synchroPageDb.chatThreads, synchroPageDb.workspaces, async () => {
    await synchroPageDb.chatMessages.put({
      ...message,
      updatedAt: now,
    });
    await synchroPageDb.chatThreads.update(message.threadId, { updatedAt: now });
    await synchroPageDb.workspaces.update(message.workspaceId, { updatedAt: now });
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
  const existing = await synchroPageDb.chatMessages.get(input.id);
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
  await synchroPageDb.selectedContexts.put(record);
  return record;
}

export async function clearSelectedContext(workspaceId: string, documentId?: string) {
  if (documentId) {
    await synchroPageDb.selectedContexts.where("documentId").equals(documentId).delete();
    return;
  }
  await synchroPageDb.selectedContexts.where("workspaceId").equals(workspaceId).delete();
}

export async function saveSettings(settings: UiPreferences, workspaceId = "global") {
  const record: SettingsRecord = {
    ...settings,
    id: workspaceId,
    updatedAt: Date.now(),
  };
  await synchroPageDb.settings.put(record);
  if (workspaceId !== "global") {
    await synchroPageDb.workspaces.update(workspaceId, {
      settingsSnapshot: settings,
      updatedAt: record.updatedAt,
    });
  }
  return record;
}

export async function loadSettings(workspaceId = "global") {
  return (await synchroPageDb.settings.get(workspaceId)) || (workspaceId !== "global" ? await synchroPageDb.settings.get("global") : null);
}

export async function estimateStorage(): Promise<StorageEstimate> {
  const [estimate, persisted, workspaceCount, documentCount] = await Promise.all([
    navigator.storage?.estimate?.().catch(() => null),
    navigator.storage?.persisted?.().catch(() => null),
    synchroPageDb.workspaces.count(),
    synchroPageDb.documents.count(),
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
    workspaceId ? synchroPageDb.workspaces.where("id").equals(workspaceId).toArray() : synchroPageDb.workspaces.toArray(),
    workspaceId ? synchroPageDb.documents.where("workspaceId").equals(workspaceId).toArray() : synchroPageDb.documents.toArray(),
    workspaceId ? synchroPageDb.fileBlobs.where("workspaceId").equals(workspaceId).toArray() : synchroPageDb.fileBlobs.toArray(),
    workspaceId ? synchroPageDb.generatedPages.where("workspaceId").equals(workspaceId).toArray() : synchroPageDb.generatedPages.toArray(),
    workspaceId ? synchroPageDb.chatThreads.where("workspaceId").equals(workspaceId).toArray() : synchroPageDb.chatThreads.toArray(),
    workspaceId ? synchroPageDb.chatMessages.where("workspaceId").equals(workspaceId).toArray() : synchroPageDb.chatMessages.toArray(),
    workspaceId ? synchroPageDb.selectedContexts.where("workspaceId").equals(workspaceId).toArray() : synchroPageDb.selectedContexts.toArray(),
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

  await synchroPageDb.transaction(
    "rw",
    [
      synchroPageDb.workspaces,
      synchroPageDb.courseProjects,
      synchroPageDb.documents,
      synchroPageDb.fileBlobs,
      synchroPageDb.generatedPages,
      synchroPageDb.chatThreads,
      synchroPageDb.chatMessages,
      synchroPageDb.selectedContexts,
    ],
    async () => {
      if (orphanFileBlobIds.length) await synchroPageDb.fileBlobs.bulkDelete(orphanFileBlobIds);
      if (orphanGeneratedPageIds.length) await synchroPageDb.generatedPages.bulkDelete(orphanGeneratedPageIds);
      if (orphanThreadIds.length) await synchroPageDb.chatThreads.bulkDelete(orphanThreadIds);
      if (orphanMessageIds.length) await synchroPageDb.chatMessages.bulkDelete(orphanMessageIds);
      if (orphanContextIds.length) await synchroPageDb.selectedContexts.bulkDelete(orphanContextIds);
      for (const documentId of missingBlobDocuments) {
        await synchroPageDb.documents.update(documentId, { status: "missing-file", updatedAt: Date.now() });
      }
      for (const workspace of workspaces) {
        const patch: Partial<WorkspaceRecord> = {};
        if (workspace.activeDocumentId && !documentIds.has(workspace.activeDocumentId)) patch.activeDocumentId = undefined;
        if (workspace.activeThreadId && !threadIds.has(workspace.activeThreadId)) patch.activeThreadId = undefined;
        if (Object.keys(patch).length) {
          patch.updatedAt = Date.now();
          await synchroPageDb.workspaces.update(workspace.id, patch);
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
  await synchroPageDb.transaction(
    "rw",
    [
      synchroPageDb.workspaces,
      synchroPageDb.courseProjects,
      synchroPageDb.documents,
      synchroPageDb.fileBlobs,
      synchroPageDb.generatedPages,
      synchroPageDb.chatThreads,
      synchroPageDb.chatMessages,
      synchroPageDb.selectedContexts,
      synchroPageDb.settings,
    ],
    async () => {
      await Promise.all([
        synchroPageDb.documents.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.courseProjects.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.fileBlobs.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.generatedPages.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.chatThreads.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.chatMessages.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.selectedContexts.where("workspaceId").equals(workspaceId).delete(),
        synchroPageDb.settings.delete(workspaceId),
        synchroPageDb.workspaces.delete(workspaceId),
      ]);
    },
  );
  if (getLastWorkspaceId() === workspaceId) setLastWorkspaceId(null);
}

export async function exportWorkspace(workspaceId: string): Promise<ExportedWorkspace> {
  const workspace = await synchroPageDb.workspaces.get(workspaceId);
  if (!workspace) throw new PersistenceError("not_found", "Workspace not found");
  const [courseProjects, documents, fileBlobRecords, generatedPages, chatThreads, chatMessages, selectedContexts, settings] = await Promise.all([
    synchroPageDb.courseProjects.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.documents.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.fileBlobs.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.generatedPages.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.chatThreads.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.chatMessages.where("workspaceId").equals(workspaceId).toArray(),
    synchroPageDb.selectedContexts.where("workspaceId").equals(workspaceId).toArray(),
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
    schema: "synchropage.workspace.export.v1",
    app: "synchropage-reader",
    schemaVersion: persistenceSchemaVersion,
    exportedAt: Date.now(),
    counts: {
      workspaces: 1,
      courseProjects: courseProjects.length,
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
    courseProjects,
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
  await synchroPageDb.transaction(
    "rw",
    [
      synchroPageDb.workspaces,
      synchroPageDb.documents,
      synchroPageDb.fileBlobs,
      synchroPageDb.generatedPages,
      synchroPageDb.chatThreads,
      synchroPageDb.chatMessages,
      synchroPageDb.selectedContexts,
      synchroPageDb.settings,
    ],
    async () => {
      await synchroPageDb.workspaces.put({
        ...payload.workspace,
        version: payload.workspace.version || persistenceSchemaVersion,
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
      });
      if (payload.courseProjects?.length) await synchroPageDb.courseProjects.bulkPut(payload.courseProjects);
      await synchroPageDb.documents.bulkPut(payload.documents);
      if (fileBlobs.length) await synchroPageDb.fileBlobs.bulkPut(fileBlobs);
      if (payload.generatedPages.length) await synchroPageDb.generatedPages.bulkPut(payload.generatedPages);
      if (payload.chatThreads.length) await synchroPageDb.chatThreads.bulkPut(payload.chatThreads);
      if (payload.chatMessages.length) await synchroPageDb.chatMessages.bulkPut(payload.chatMessages);
      if (payload.selectedContexts.length) await synchroPageDb.selectedContexts.bulkPut(payload.selectedContexts);
      if (payload.settings) await synchroPageDb.settings.put(payload.settings);
    },
  );
  setLastWorkspaceId(payload.workspace.id);
  return payload.workspace.id;
}

function validateWorkspaceExportPayload(payload: ExportedWorkspace) {
  assertExport(Boolean(payload && typeof payload === "object"), "corrupt_export", "Invalid workspace export");
  assertExport(payload.schema === "synchropage.workspace.export.v1", "corrupt_export", "Unsupported workspace export");
  assertExport(Boolean(payload.workspace?.id), "validation", "Workspace export is missing a workspace id");
  if (!Array.isArray(payload.courseProjects)) payload.courseProjects = [];
  assertExport(Array.isArray(payload.documents), "validation", "Workspace export documents must be an array");
  assertExport(Array.isArray(payload.fileBlobs), "validation", "Workspace export fileBlobs must be an array");
  assertExport(Array.isArray(payload.generatedPages), "validation", "Workspace export generatedPages must be an array");
  assertExport(Array.isArray(payload.chatThreads), "validation", "Workspace export chatThreads must be an array");
  assertExport(Array.isArray(payload.chatMessages), "validation", "Workspace export chatMessages must be an array");
  assertExport(Array.isArray(payload.selectedContexts), "validation", "Workspace export selectedContexts must be an array");

  assertUniqueIds("courseProjects", payload.courseProjects);
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
    if (typeof payload.counts.courseProjects === "number") {
      assertExport(payload.counts.courseProjects === payload.courseProjects.length, "validation", "Course project count mismatch");
    }
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
  const projectIds = new Set(payload.courseProjects.map((record) => record.id));
  const documentIds = new Set(payload.documents.map((record) => record.id));
  const blobIds = new Set(payload.fileBlobs.map((record) => record.id));
  const threadIds = new Set(payload.chatThreads.map((record) => record.id));

  if (payload.workspace.activeDocumentId) {
    assertExport(documentIds.has(payload.workspace.activeDocumentId), "validation", "Workspace activeDocumentId does not exist");
  }
  if (payload.workspace.activeProjectId) {
    assertExport(projectIds.has(payload.workspace.activeProjectId), "validation", "Workspace activeProjectId does not exist");
  }
  if (payload.workspace.activeThreadId) {
    assertExport(threadIds.has(payload.workspace.activeThreadId), "validation", "Workspace activeThreadId does not exist");
  }

  for (const project of payload.courseProjects) {
    assertExport(project.workspaceId === workspaceId, "validation", `Course project ${project.id} points to a different workspace`);
    if (project.activeDocumentId) {
      assertExport(documentIds.has(project.activeDocumentId), "validation", `Course project ${project.id} references a missing document`);
    }
  }
  for (const document of payload.documents) {
    assertExport(document.workspaceId === workspaceId, "validation", `Document ${document.id} points to a different workspace`);
    if (document.projectId) {
      assertExport(projectIds.has(document.projectId), "validation", `Document ${document.id} references a missing course project`);
    }
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
