import type { UiPreferences } from "../../settings";

export const persistenceSchemaVersion = 2;
export const lastWorkspaceStorageKey = "pagepair.lastWorkspaceId.v1";

export type PersistedJson = Record<string, unknown>;

export type WorkspaceRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  activeDocumentId?: string;
  activeThreadId?: string;
  currentGeneratedPageIndex: number;
  currentPdfPageNumber: number;
  layoutState?: PersistedJson;
  settingsSnapshot?: UiPreferences;
  version: number;
};

export type DocumentRecord = {
  id: string;
  workspaceId: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  hash?: string;
  pageCount: number;
  uploadedAt: number;
  updatedAt: number;
  pdfBlobId?: string;
  currentPdfPageNumber: number;
  status: "draft" | "ready" | "missing-file" | "failed";
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
  document: DocumentRecord | null;
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
};

export type WorkspaceExportIntegrity = {
  fileBlobHashes: Record<string, string>;
};

export type ExportedWorkspace = {
  schema: "pagepair.workspace.export.v1";
  app: "pagepair-reader";
  schemaVersion: number;
  exportedAt: number;
  counts: WorkspaceExportCounts;
  integrity: WorkspaceExportIntegrity;
  workspace: WorkspaceRecord;
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
