import type { Transaction } from "dexie";
import { persistenceSchemaVersion } from "./schema";

const defaultCourseProjectName = "默认课程";

function defaultProjectId(workspaceId: string) {
  return `course_${workspaceId}_default`;
}

export async function upgradeToV2(transaction: Transaction) {
  await transaction
    .table("workspaces")
    .toCollection()
    .modify((workspace: { version?: number }) => {
      if (!workspace.version || workspace.version < persistenceSchemaVersion) {
        workspace.version = persistenceSchemaVersion;
      }
    });
}

export async function upgradeToV3(transaction: Transaction) {
  const workspaces = await transaction.table("workspaces").toArray();
  const documents = await transaction.table("documents").toArray();
  const courseProjects = transaction.table("courseProjects");
  const now = Date.now();

  for (const workspace of workspaces) {
    const workspaceDocuments = documents.filter((document) => document.workspaceId === workspace.id);
    const projectId = workspace.activeProjectId || defaultProjectId(workspace.id);
    const activeDocument = workspaceDocuments.find((document) => document.id === workspace.activeDocumentId) || workspaceDocuments[0];
    await courseProjects.put({
      id: projectId,
      workspaceId: workspace.id,
      name: defaultCourseProjectName,
      description: "",
      color: "clay",
      icon: "book-open",
      createdAt: workspace.createdAt || now,
      updatedAt: workspace.updatedAt || now,
      lastOpenedAt: workspace.lastOpenedAt || now,
      documentCount: workspaceDocuments.length,
      activeDocumentId: activeDocument?.id,
    });

    for (const document of workspaceDocuments) {
      await transaction.table("documents").update(document.id, {
        projectId: document.projectId || projectId,
        lastOpenedAt: document.lastOpenedAt || document.updatedAt || now,
      });
    }

    await transaction.table("workspaces").update(workspace.id, {
      activeProjectId: projectId,
      version: persistenceSchemaVersion,
    });
  }
}
