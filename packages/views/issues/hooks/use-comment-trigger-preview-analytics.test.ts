import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommentTriggerPreviewAgent } from "@multica/core/types";

import { useCommentTriggerPreviewAnalytics } from "./use-comment-trigger-preview-analytics";

const captureCommentTriggerPreviewShown = vi.hoisted(() => vi.fn());
const captureCommentTriggerPreviewSuppressed = vi.hoisted(() => vi.fn());
const captureCommentTriggerPreviewRestored = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/analytics")>();
  return {
    ...actual,
    captureCommentTriggerPreviewShown,
    captureCommentTriggerPreviewSuppressed,
    captureCommentTriggerPreviewRestored,
  };
});

const walt: CommentTriggerPreviewAgent = {
  id: "agent-1",
  name: "Walt",
  source: "issue_assignee",
  reason: "private reason",
};

const kim: CommentTriggerPreviewAgent = {
  id: "agent-2",
  name: "Kim",
  source: "mention_agent",
  reason: "private reason",
};

const futureSource: CommentTriggerPreviewAgent = {
  id: "agent-3",
  name: "Future",
  source: "backend_added_new_source",
  reason: "private reason",
};

afterEach(() => {
  captureCommentTriggerPreviewShown.mockReset();
  captureCommentTriggerPreviewSuppressed.mockReset();
  captureCommentTriggerPreviewRestored.mockReset();
});

describe("useCommentTriggerPreviewAnalytics", () => {
  it("captures shown only when the preview chip becomes visible", () => {
    const { rerender } = renderHook(
      ({ agents }) => useCommentTriggerPreviewAnalytics({
        composer: "comment",
        agents,
        suppressedAgentIds: new Set<string>(),
      }),
      { initialProps: { agents: [] as CommentTriggerPreviewAgent[] } },
    );

    expect(captureCommentTriggerPreviewShown).not.toHaveBeenCalled();

    rerender({ agents: [walt] });
    expect(captureCommentTriggerPreviewShown).toHaveBeenCalledTimes(1);
    expect(captureCommentTriggerPreviewShown).toHaveBeenCalledWith({
      composer: "comment",
      agent_count: 1,
      active_count: 1,
      suppressed_count: 0,
      sources: ["issue_assignee"],
    });

    rerender({ agents: [walt, kim] });
    expect(captureCommentTriggerPreviewShown).toHaveBeenCalledTimes(1);

    rerender({ agents: [] });
    rerender({ agents: [futureSource] });
    expect(captureCommentTriggerPreviewShown).toHaveBeenCalledTimes(2);
    expect(captureCommentTriggerPreviewShown).toHaveBeenLastCalledWith({
      composer: "comment",
      agent_count: 1,
      active_count: 1,
      suppressed_count: 0,
      sources: ["unknown"],
    });
  });

  it("captures suppress and restore with operation-after counts", () => {
    const { result } = renderHook(
      () => useCommentTriggerPreviewAnalytics({
        composer: "reply",
        agents: [walt, kim],
        suppressedAgentIds: new Set<string>(),
      }),
    );

    result.current.captureToggle("agent-2", new Set(["agent-2"]));

    expect(captureCommentTriggerPreviewSuppressed).toHaveBeenCalledWith({
      composer: "reply",
      agent_count: 2,
      active_count: 1,
      suppressed_count: 1,
      source: "mention_agent",
    });

    result.current.captureToggle("agent-2", new Set());

    expect(captureCommentTriggerPreviewRestored).toHaveBeenCalledWith({
      composer: "reply",
      agent_count: 2,
      active_count: 2,
      suppressed_count: 0,
      source: "mention_agent",
    });
  });

  it("builds sent context only when the submit-time preview has agents", () => {
    const { result, rerender } = renderHook(
      ({ agents, suppressedAgentIds }) => useCommentTriggerPreviewAnalytics({
        composer: "reply",
        agents,
        suppressedAgentIds,
      }),
      {
        initialProps: {
          agents: [] as CommentTriggerPreviewAgent[],
          suppressedAgentIds: new Set<string>(),
        },
      },
    );

    expect(result.current.buildSentContext()).toBeUndefined();

    rerender({
      agents: [walt, kim, futureSource],
      suppressedAgentIds: new Set(["agent-1"]),
    });

    expect(result.current.buildSentContext()).toEqual({
      composer: "reply",
      agent_count: 3,
      active_count: 2,
      suppressed_count: 1,
      sources: ["issue_assignee", "mention_agent", "unknown"],
    });
  });
});
