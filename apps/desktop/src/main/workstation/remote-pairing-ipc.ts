import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import type { RemoteOneRunHandoverScope, RemoteOneRunHandoverReview } from "./remote-dispatch-server.js";

export type PairingStatus =
  | {
      readonly state: "off";
    }
  | {
      readonly state: "listening";
      readonly url: string;
      readonly pin: string;
      readonly expiresAt: number;
    };

export type WorkstationPairingReachable = "this-mac" | "wifi";

export const WorkstationPairingStartInputSchema = z.object({
  reachable: z.enum(["this-mac", "wifi"]),
});

export type WorkstationPairingStartInput = z.infer<typeof WorkstationPairingStartInputSchema>;

export interface InstallRemotePairingOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Starts the server. Resolves once it is genuinely listening. */
  readonly startServer: (input: { readonly host: string }) => Promise<{
    readonly url: string;
    readonly pin: string;
    readonly expiresAt: number;
    readonly stop: () => Promise<void>;
    readonly handover?: {
      readonly candidates: () => { readonly principals: readonly string[];
        readonly runs: readonly { readonly principalId: string; readonly caseId: string;
          readonly operationId: string }[] };
      readonly prepare: (input: RemoteOneRunHandoverScope) => RemoteOneRunHandoverReview;
      readonly approve: (token: string) => RemoteOneRunHandoverScope;
    };
  }>;
  /** The Wi-Fi address of this Mac, or null when there is none. */
  readonly lanAddress: () => string | null;
}

interface ActivePairingServer {
  readonly url: string;
  readonly pin: string;
  readonly expiresAt: number;
  readonly stop: () => Promise<void>;
  readonly handover?: NonNullable<Awaited<ReturnType<InstallRemotePairingOptions["startServer"]>>["handover"]>;
}

function sanitizeErrorMessage(error: unknown, activePin?: string): string {
  let message = error instanceof Error ? error.message : String(error);

  // Redact UNIX and Windows absolute and relative file system paths
  message = message.replace(/(?:\/[a-zA-Z0-9._-]+)+/g, "[path]");
  message = message.replace(/[a-zA-Z]:\\[^\s]+/g, "[path]");

  // Redact stack traces originating from Node or V8 runtimes
  message = message.replace(/\s+at\s+.*$/gms, "");

  // Redact known active PIN value if present in error detail
  if (activePin !== undefined && activePin.length > 0) {
    message = message.replaceAll(activePin, "[pin]");
  }

  // Redact any 6-digit numeric sequences that could represent pairing PINs
  message = message.replace(/\b\d{6}\b/g, "[pin]");

  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "An unexpected error occurred.";
}

