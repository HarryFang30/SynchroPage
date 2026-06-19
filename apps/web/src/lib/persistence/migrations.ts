import type { Transaction } from "dexie";
import { persistenceSchemaVersion } from "./schema";

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
