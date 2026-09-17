/** The resources must retain listProjectResources' (position, created_at, id) order.
 * Claim serialization preserves that order even when it omits the sort fields.
 * Routing, Chat lineage, and daemon resolution must use this same winner; a
 * daemon must not substitute a later resource belonging to its own machine. */
export function selectChatLocalDirectory(resources: readonly {
  resourceType: string;
  resourceRef: Record<string, unknown>;
}[]): { daemon: string; path: string } | null {
  for (const resource of resources) {
    if (resource.resourceType !== "local_directory") continue;
    const daemon = String(resource.resourceRef.daemonId ?? resource.resourceRef.daemon_id ?? "").trim();
    if (!daemon) continue;
    return {
      daemon,
      path: String(resource.resourceRef.localPath ?? resource.resourceRef.local_path ?? "").trim(),
    };
  }
  return null;
}
