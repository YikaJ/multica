import { captureEvent } from "./index";

export type CommentTriggerPreviewComposer = "comment" | "reply";

export type CommentTriggerPreviewSource =
  | "issue_assignee"
  | "mention_agent"
  | "mention_squad_leader"
  | "unknown";

export interface CommentTriggerPreviewSnapshotPayload {
  composer: CommentTriggerPreviewComposer;
  agent_count: number;
  active_count: number;
  suppressed_count: number;
  sources: CommentTriggerPreviewSource[];
}

export interface CommentTriggerPreviewTogglePayload {
  composer: CommentTriggerPreviewComposer;
  agent_count: number;
  active_count: number;
  suppressed_count: number;
  source: CommentTriggerPreviewSource;
}

export type CommentTriggerPreviewAnalyticsContext = CommentTriggerPreviewSnapshotPayload;

export function normalizeCommentTriggerPreviewSource(
  source: string | null | undefined,
): CommentTriggerPreviewSource {
  switch (source) {
    case "issue_assignee":
    case "mention_agent":
    case "mention_squad_leader":
      return source;
    default:
      return "unknown";
  }
}

export function buildCommentTriggerPreviewSnapshotPayload({
  composer,
  agentCount,
  activeCount,
  suppressedCount,
  sources,
}: {
  composer: CommentTriggerPreviewComposer;
  agentCount: number;
  activeCount: number;
  suppressedCount: number;
  sources: readonly string[];
}): CommentTriggerPreviewSnapshotPayload {
  return {
    composer,
    agent_count: normalizeCount(agentCount),
    active_count: normalizeCount(activeCount),
    suppressed_count: normalizeCount(suppressedCount),
    sources: Array.from(
      new Set(sources.map((source) => normalizeCommentTriggerPreviewSource(source))),
    ).sort(),
  };
}

export function buildCommentTriggerPreviewTogglePayload({
  composer,
  agentCount,
  activeCount,
  suppressedCount,
  source,
}: {
  composer: CommentTriggerPreviewComposer;
  agentCount: number;
  activeCount: number;
  suppressedCount: number;
  source: string | null | undefined;
}): CommentTriggerPreviewTogglePayload {
  return {
    composer,
    agent_count: normalizeCount(agentCount),
    active_count: normalizeCount(activeCount),
    suppressed_count: normalizeCount(suppressedCount),
    source: normalizeCommentTriggerPreviewSource(source),
  };
}

export function captureCommentTriggerPreviewShown(
  payload: CommentTriggerPreviewSnapshotPayload,
): void {
  if (payload.agent_count < 1) return;
  captureEvent("comment_trigger_preview_shown", { ...payload });
}

export function captureCommentTriggerPreviewSuppressed(
  payload: CommentTriggerPreviewTogglePayload,
): void {
  if (payload.agent_count < 1) return;
  captureEvent("comment_trigger_preview_suppressed", { ...payload });
}

export function captureCommentTriggerPreviewRestored(
  payload: CommentTriggerPreviewTogglePayload,
): void {
  if (payload.agent_count < 1) return;
  captureEvent("comment_trigger_preview_restored", { ...payload });
}

export function captureCommentTriggerPreviewSent(
  payload: CommentTriggerPreviewAnalyticsContext,
): void {
  if (payload.agent_count < 1) return;
  captureEvent("comment_trigger_preview_sent", { ...payload });
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
