import type { UiPreferences } from "../../settings";

export const persistenceSchemaVersion = 3;
export const lastWorkspaceStorageKey = "synchropage.lastWorkspaceId.v1";

export type PersistedJson = Record<string, unknown>;

export type WorkspaceRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  activeProjectId?: string;
  activeDocumentId?: string;
  activeThreadId?: string;
  currentGeneratedPageIndex: number;
  currentPdfPageNumber: number;
  layoutState?: PersistedJson;
  settingsSnapshot?: UiPreferences;
  version: number;
};

export type CourseProjectRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  documentCount: number;
  activeDocumentId?: string;
};

export type DocumentRecord = {
  id: string;
  projectId?: string;
  workspaceId: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  hash?: string;
  pageCount: number;
  uploadedAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  pdfBlobId?: string;
  currentPdfPageNumber: number;
  status: "draft" | "ready" | "processing" | "missing-file" | "failed";
  isStarred?: boolean;
};

export type DocumentSidebarItem = {
  id: string;
  workspaceId: string;
  documentId: string;
  projectId?: string;
  title: string;
  fileName: string;
  mimeType: string;
  pageCount: number;
  currentPdfPageNumber: number;
  generatedPageCount: number;
  status: DocumentRecord["status"];
  updatedAt: number;
  uploadedAt: number;
  lastOpenedAt?: number;
  isStarred?: boolean;
  isActive: boolean;
};

export type FileBlobRecord = {
  id: string;
  workspaceId: string;
  documentId: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: number;
};

export type GeneratedPageStatus = "pending" | "streaming" | "completed" | "failed";

export type GeneratedPageRecord = {
  id: string;
  workspaceId: string;
  documentId: string;
  generatedPageIndex: number;
  sourcePdfPageNumber: number;
  title: string;
  markdown: string;
  json: PersistedJson;
  confidence?: number;
  status: GeneratedPageStatus;
  errorSummary?: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatThreadRecord = {
  id: string;
  workspaceId: string;
  documentId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatMessageStatus = "pending" | "streaming" | "completed" | "failed" | "stopped";

export type ChatMessageRecord = {
  id: string;
  threadId: string;
  workspaceId: string;
  documentId?: string;
  role: ChatMessageRole;
  content: string;
  contentMarkdown?: string;
  selectedContext?: PersistedJson | null;
  sourceRefs?: PersistedJson[];
  status: ChatMessageStatus;
  createdAt: number;
  updatedAt: number;
};

export type SelectedContextRecord = {
  id: string;
  workspaceId: string;
  documentId?: string;
  text: string;
  sourceType: string;
  pdfPageNumber?: number;
  generatedPageNumber?: number;
  sectionTitle?: string;
  rects?: PersistedJson[];
  payload: PersistedJson;
  createdAt: number;
};

export type SettingsRecord = UiPreferences & {
  id: string;
  updatedAt: number;
};

export type LoadedWorkspace = {
  workspace: WorkspaceRecord;
  courseProjects: CourseProjectRecord[];
  activeProject: CourseProjectRecord | null;
  document: DocumentRecord | null;
  documentItems: DocumentSidebarItem[];
  pdfBlob: FileBlobRecord | null;
  generatedPages: GeneratedPageRecord[];
  thread: ChatThreadRecord | null;
  messages: ChatMessageRecord[];
  selectedContext: SelectedContextRecord | null;
  settings: SettingsRecord | null;
};

export type SaveStatusKind = "draft" | "saving" | "saved" | "error" | "quota";

export type StorageEstimate = {
  usage: number;
  quota: number;
  persisted: boolean | null;
  workspaceCount: number;
  documentCount: number;
};

export type StorageRepairResult = {
  orphanFileBlobs: number;
  orphanGeneratedPages: number;
  orphanChatThreads: number;
  orphanChatMessages: number;
  orphanSelectedContexts: number;
  workspacesRepaired: number;
  documentsMarkedMissing: number;
};

export type WorkspaceExportCounts = {
  workspaces: number;
  documents: number;
  fileBlobs: number;
  generatedPages: number;
  chatThreads: number;
  chatMessages: number;
  selectedContexts: number;
  settings: number;
  courseProjects: number;
};

export type WorkspaceExportIntegrity = {
  fileBlobHashes: Record<string, string>;
};

export type ExportedWorkspace = {
  schema: "synchropage.workspace.export.v1";
  app: "synchropage-reader";
  schemaVersion: number;
  exportedAt: number;
  counts: WorkspaceExportCounts;
  integrity: WorkspaceExportIntegrity;
  workspace: WorkspaceRecord;
  courseProjects: CourseProjectRecord[];
  documents: DocumentRecord[];
  fileBlobs: Array<Omit<FileBlobRecord, "blob"> & { dataUrl: string }>;
  generatedPages: GeneratedPageRecord[];
  chatThreads: ChatThreadRecord[];
  chatMessages: ChatMessageRecord[];
  selectedContexts: SelectedContextRecord[];
  settings: SettingsRecord | null;
};

export interface SyncAdapter {
  pushWorkspace(workspaceId: string): Promise<void>;
  pullWorkspace(workspaceId: string): Promise<void>;
}

export class FutureCloudPersistenceAdapter implements SyncAdapter {
  async pushWorkspace(_workspaceId: string): Promise<void> {
    throw new Error("Cloud sync adapter is not implemented yet.");
  }

  async pullWorkspace(_workspaceId: string): Promise<void> {
    throw new Error("Cloud sync adapter is not implemented yet.");
  }
}
