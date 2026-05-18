import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import { join } from "path";
import type { DaemonState, DaemonStatus } from "../shared/daemon-types";
import {
  daemonOps,
  openDaemonLogFile,
  subscribeDaemonStatus,
} from "./daemon-manager";

type IconVariant = "running" | "stopped" | "starting" | "error";

// State → icon variant. macOS uses template images (see resolveIconPath
// below); "starting" / "stopping" / "installing_cli" all fall back to the
// stopped silhouette there because template images can't animate — the
// transient state is communicated via the menu's disabled title row.
const TRAY_ICON_BY_STATE: Record<DaemonState, IconVariant> = {
  installing_cli: "starting",
  cli_not_found: "error",
  starting: "starting",
  stopping: "starting",
  running: "running",
  stopped: "stopped",
};

// Same path-swap trick as bundledCliPath() in daemon-manager.ts: in dev
// `app.getAppPath()` points at apps/desktop, and electron-builder's
// `asarUnpack: resources/**` extracts these PNGs to app.asar.unpacked/ in
// packaged builds. macOS picks up the `Template` filename suffix and
// recolors the image for the menu bar theme automatically.
function resolveIconPath(state: DaemonState): string {
  const variant = TRAY_ICON_BY_STATE[state];
  const file =
    process.platform === "darwin"
      ? `tray-${variant}-Template.png`
      : `tray-${variant}.png`;
  return join(app.getAppPath(), "resources", "tray", file).replace(
    "app.asar",
    "app.asar.unpacked",
  );
}

// Title row of the context menu — disabled, used purely as a status read-out
// since macOS (per design decision) keeps the menu bar icon text-free.
export function formatStatusLabel(status: DaemonStatus): string {
  switch (status.state) {
    case "running": {
      const parts = ["Running"];
      if (typeof status.pid === "number") parts.push(`pid ${status.pid}`);
      const agentCount = status.agents?.length ?? 0;
      if (agentCount > 0) {
        parts.push(`${agentCount} ${agentCount === 1 ? "agent" : "agents"}`);
      }
      return parts.join(" · ");
    }
    case "stopped":
      return "Stopped";
    case "starting":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    case "installing_cli":
      return "Setting up…";
    case "cli_not_found":
      return "Setup failed";
  }
}

// Pure menu template builder — exported for unit tests so they can inspect
// label / enabled / type fields without going near a real Tray instance.
export function buildMenuTemplate(
  status: DaemonStatus,
  actions: {
    showWindow: () => void;
    openLog: () => void;
    start: () => void;
    stop: () => void;
    restart: () => void;
    quit: () => void;
  },
): Electron.MenuItemConstructorOptions[] {
  const state = status.state;
  const canStart = state === "stopped" || state === "cli_not_found";
  const canStop = state === "running";
  const canRestart = state === "running";

  return [
    { label: formatStatusLabel(status), enabled: false },
    { type: "separator" },
    { label: "Show Multica", click: actions.showWindow },
    { label: "Open Log File", click: actions.openLog },
    { type: "separator" },
    { label: "Start Daemon", enabled: canStart, click: actions.start },
    { label: "Stop Daemon", enabled: canStop, click: actions.stop },
    { label: "Restart Daemon", enabled: canRestart, click: actions.restart },
    { type: "separator" },
    { label: "Quit Multica", click: actions.quit },
  ];
}

let tray: Tray | null = null;
let unsubscribe: (() => void) | null = null;

function showWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function rebuildMenu(
  status: DaemonStatus,
  getWindow: () => BrowserWindow | null,
): void {
  if (!tray) return;
  const template = buildMenuTemplate(status, {
    showWindow: () => showWindow(getWindow),
    openLog: () => {
      void openDaemonLogFile();
    },
    start: () => {
      void daemonOps.start();
    },
    stop: () => {
      void daemonOps.stop();
    },
    restart: () => {
      void daemonOps.restart();
    },
    quit: () => {
      app.quit();
    },
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/**
 * Mount the tray icon and wire it to the live daemon status. Idempotent —
 * a second call is a no-op so HMR / re-entry can't accumulate Tray instances.
 */
export function setupTray(getWindow: () => BrowserWindow | null): void {
  if (tray) return;

  const initialImage = nativeImage.createFromPath(resolveIconPath("stopped"));
  tray = new Tray(initialImage);
  tray.setToolTip("Multica");

  unsubscribe = subscribeDaemonStatus((status) => {
    if (!tray) return;
    tray.setImage(nativeImage.createFromPath(resolveIconPath(status.state)));
    rebuildMenu(status, getWindow);
  });

  // Left-click handler is a macOS/Windows nice-to-have only. Linux's
  // AppIndicator surface doesn't fire `click`, so all actions must remain
  // reachable via the context menu — which they are (see buildMenuTemplate).
  if (process.platform !== "linux") {
    tray.on("click", () => {
      const win = getWindow();
      if (!win) return;
      if (win.isVisible() && !win.isMinimized()) {
        win.hide();
      } else {
        showWindow(getWindow);
      }
    });
  }

  app.on("before-quit", () => {
    unsubscribe?.();
    unsubscribe = null;
    tray?.destroy();
    tray = null;
  });
}

// Test-only escape hatch: lets the suite reset module state between cases
// without exporting the live `tray` / `unsubscribe` bindings.
export function __resetTrayForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  tray?.destroy();
  tray = null;
}
