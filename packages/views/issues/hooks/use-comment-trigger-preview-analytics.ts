"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildCommentTriggerPreviewSnapshotPayload,
  buildCommentTriggerPreviewTogglePayload,
  captureCommentTriggerPreviewRestored,
  captureCommentTriggerPreviewShown,
  captureCommentTriggerPreviewSuppressed,
  type CommentTriggerPreviewAnalyticsContext,
  type CommentTriggerPreviewComposer,
} from "@multica/core/analytics";
import type { CommentTriggerPreviewAgent } from "@multica/core/types";

export function useCommentTriggerPreviewAnalytics({
  composer,
  agents,
  suppressedAgentIds,
}: {
  composer: CommentTriggerPreviewComposer;
  agents: CommentTriggerPreviewAgent[];
  suppressedAgentIds: Set<string>;
}) {
  const wasVisibleRef = useRef(false);
  const snapshot = useMemo(
    () => buildSnapshotPayload(composer, agents, suppressedAgentIds),
    [agents, composer, suppressedAgentIds],
  );

  useEffect(() => {
    const visible = agents.length > 0;
    if (visible && !wasVisibleRef.current) {
      captureCommentTriggerPreviewShown(snapshot);
    }
    wasVisibleRef.current = visible;
  }, [agents.length, snapshot]);

  const captureToggle = useCallback((
    agentId: string,
    nextSuppressedAgentIds: Set<string>,
  ) => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent || agents.length === 0) return;

    const suppressedCount = countSuppressedAgents(agents, nextSuppressedAgentIds);
    const payload = buildCommentTriggerPreviewTogglePayload({
      composer,
      agentCount: agents.length,
      activeCount: agents.length - suppressedCount,
      suppressedCount,
      source: agent.source,
    });

    if (nextSuppressedAgentIds.has(agentId)) {
      captureCommentTriggerPreviewSuppressed(payload);
    } else {
      captureCommentTriggerPreviewRestored(payload);
    }
  }, [agents, composer]);

  const buildSentContext = useCallback((): CommentTriggerPreviewAnalyticsContext | undefined => {
    if (agents.length < 1) return undefined;
    return snapshot;
  }, [agents.length, snapshot]);

  return { captureToggle, buildSentContext };
}

function buildSnapshotPayload(
  composer: CommentTriggerPreviewComposer,
  agents: CommentTriggerPreviewAgent[],
  suppressedAgentIds: Set<string>,
): CommentTriggerPreviewAnalyticsContext {
  const suppressedCount = countSuppressedAgents(agents, suppressedAgentIds);
  return buildCommentTriggerPreviewSnapshotPayload({
    composer,
    agentCount: agents.length,
    activeCount: agents.length - suppressedCount,
    suppressedCount,
    sources: agents.map((agent) => agent.source),
  });
}

function countSuppressedAgents(
  agents: CommentTriggerPreviewAgent[],
  suppressedAgentIds: Set<string>,
): number {
  return agents.reduce(
    (count, agent) => count + (suppressedAgentIds.has(agent.id) ? 1 : 0),
    0,
  );
}
