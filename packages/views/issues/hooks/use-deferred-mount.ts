"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Defers mounting a heavy child until just after the first paint of the
 * surrounding tree. Returns `ready: false` on the initial (synchronous) commit
 * and flips to `true` on the next animation frame.
 *
 * The inbox detail pane remounts the whole `IssueDetail` subtree on every issue
 * switch (it is keyed by `issue_id`). Creating the description's Tiptap editor
 * inside that synchronous commit is one of the costliest pieces of work on the
 * critical switch path — a fresh ProseMirror `EditorView` with ~20 extensions.
 * Gating it on this hook keeps the editor out of the switch commit, so the new
 * issue's content paints first and the editor hydrates a frame later. UX is
 * unchanged; only the timing moves.
 *
 * `resetKey` re-arms the deferral when it changes — needed on the full-page
 * issue route, which (unlike the inbox pane) does not remount `IssueDetail`
 * when the issue id changes. `mountNow` forces an immediate mount, for when the
 * user interacts with the placeholder before the deferred frame lands.
 */
export function useDeferredMount(resetKey?: unknown): {
  ready: boolean;
  mountNow: () => void;
} {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, [resetKey]);

  const mountNow = useCallback(() => setReady(true), []);

  return { ready, mountNow };
}
