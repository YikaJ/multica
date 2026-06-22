"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineEntry } from "@multica/core/types";

// "At bottom" tolerance: a short comment appended just below the fold should
// not flip the indicator on, and reaching within this distance of the last
// comment counts as caught-up.
const AT_BOTTOM_THRESHOLD_PX = 80;

// requestAnimationFrame budget for the scroll-to-bottom loop (~0.5s at 60fps),
// matching the deep-link landing logic in issue-detail.
const SCROLL_SETTLE_MAX_FRAMES = 30;

/**
 * A timeline entry counts toward the "new comments" badge only when it is a
 * genuine comment authored by someone other than the current user. Activity
 * rows and platform/system comments (`status_change` / `progress_update` /
 * `system`) are notifications, not conversation, so they never count.
 */
export function isCountableNewComment(
  entry: TimelineEntry,
  userId: string | undefined,
): boolean {
  if (entry.type !== "comment") return false;
  if ((entry.comment_type ?? "comment") !== "comment") return false;
  if (entry.actor_type === "member" && !!userId && entry.actor_id === userId) {
    return false;
  }
  return true;
}

/**
 * Counts new comments from others since the user last reached the bottom.
 *
 * The model is a small state machine over a "seen" set:
 *   - On first-ready the whole existing timeline is marked seen — existing
 *     history is never "new", so opening a long issue shows 0, not the backlog.
 *   - Reaching the bottom acknowledges everything currently loaded → 0.
 *   - While not at the bottom, the badge is the number of unacknowledged
 *     countable comments. They are NOT marked seen until the user reaches the
 *     bottom, so they keep counting across re-renders.
 *
 * `atBottom` is an input (driven by the caller's viewport detection) so this
 * core logic stays DOM-free and unit-testable. `resetKey` resets the baseline
 * when the viewed issue changes — issue-detail does not remount across issues,
 * so the seen-set would otherwise leak the previous issue's comments.
 */
export function useNewCommentsCount({
  timeline,
  atBottom,
  userId,
  ready,
  resetKey,
}: {
  timeline: TimelineEntry[];
  atBottom: boolean;
  userId: string | undefined;
  ready: boolean;
  resetKey: string;
}): number {
  const seenRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    seenRef.current = new Set();
    initializedRef.current = false;
    setCount(0);
  }, [resetKey]);

  useEffect(() => {
    if (!ready) return;
    const seen = seenRef.current;

    // First settle: everything already present is history, never "new".
    if (!initializedRef.current) {
      initializedRef.current = true;
      for (const e of timeline) seen.add(e.id);
      setCount(0);
      return;
    }

    // Reaching the bottom acknowledges the whole current timeline.
    if (atBottom) {
      for (const e of timeline) seen.add(e.id);
      setCount(0);
      return;
    }

    // Otherwise count unacknowledged comments from others.
    let n = 0;
    for (const e of timeline) {
      if (seen.has(e.id)) continue;
      if (isCountableNewComment(e, userId)) n++;
    }
    setCount(n);
  }, [ready, atBottom, timeline, userId]);

  return count;
}

/** Tracks whether a sentinel placed just below the comment list is in view. */
function useAtBottom(
  scrollContainerEl: HTMLElement | null,
  sentinelEl: HTMLElement | null,
  resetKey: string,
): boolean {
  const [atBottom, setAtBottom] = useState(true);

  // Default to "at bottom" on issue switch; the observer re-evaluates as soon
  // as the new timeline lays out.
  useEffect(() => {
    setAtBottom(true);
  }, [resetKey]);

  useEffect(() => {
    if (!scrollContainerEl || !sentinelEl) return;
    const observer = new IntersectionObserver(
      ([entry]) => setAtBottom(entry?.isIntersecting ?? false),
      {
        root: scrollContainerEl,
        rootMargin: `0px 0px ${AT_BOTTOM_THRESHOLD_PX}px 0px`,
      },
    );
    observer.observe(sentinelEl);
    return () => observer.disconnect();
  }, [scrollContainerEl, sentinelEl]);

  return atBottom;
}

type IndicatorArgs = {
  scrollContainerEl: HTMLElement | null;
  timeline: TimelineEntry[];
  userId: string | undefined;
  ready: boolean;
  /** Changes when the viewed issue changes; resets the seen-baseline. */
  resetKey: string;
};

/**
 * Drives the "go to new comments" affordance on the issue detail timeline:
 * a floating control that appears when the latest comment is out of view, with
 * a badge counting comments that have arrived from others since the user last
 * reached the bottom.
 */
export function useNewCommentsIndicator({
  scrollContainerEl,
  timeline,
  userId,
  ready,
  resetKey,
}: IndicatorArgs) {
  const [sentinelEl, setSentinelEl] = useState<HTMLElement | null>(null);
  const atBottom = useAtBottom(scrollContainerEl, sentinelEl, resetKey);
  const count = useNewCommentsCount({
    timeline,
    atBottom,
    userId,
    ready,
    resetKey,
  });

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerEl;
    if (!container) return;
    // Drive scrollTop directly, re-applying across frames until the height
    // settles. Mirrors the deep-link landing logic in issue-detail: under a
    // virtualized list `scrollHeight` is an estimate until the bottom items
    // mount and measure, so a single `scrollTop = scrollHeight` undershoots.
    let frames = 0;
    let last = -1;
    const step = () => {
      const target = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = target;
      if (Math.abs(target - last) > 1 && ++frames < SCROLL_SETTLE_MAX_FRAMES) {
        last = target;
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }, [scrollContainerEl]);

  return {
    /** Number of new comments from others since the user last reached bottom. */
    count,
    /** Whether the floating control should be shown. */
    visible: ready && !atBottom,
    /** Callback ref for the 0-height sentinel placed just below the list. */
    sentinelRef: setSentinelEl,
    scrollToBottom,
  };
}
