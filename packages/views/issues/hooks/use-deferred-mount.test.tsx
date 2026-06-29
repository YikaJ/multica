import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDeferredMount } from "./use-deferred-mount";

// Drive requestAnimationFrame deterministically: queue callbacks and flush
// them on demand so the test controls exactly when the deferred mount lands.
let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushRaf() {
  const pending = rafCallbacks;
  rafCallbacks = [];
  act(() => {
    pending.forEach((cb) => cb(0));
  });
}

describe("useDeferredMount", () => {
  it("starts not-ready and flips ready after the next animation frame", () => {
    const { result } = renderHook(() => useDeferredMount());

    expect(result.current.ready).toBe(false);

    flushRaf();

    expect(result.current.ready).toBe(true);
  });

  it("mountNow forces an immediate ready without waiting for the frame", () => {
    const { result } = renderHook(() => useDeferredMount());

    expect(result.current.ready).toBe(false);

    act(() => {
      result.current.mountNow();
    });

    expect(result.current.ready).toBe(true);
  });

  it("re-arms the deferral when resetKey changes", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useDeferredMount(key),
      { initialProps: { key: "a" } },
    );

    flushRaf();
    expect(result.current.ready).toBe(true);

    // A new resetKey drops back to not-ready until the next frame, so the
    // heavy child is re-deferred on full-page issue navigation.
    rerender({ key: "b" });
    expect(result.current.ready).toBe(false);

    flushRaf();
    expect(result.current.ready).toBe(true);
  });
});
