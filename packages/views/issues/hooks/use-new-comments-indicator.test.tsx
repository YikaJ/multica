import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@multica/core/types";
import {
  isCountableNewComment,
  useNewCommentsCount,
} from "./use-new-comments-indicator";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";

function comment(
  id: string,
  actorId: string,
  overrides: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    type: "comment",
    id,
    actor_type: "member",
    actor_id: actorId,
    created_at: `2026-01-01T00:00:00.00${id}Z`,
    comment_type: "comment",
    ...overrides,
  };
}

describe("isCountableNewComment", () => {
  it("counts comments authored by other members and agents", () => {
    expect(isCountableNewComment(comment("1", OTHER), ME)).toBe(true);
    expect(
      isCountableNewComment(comment("2", AGENT, { actor_type: "agent" }), ME),
    ).toBe(true);
  });

  it("never counts the current user's own comments", () => {
    expect(isCountableNewComment(comment("1", ME), ME)).toBe(false);
  });

  it("ignores activity rows and non-conversation comment types", () => {
    expect(
      isCountableNewComment(
        { type: "activity", id: "a", actor_type: "member", actor_id: OTHER, created_at: "" },
        ME,
      ),
    ).toBe(false);
    expect(
      isCountableNewComment(comment("1", OTHER, { comment_type: "system" }), ME),
    ).toBe(false);
    expect(
      isCountableNewComment(
        comment("1", OTHER, { comment_type: "status_change" }),
        ME,
      ),
    ).toBe(false);
  });
});

type Props = Parameters<typeof useNewCommentsCount>[0];

describe("useNewCommentsCount", () => {
  const base = (timeline: TimelineEntry[], over: Partial<Props> = {}): Props => ({
    timeline,
    atBottom: false,
    userId: ME,
    ready: true,
    resetKey: "ws:issue-1",
    ...over,
  });

  it("treats the existing timeline as history — opening shows 0", () => {
    const history = [comment("1", OTHER), comment("2", AGENT, { actor_type: "agent" })];
    const { result } = renderHook((p: Props) => useNewCommentsCount(p), {
      initialProps: base(history),
    });
    expect(result.current).toBe(0);
  });

  it("counts comments from others that arrive while not at the bottom", () => {
    const history = [comment("1", OTHER)];
    const { result, rerender } = renderHook((p: Props) => useNewCommentsCount(p), {
      initialProps: base(history),
    });
    expect(result.current).toBe(0);

    rerender(base([...history, comment("2", AGENT, { actor_type: "agent" })]));
    expect(result.current).toBe(1);

    rerender(base([...history, comment("2", AGENT, { actor_type: "agent" }), comment("3", OTHER)]));
    expect(result.current).toBe(2);
  });

  it("does not count the user's own new comments", () => {
    const history = [comment("1", OTHER)];
    const { result, rerender } = renderHook((p: Props) => useNewCommentsCount(p), {
      initialProps: base(history),
    });
    rerender(base([...history, comment("2", ME)]));
    expect(result.current).toBe(0);

    rerender(base([...history, comment("2", ME), comment("3", OTHER)]));
    expect(result.current).toBe(1);
  });

  it("resets to 0 when the user reaches the bottom and acknowledges new ones", () => {
    const history = [comment("1", OTHER)];
    const { result, rerender } = renderHook((p: Props) => useNewCommentsCount(p), {
      initialProps: base(history),
    });
    const withNew = [...history, comment("2", OTHER)];
    rerender(base(withNew));
    expect(result.current).toBe(1);

    // Reach the bottom: acknowledged.
    rerender(base(withNew, { atBottom: true }));
    expect(result.current).toBe(0);

    // Scroll back up: previously-seen comments stay acknowledged.
    rerender(base(withNew, { atBottom: false }));
    expect(result.current).toBe(0);

    // A genuinely new one after acknowledgement counts again.
    rerender(base([...withNew, comment("3", AGENT, { actor_type: "agent" })]));
    expect(result.current).toBe(1);
  });

  it("re-baselines when the viewed issue changes", () => {
    const issue1 = [comment("1", OTHER), comment("2", OTHER)];
    const { result, rerender } = renderHook((p: Props) => useNewCommentsCount(p), {
      initialProps: base(issue1),
    });
    rerender(base([...issue1, comment("3", OTHER)]));
    expect(result.current).toBe(1);

    // Switch issues: the new issue's existing comments are history, not new.
    const issue2 = [comment("10", OTHER), comment("11", AGENT, { actor_type: "agent" })];
    rerender(base(issue2, { resetKey: "ws:issue-2" }));
    expect(result.current).toBe(0);

    rerender(base([...issue2, comment("12", OTHER)], { resetKey: "ws:issue-2" }));
    expect(result.current).toBe(1);
  });

  it("stays at 0 until the timeline is ready", () => {
    const history = [comment("1", OTHER)];
    const { result, rerender } = renderHook((p: Props) => useNewCommentsCount(p), {
      initialProps: base(history, { ready: false }),
    });
    expect(result.current).toBe(0);

    // First arrivals before ready must not be mistaken for "new".
    rerender(base([...history, comment("2", OTHER)], { ready: false }));
    expect(result.current).toBe(0);

    // Once ready, the whole current timeline is baselined as history.
    rerender(base([...history, comment("2", OTHER)], { ready: true }));
    expect(result.current).toBe(0);
  });
});
