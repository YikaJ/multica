import { render, waitFor } from "@testing-library/react";
import type { DataRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createTabRouterMock = vi.hoisted(() =>
  vi.fn(() => ({
    dispose: vi.fn(),
    state: { location: { pathname: "/" } },
    navigate: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  })),
);
vi.mock("../routes", () => ({
  createTabRouter: createTabRouterMock,
}));

import { useTabStore } from "@/stores/tab-store";
import { useTabRouterSync } from "./use-tab-router-sync";

type RouterListener = (state: {
  location: { pathname: string; search: string; hash: string };
  historyAction: "PUSH" | "POP" | "REPLACE";
}) => void;

function makeRouter(
  initial: { pathname: string; search?: string; hash?: string },
) {
  let listener: RouterListener | null = null;
  const router = {
    state: {
      location: {
        pathname: initial.pathname,
        search: initial.search ?? "",
        hash: initial.hash ?? "",
      },
    },
    subscribe: vi.fn((fn: RouterListener) => {
      listener = fn;
      return vi.fn();
    }),
  };

  return {
    router: router as unknown as DataRouter,
    emit(
      next: { pathname: string; search?: string; hash?: string },
      historyAction: "PUSH" | "POP" | "REPLACE" = "REPLACE",
    ) {
      router.state.location = {
        pathname: next.pathname,
        search: next.search ?? "",
        hash: next.hash ?? "",
      };
      listener?.({ location: router.state.location, historyAction });
    },
  };
}

function Harness({ tabId, router }: { tabId: string; router: DataRouter }) {
  useTabRouterSync(tabId, router);
  return null;
}

function activeTab() {
  const state = useTabStore.getState();
  const group = state.byWorkspace.acme;
  return group.tabs.find((tab) => tab.id === group.activeTabId)!;
}

beforeEach(() => {
  createTabRouterMock.mockClear();
  useTabStore.getState().reset();
});

describe("useTabRouterSync", () => {
  it("keeps search params in the stored tab path for query-only navigation", async () => {
    const store = useTabStore.getState();
    store.switchWorkspace("acme");
    const tabId = activeTab().id;
    const { router, emit } = makeRouter({
      pathname: "/acme/inbox",
      search: "?issue=issue-one",
    });

    render(<Harness tabId={tabId} router={router} />);

    await waitFor(() => {
      expect(activeTab().path).toBe("/acme/inbox?issue=issue-one");
    });
    expect(activeTab().icon).toBe("Inbox");

    emit({ pathname: "/acme/inbox", search: "?issue=issue-two" });

    expect(activeTab().path).toBe("/acme/inbox?issue=issue-two");
    expect(activeTab().icon).toBe("Inbox");
  });
});
