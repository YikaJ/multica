import { describe, expect, it } from "vitest";

import {
  buildCommentTriggerPreviewSnapshotPayload,
  buildCommentTriggerPreviewTogglePayload,
  normalizeCommentTriggerPreviewSource,
} from "./comment-trigger-preview";

const FORBIDDEN_KEYS = [
  "reason",
  "agent_id",
  "agent_name",
  "name",
  "issue_id",
  "workspace_id",
] as const;

describe("comment trigger preview analytics", () => {
  it("normalizes sources through a strict whitelist", () => {
    expect(normalizeCommentTriggerPreviewSource("issue_assignee")).toBe("issue_assignee");
    expect(normalizeCommentTriggerPreviewSource("mention_agent")).toBe("mention_agent");
    expect(normalizeCommentTriggerPreviewSource("mention_squad_leader")).toBe("mention_squad_leader");
    expect(normalizeCommentTriggerPreviewSource("backend_added_new_source")).toBe("unknown");
    expect(normalizeCommentTriggerPreviewSource("")).toBe("unknown");
    expect(normalizeCommentTriggerPreviewSource(null)).toBe("unknown");
    expect(normalizeCommentTriggerPreviewSource(undefined)).toBe("unknown");
  });

  it("builds a fail-closed snapshot payload from primitive fields only", () => {
    const payload = buildCommentTriggerPreviewSnapshotPayload({
      composer: "comment",
      agentCount: 3,
      activeCount: 2,
      suppressedCount: 1,
      sources: [
        "mention_agent",
        "backend_added_new_source",
        "issue_assignee",
        "mention_agent",
      ],
    });

    expect(Object.keys(payload).sort()).toEqual([
      "active_count",
      "agent_count",
      "composer",
      "sources",
      "suppressed_count",
    ]);
    expect(payload).toEqual({
      composer: "comment",
      agent_count: 3,
      active_count: 2,
      suppressed_count: 1,
      sources: ["issue_assignee", "mention_agent", "unknown"],
    });
    for (const key of FORBIDDEN_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload.sources).not.toContain("backend_added_new_source");
  });

  it("builds a fail-closed toggle payload with one normalized source", () => {
    const payload = buildCommentTriggerPreviewTogglePayload({
      composer: "reply",
      agentCount: 2,
      activeCount: 1,
      suppressedCount: 1,
      source: "backend_added_new_source",
    });

    expect(Object.keys(payload).sort()).toEqual([
      "active_count",
      "agent_count",
      "composer",
      "source",
      "suppressed_count",
    ]);
    expect(payload).toEqual({
      composer: "reply",
      agent_count: 2,
      active_count: 1,
      suppressed_count: 1,
      source: "unknown",
    });
    for (const key of FORBIDDEN_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
  });
});
