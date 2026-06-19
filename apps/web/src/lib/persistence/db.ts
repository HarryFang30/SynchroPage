import Dexie, { type Table } from "dexie";
import {
  type ChatMessageRecord,
  type ChatThreadRecord,
  type DocumentRecord,
  type FileBlobRecord,
  type GeneratedPageRecord,
  type SelectedContextRecord,
  type SettingsRecord,
  type WorkspaceRecord,
} from "./schema";
import { upgradeToV2 } from "./migrations";

class PagePairPersistenceDb extends Dexie {
  workspaces!: Table<WorkspaceRecord, string>;
  documents!: Table<DocumentRecord, string>;
  fileBlobs!: Table<FileBlobRecord, string>;
  generatedPages!: Table<GeneratedPageRecord, string>;
  chatThreads!: Table<ChatThreadRecord, string>;
  chatMessages!: Table<ChatMessageRecord, string>;
  selectedContexts!: Table<SelectedContextRecord, string>;
  settings!: Table<SettingsRecord, string>;

  constructor() {
    super("pagepair-reader", { chromeTransactionDurability: "strict" });

    this.version(1).stores({
      workspaces: "id, updatedAt, lastOpenedAt, activeDocumentId, activeThreadId",
      documents: "id, workspaceId, updatedAt, pdfBlobId, [workspaceId+updatedAt]",
      fileBlobs: "id, workspaceId, documentId, createdAt",
      generatedPages: "id, workspaceId, documentId, generatedPageIndex, sourcePdfPageNumber, [documentId+generatedPageIndex]",
      chatThreads: "id, workspaceId, documentId, updatedAt, [workspaceId+updatedAt]",
      chatMessages: "id, threadId, workspaceId, documentId, createdAt, updatedAt, [threadId+createdAt]",
      selectedContexts: "id, workspaceId, documentId, createdAt",
      settings: "id, updatedAt",
    });

    this.version(2)
      .stores({
        workspaces: "id, updatedAt, lastOpenedAt, activeDocumentId, activeThreadId",
        documents: "id, workspaceId, updatedAt, pdfBlobId, [workspaceId+updatedAt]",
        fileBlobs: "id, workspaceId, documentId, createdAt",
        generatedPages: "id, workspaceId, documentId, generatedPageIndex, sourcePdfPageNumber, [documentId+generatedPageIndex]",
        chatThreads: "id, workspaceId, documentId, updatedAt, [workspaceId+updatedAt]",
        chatMessages: "id, threadId, workspaceId, documentId, createdAt, updatedAt, [threadId+createdAt]",
        selectedContexts: "id, workspaceId, documentId, createdAt",
        settings: "id, updatedAt",
      })
      .upgrade(upgradeToV2);
  }
}

export const pagePairDb = new PagePairPersistenceDb();
