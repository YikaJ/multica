export type PinnedItemType = "issue" | "project" | "agent";

/**
 * Pin metadata only. Title / status / identifier / icon are NOT here —
 * consumers derive them from issue / project / agent query caches
 * so the sidebar reacts to entity update events
 * automatically, without needing a cross-entity invalidate on `pinKeys`.
 */
export interface PinnedItem {
  id: string;
  workspace_id: string;
  user_id: string;
  item_type: PinnedItemType;
  item_id: string;
  position: number;
  created_at: string;
}

export interface CreatePinRequest {
  item_type: PinnedItemType;
  item_id: string;
}

export interface ReorderPinsRequest {
  items: { id: string; position: number }[];
}