export function installRemotePairing(options: InstallRemotePairingOptions): { readonly shutdown: () => Promise<void> } {
  let activeServer: ActivePairingServer | null = null;
  let activeOwner: unknown = null;
  let startingPromise: Promise<PairingStatus> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const stopActiveServer = async (): Promise<void> => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    const server = activeServer;
    activeServer = null;
    activeOwner = null;
    if (server !== null) {
      try {
        await server.stop();
      } catch {
        // Ignored on server shutdown
      }
    }
  };

  // Cease pairing immediately if the initiating window is navigated or closed
  const owners = createAgentSourceOwners((evictedOwner?: unknown) => {
    if (activeOwner !== null && (evictedOwner === undefined || evictedOwner === activeOwner)) {
      void stopActiveServer();
    }
  });

  const ownerFor = (event: IpcMainInvokeEvent): unknown => owners(event.sender, event.senderFrame);

  const getStatus = async (): Promise<PairingStatus> => {
    if (activeServer === null) {
      return { state: "off" };
    }

    if (Date.now() >= activeServer.expiresAt) {
      await stopActiveServer();
      return { state: "off" };
    }

    return {
      state: "listening",
      url: activeServer.url,
      pin: activeServer.pin,
      expiresAt: activeServer.expiresAt,
    };
  };

  ipcMain.handle(IPC_CHANNELS.workstationPairingStatus, async (event: IpcMainInvokeEvent): Promise<PairingStatus> => {
    options.assertTrusted(event);
    try {
      return await getStatus();
    } catch (error) {
      throw new Error(sanitizeErrorMessage(error, activeServer?.pin));
    }
  });

  ipcMain.handle(IPC_CHANNELS.workstationPairingStart, async (event: IpcMainInvokeEvent, input: unknown): Promise<PairingStatus> => {
    options.assertTrusted(event);
    try {
      const current = await getStatus();
      if (current.state === "listening") {
        return current;
      }

      if (startingPromise !== null) {
        return await startingPromise;
      }

      startingPromise = (async (): Promise<PairingStatus> => {
        try {
          const owner = ownerFor(event);

          const parsed = WorkstationPairingStartInputSchema.safeParse(
            typeof input === "string" ? { reachable: input } : input
          );
          if (!parsed.success) {
            throw new Error("Please choose whether to connect from this Mac or over Wi-Fi.");
          }

          let host: string;
          if (parsed.data.reachable === "this-mac") {
            host = "127.0.0.1";
          } else {
            const lan = options.lanAddress();
            if (lan === null || lan.trim().length === 0) {
              throw new Error("This Mac is not on a Wi-Fi network.");
            }
            const trimmedLan = lan.trim();
            // Reject wildcards to prevent unintended exposure to public interfaces
            if (trimmedLan === "0.0.0.0" || trimmedLan.includes("0.0.0.0")) {
              throw new Error("Cannot bind to an open address.");
            }
            host = trimmedLan;
          }

          // Defensive check ensuring 0.0.0.0 cannot reach startServer
          if (host === "0.0.0.0" || host.includes("0.0.0.0")) {
            throw new Error("Cannot bind to an open address.");
          }

          const server = await options.startServer({ host });

          options.assertTrusted(event);
          if (ownerFor(event) !== owner) {
            try {
              await server.stop();
            } catch {
              // Ignored when stopping discarded server
            }
            throw new Error("This window changed while starting remote pairing.");
          }

          activeServer = server;
          activeOwner = owner;
          expiryTimer = setTimeout(() => { void stopActiveServer(); }, Math.max(0, server.expiresAt - Date.now()));
          if (typeof expiryTimer.unref === "function") expiryTimer.unref();

          return {
            state: "listening",
            url: server.url,
            pin: server.pin,
            expiresAt: server.expiresAt,
          };
        } finally {
          startingPromise = null;
        }
      })();

      return await startingPromise;
    } catch (error) {
      throw new Error(sanitizeErrorMessage(error, activeServer?.pin));
    }
  });

  ipcMain.handle(IPC_CHANNELS.workstationPairingStop, async (event: IpcMainInvokeEvent): Promise<PairingStatus> => {
    options.assertTrusted(event);
    try {
      if (startingPromise !== null) {
        try {
          await startingPromise;
        } catch {
          // If start fails, proceed with ensuring server is off
        }
      }

      await stopActiveServer();

      return { state: "off" };
    } catch (error) {
      throw new Error(sanitizeErrorMessage(error));
    }
  });

  const requireHandover = (event: IpcMainInvokeEvent) => {
    options.assertTrusted(event);
    if (activeServer === null || activeServer.expiresAt <= Date.now() ||
        activeOwner !== ownerFor(event) || activeServer.handover === undefined)
      throw new Error("Start a current pairing from this Mac window before approving a handover.");
    return activeServer.handover;
  };
  ipcMain.handle(IPC_CHANNELS.workstationPairingHandoverCandidates,
    (event: IpcMainInvokeEvent) => requireHandover(event).candidates());
  ipcMain.handle(IPC_CHANNELS.workstationPairingHandoverPrepare,
    (event: IpcMainInvokeEvent, input: unknown) => {
      const handover = requireHandover(event);
      const scope = z.strictObject({ caseId: z.string().min(1).max(64), operationId: z.uuid(),
        oldPrincipalId: z.string().regex(/^prnc_[a-f0-9]{32}$/u),
        newPrincipalId: z.string().regex(/^prnc_[a-f0-9]{32}$/u) }).parse(input);
      return handover.prepare(scope);
    });
  ipcMain.handle(IPC_CHANNELS.workstationPairingHandoverApprove,
    (event: IpcMainInvokeEvent, input: unknown) => {
      const handover = requireHandover(event);
      const { token } = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(input);
      return handover.approve(token);
    });

  return { shutdown: async () => {
    if (startingPromise !== null) await startingPromise.catch(() => undefined);
    await stopActiveServer();
  } };
}
