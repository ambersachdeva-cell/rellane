/**
 * The ⌥Space overlay window.
 *
 * Held open and hidden rather than created on each press: constructing a
 * BrowserWindow and loading a document takes long enough to feel like a stall,
 * and the overlay's whole value is that it is already there. It costs one idle
 * renderer, which is the right trade for a surface meant to be used dozens of
 * times a day.
 *
 * It is deliberately not a Dock app and not in the window menu. It appears over
 * whatever you are doing and leaves without taking focus with it.
 */

import { BrowserWindow, globalShortcut, screen, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import {
  DEVELOPMENT_RENDERER_URL,
  isTrustedRendererUrl,
  type RendererTarget
} from "./renderer-trust.js";

const WIDTH = 680;
/** Tall enough for the input plus results; the renderer never scrolls the window. */
const HEIGHT = 480;

/** Sits in the upper third — where the eye already is, and clear of the Dock. */
const VERTICAL_BIAS = 0.22;

export const OVERLAY_CHANNELS = Object.freeze({
  hide: "cadrane:overlay:hide",
  run: "cadrane:overlay:run"
});

export interface OverlayHost {
  toggle(): void;
  show(): void;
  hide(): void;
  destroy(): void;
  readonly window: BrowserWindow;
}

export interface OverlayOptions {
  readonly target: RendererTarget;
  readonly accelerator: string;
  /** Invoked when the user picks an action that needs the full window. */
  onEscalate(request: { kind: string; id: string; query: string }): void;
}

/**
 * The overlay's document, on whichever origin the app is already trusting.
 *
 * Production serves the renderer over the privileged `switchboard://` scheme,
 * not `file://` — so the overlay must load from the same origin or it will be
 * blocked by the app's own navigation guard, which is exactly what that guard
 * is for.
 */
function overlayUrl(target: RendererTarget): string {
  return target.development
    ? `${DEVELOPMENT_RENDERER_URL}/overlay.html`
    : "switchboard://app/overlay.html";
}

export function createOverlay(options: OverlayOptions): OverlayHost {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Vibrancy is what makes it read as part of macOS rather than a web page
    // floating on top of it.
    ...(process.platform === "darwin"
      ? { vibrancy: "under-window" as const, visualEffectState: "active" as const }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      // The overlay is hidden most of the time; keep it responsive anyway so
      // the first keystroke after ⌥Space is not dropped.
      backgroundThrottling: false
    }
  });

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedRendererUrl(destination, options.target)) {
      event.preventDefault();
    }
  });

  // Dismiss on focus loss: an overlay that lingers after you click away is a
  // window, and a window is not what this is.
  window.on("blur", () => {
    if (!window.isDestroyed() && window.isVisible()) {
      window.hide();
    }
  });

  void window.loadURL(overlayUrl(options.target));

  const place = () => {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    window.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height * VERTICAL_BIAS),
      width: WIDTH,
      height: HEIGHT
    });
  };

  const host: OverlayHost = {
    window,
    show() {
      if (window.isDestroyed()) return;
      // Follow the display the cursor is on, so it opens where you are looking
      // rather than where it was last time.
      place();
      window.showInactive();
      window.focus();
      window.webContents.focus();
    },
    hide() {
      if (!window.isDestroyed() && window.isVisible()) {
        window.hide();
      }
    },
    toggle() {
      if (window.isVisible()) {
        host.hide();
      } else {
        host.show();
      }
    },
    destroy() {
      globalShortcut.unregister(options.accelerator);
      ipcMain.removeHandler(OVERLAY_CHANNELS.hide);
      ipcMain.removeHandler(OVERLAY_CHANNELS.run);
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  };

  ipcMain.handle(OVERLAY_CHANNELS.hide, (event: IpcMainInvokeEvent) => {
    if (event.sender === window.webContents) {
      host.hide();
    }
  });

  ipcMain.handle(OVERLAY_CHANNELS.run, (event: IpcMainInvokeEvent, input: unknown) => {
    if (event.sender !== window.webContents) {
      return;
    }
    const request = (input ?? {}) as { kind?: unknown; id?: unknown; query?: unknown };
    host.hide();
    options.onEscalate({
      kind: typeof request.kind === "string" ? request.kind : "ask",
      id: typeof request.id === "string" ? request.id : "",
      query: typeof request.query === "string" ? request.query : ""
    });
  });

  return host;
}

/**
 * Registers the hotkey, reporting rather than throwing when it is taken.
 *
 * ⌥Space is popular — Spotlight alternatives fight over it — and a launcher
 * that silently fails to bind is worse than one that says so.
 */
export function bindHotkey(accelerator: string, onPress: () => void): boolean {
  if (globalShortcut.isRegistered(accelerator)) {
    return false;
  }
  return globalShortcut.register(accelerator, onPress);
}
