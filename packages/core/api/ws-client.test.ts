import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  WSClient,
} from "./ws-client";
import type { WSMessage } from "../types/events";

// Capture URL passed to WebSocket so we can assert the connect-time
// query string.  We don't simulate the full WS lifecycle here — only the
// upgrade URL construction, which is what carries client identity, plus
// enough of the message surface for the heartbeat tests.
class FakeWebSocket {
  static OPEN = 1;
  static lastUrl: string | null = null;
  static lastInstance: FakeWebSocket | null = null;
  // Fields read by WSClient.connect()/disconnect(), all no-op here.
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  close = vi.fn();
  constructor(url: string) {
    FakeWebSocket.lastUrl = url;
    FakeWebSocket.lastInstance = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
}

describe("WSClient", () => {
  beforeEach(() => {
    FakeWebSocket.lastUrl = null;
    FakeWebSocket.lastInstance = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes client identity in the upgrade URL when configured", () => {
    const ws = new WSClient("ws://example.test/ws", {
      identity: { platform: "desktop", version: "1.2.3", os: "macos" },
    });
    ws.setAuth("tok", "acme");
    ws.connect();

    const url = new URL(FakeWebSocket.lastUrl!);
    expect(url.searchParams.get("workspace_slug")).toBe("acme");
    expect(url.searchParams.get("client_platform")).toBe("desktop");
    expect(url.searchParams.get("client_version")).toBe("1.2.3");
    expect(url.searchParams.get("client_os")).toBe("macos");
    // Token must never appear in the URL — it is delivered as the first
    // WS message in token mode.
    expect(url.searchParams.has("token")).toBe(false);
  });

  it("omits client_* params when identity is not configured", () => {
    const ws = new WSClient("ws://example.test/ws");
    ws.setAuth("tok", "acme");
    ws.connect();

    const url = new URL(FakeWebSocket.lastUrl!);
    expect(url.searchParams.has("client_platform")).toBe(false);
    expect(url.searchParams.has("client_version")).toBe(false);
    expect(url.searchParams.has("client_os")).toBe(false);
  });

  it("only includes the identity fields that are set", () => {
    const ws = new WSClient("ws://example.test/ws", {
      identity: { platform: "cli" },
    });
    ws.setAuth("tok", "acme");
    ws.connect();

    const url = new URL(FakeWebSocket.lastUrl!);
    expect(url.searchParams.get("client_platform")).toBe("cli");
    expect(url.searchParams.has("client_version")).toBe(false);
    expect(url.searchParams.has("client_os")).toBe(false);
  });

  it("truncates the logged payload when an unparseable frame is large", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const ws = new WSClient("ws://example.test/ws", { logger });
    ws.connect();

    const huge = "x".repeat(5000);
    FakeWebSocket.lastInstance!.onmessage?.({ data: huge });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, summary] = logger.warn.mock.calls[0] as [string, string];
    expect(summary.length).toBeLessThan(huge.length);
    expect(summary).toContain("truncated");
    expect(summary).toContain("5000");
    expect(summary.startsWith("x".repeat(200))).toBe(true);
  });

