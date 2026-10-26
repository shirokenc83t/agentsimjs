import type { StorageClient } from "@agentsim/storage";
import { LAYOUT_NAMESPACE, LAYOUT_VERSION, type WorkspaceId } from "./presets.ts";

/**
 * Named layouts of a workspace (UI-SPEC §3): the dock as the user arranged it, saved under a name in `user_data` next to the autosaved working layout. A name is
 * a short line of text; saving under a name that exists replaces it.
 */
const prefix = (workspace: WorkspaceId) => `${workspace}@${LAYOUT_VERSION}:named:`;

export const MAX_LAYOUT_NAME = 40;

/** The name as it will be stored (trimmed, spaces collapsed), or undefined when it is empty or too long. */
export function layoutName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_LAYOUT_NAME ? name : undefined;
}

export async function listNamedLayouts(storage: StorageClient, workspace: WorkspaceId): Promise<string[]> {
  const keys = await storage.ports.userData.keys(LAYOUT_NAMESPACE);
  return keys
    .filter((k) => k.startsWith(prefix(workspace)))
    .map((k) => k.slice(prefix(workspace).length))
    .sort((a, b) => a.localeCompare(b));
}

export const saveNamedLayout = (storage: StorageClient, workspace: WorkspaceId, name: string, layout: unknown): Promise<void> =>
  storage.ports.userData.set(LAYOUT_NAMESPACE, prefix(workspace) + name, layout);

export const readNamedLayout = (storage: StorageClient, workspace: WorkspaceId, name: string): Promise<unknown> => storage.ports.userData.get(LAYOUT_NAMESPACE, prefix(workspace) + name);

export const deleteNamedLayout = (storage: StorageClient, workspace: WorkspaceId, name: string): Promise<void> => storage.ports.userData.delete(LAYOUT_NAMESPACE, prefix(workspace) + name);