  it("logs and skips malformed frames without breaking later messages", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const ws = new WSClient("ws://example.test/ws", { logger });
    const handler = vi.fn();
    ws.on("issue:updated", handler);
    ws.connect();

    expect(() => {
      FakeWebSocket.lastInstance!.onmessage?.({ data: `{"type":"issue` });
    }).not.toThrow();

    FakeWebSocket.lastInstance!.onmessage?.({
      data: JSON.stringify({
        type: "issue:updated",
        payload: { id: "issue-1" },
      }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "ws: received unparseable message",
      `{"type":"issue`,
    );
    expect(handler).toHaveBeenCalledWith(
      { id: "issue-1" },
      undefined,
      undefined,
    );
  });

  it("drops frames without a string type without throwing, and keeps dispatching", () => {
    // Regression for MUL-3418: a frame whose parsed JSON lacks a string `type`
    // (an out-of-protocol frame, or a bare JSON primitive) used to throw an
    // uncaught TypeError out of onmessage via `msg.type.split(...)` in a
    // downstream onAny handler, flooding `$exception` telemetry.
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const ws = new WSClient("ws://example.test/ws", { logger });

    // A downstream consumer that assumes a string type, exactly like the
    // realtime sync's onAny dispatcher.
    const anyHandler = vi.fn((msg: WSMessage) => msg.type.split(":")[0]);
    ws.onAny(anyHandler);
    const issueHandler = vi.fn();
    ws.on("issue:updated", issueHandler);
    ws.connect();

    const badFrames = [
      JSON.stringify({ payload: {} }), // object, no type
      "42", // bare number
      "true", // bare bool
      "[]", // array
    ];
    for (const data of badFrames) {
      expect(() => {
        FakeWebSocket.lastInstance!.onmessage?.({ data });
      }).not.toThrow();
    }

    // Bad frames never reached any handler.
    expect(anyHandler).not.toHaveBeenCalled();
    expect(issueHandler).not.toHaveBeenCalled();

    // A valid frame after the bad ones still dispatches normally.
    FakeWebSocket.lastInstance!.onmessage?.({
      data: JSON.stringify({ type: "issue:updated", payload: { id: "i-1" } }),
    });
    expect(issueHandler).toHaveBeenCalledWith({ id: "i-1" }, undefined, undefined);
    expect(anyHandler).toHaveBeenCalledTimes(1);

    // The drop is logged at most once per connection despite four bad frames.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe(
      "ws: dropping frame without a string type",
    );
  });

  it("passes actor_id and actor_type to event handlers", () => {
    const ws = new WSClient("ws://example.test/ws");
    ws.setAuth("tok", "acme");
    ws.connect();

    const handler = vi.fn();
    ws.on("issue:created", handler);

    const fakeWs = (ws as any).ws as FakeWebSocket;
    fakeWs.onmessage?.({
      data: JSON.stringify({
        type: "issue:created",
        payload: { id: "issue-1" },
        actor_id: "user-123",
        actor_type: "user",
      }),
    });

    expect(handler).toHaveBeenCalledWith(
      { id: "issue-1" },
      "user-123",
      "user",
    );
  });

  describe("heartbeat", () => {
    // Connect in token mode and complete auth so the heartbeat arms —
    // returns the fake socket for frame injection.
    const connectAndAuth = (ws: WSClient) => {
      ws.setAuth("tok", "acme");
      ws.connect();
      const fakeWs = FakeWebSocket.lastInstance!;
      fakeWs.onopen?.();
      fakeWs.onmessage?.({ data: JSON.stringify({ type: "auth_ack" }) });
      fakeWs.sent = []; // drop the auth frame
      return fakeWs;
    };
    const pings = (fakeWs: FakeWebSocket) =>
      fakeWs.sent.filter((f) => JSON.parse(f).type === "ping").length;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("pings an idle connection and closes the socket when nothing answers", () => {
      const ws = new WSClient("ws://example.test/ws");
      const fakeWs = connectAndAuth(ws);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(pings(fakeWs)).toBe(1);
      expect(fakeWs.close).not.toHaveBeenCalled();

      // Half-open socket: no frame of any kind comes back.
      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS);
      expect(fakeWs.close).toHaveBeenCalledTimes(1);
    });

    it("keeps the socket open when any frame arrives after the ping", () => {
      const ws = new WSClient("ws://example.test/ws");
      const fakeWs = connectAndAuth(ws);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(pings(fakeWs)).toBe(1);
      fakeWs.onmessage?.({ data: JSON.stringify({ type: "pong" }) });

      vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS * 2);
      expect(fakeWs.close).not.toHaveBeenCalled();
    });

    it("does not ping while organic traffic proves liveness", () => {
      const ws = new WSClient("ws://example.test/ws");
      const fakeWs = connectAndAuth(ws);

      // A frame lands mid-interval, so at every tick the connection has
      // been idle for less than a full interval.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS / 2);
      fakeWs.onmessage?.({
        data: JSON.stringify({ type: "issue:updated", payload: {} }),
      });
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS / 2);
      expect(pings(fakeWs)).toBe(0);

      // Once truly idle for a full interval, the ping fires.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(pings(fakeWs)).toBe(1);
    });

    it("stops the heartbeat on disconnect", () => {
      const ws = new WSClient("ws://example.test/ws");
      const fakeWs = connectAndAuth(ws);
      ws.disconnect();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(pings(fakeWs)).toBe(0);
      expect(fakeWs.close).toHaveBeenCalledTimes(1); // the disconnect() close only
    });
  });
});
