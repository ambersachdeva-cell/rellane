import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  describeAction,
  MAX_SHORTCUT_INPUT,
  runAction,
  whyRefused,
  type ActionDescription,
  type ActionOutcome,
  type MacAction,
  type MacActionRuntimeOptions
} from "./mac-actions.js";

const RevealActionSchema = z.object({
  kind: z.literal("reveal"),
  path: z.string().min(1).max(4096)
});

const OpenActionSchema = z.object({
  kind: z.literal("open"),
  path: z.string().min(1).max(4096)
});

const ShortcutActionSchema = z.object({
  kind: z.literal("shortcut"),
  name: z.string().min(1).max(256),
  input: z.string().max(MAX_SHORTCUT_INPUT).optional()
});

export const MacActionSchema = z.discriminatedUnion("kind", [
  RevealActionSchema,
  OpenActionSchema,
  ShortcutActionSchema
]);

export const WorkstationMacDescribeInputSchema = z.union([
  MacActionSchema.transform((action) => ({ action })),
  z
    .object({
      caseId: z.string().min(1).max(256).optional(),
      action: MacActionSchema
    })
    .transform((val) => ({ action: val.action })),
  z
    .discriminatedUnion("kind", [
      z.object({
        caseId: z.string().min(1).max(256).optional(),
        kind: z.literal("reveal"),
        path: z.string().min(1).max(4096)
      }),
      z.object({
        caseId: z.string().min(1).max(256).optional(),
        kind: z.literal("open"),
        path: z.string().min(1).max(4096)
      }),
      z.object({
        caseId: z.string().min(1).max(256).optional(),
        kind: z.literal("shortcut"),
        name: z.string().min(1).max(256),
        input: z.string().max(MAX_SHORTCUT_INPUT).optional()
      })
    ])
    .transform((val) => {
      if (val.kind === "shortcut") {
        const action: MacAction =
          val.input !== undefined
            ? { kind: "shortcut", name: val.name, input: val.input }
            : { kind: "shortcut", name: val.name };
        return { action };
      }
      return {
        action: { kind: val.kind, path: val.path } as MacAction
      };
    })
]);

export const WorkstationMacRunInputSchema = z.union([
  z.object({
    caseId: z.string().min(1).max(256),
    action: MacActionSchema
  }),
  z
    .discriminatedUnion("kind", [
      z.object({
        caseId: z.string().min(1).max(256),
        kind: z.literal("reveal"),
        path: z.string().min(1).max(4096)
      }),
      z.object({
        caseId: z.string().min(1).max(256),
        kind: z.literal("open"),
        path: z.string().min(1).max(4096)
      }),
      z.object({
        caseId: z.string().min(1).max(256),
        kind: z.literal("shortcut"),
        name: z.string().min(1).max(256),
        input: z.string().max(MAX_SHORTCUT_INPUT).optional()
      })
    ])
    .transform((val) => {
      if (val.kind === "shortcut") {
        const action: MacAction =
          val.input !== undefined
            ? { kind: "shortcut", name: val.name, input: val.input }
            : { kind: "shortcut", name: val.name };
        return { caseId: val.caseId, action };
      }
      return {
        caseId: val.caseId,
        action: { kind: val.kind, path: val.path } as MacAction
      };
    })
]);

function toMacAction(action: z.infer<typeof MacActionSchema>): MacAction {
  switch (action.kind) {
    case "reveal":
      return { kind: "reveal", path: action.path };
    case "open":
      return { kind: "open", path: action.path };
    case "shortcut": {
      // Absent properties are preserved without explicit undefined assignment to satisfy exactOptionalPropertyTypes.
      if (action.input !== undefined) {
        return { kind: "shortcut", name: action.name, input: action.input };
      }
      return { kind: "shortcut", name: action.name };
    }
  }
}

export interface InstallWorkstationMacActionsOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly allowedRootFor: (caseId: string) => Promise<string | null>;
  readonly runtimeOptions?: MacActionRuntimeOptions;
}

export function installWorkstationMacActions(
  options: InstallWorkstationMacActionsOptions
): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;

  ipcMain.handle(
    IPC_CHANNELS.workstationMacDescribe,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<ActionDescription> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationMacDescribeInputSchema.parse(input);
      const action = toMacAction(request.action);

      // Describe formats human-readable phrasing for explicit approval without verifying or muting filesystem access.
      const description = describeAction(action);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while describing the action.");
      }

      return description;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationMacRun,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<ActionOutcome> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      if (inFlight) {
        throw new Error("An action is already running. Wait for it to finish.");
      }

      const request = WorkstationMacRunInputSchema.parse(input);
      const action = toMacAction(request.action);

      let allowedRoot: string | null;
      try {
        allowedRoot = await options.allowedRootFor(request.caseId);
      } catch {
        throw new Error("Could not verify permissions for this case.");
      }

      // A case lacking an assigned folder has no permitted sandbox boundary and must be strictly refused.
      if (allowedRoot === null) {
        return {
          status: "refused",
          reason: "This case has no permitted folder."
        };
      }

      // Pre-evaluate safety constraints before claiming the concurrency lock so invalid paths fail fast.
      const refusal = whyRefused(action, allowedRoot);
      if (refusal !== null) {
        return {
          status: "refused",
          reason: refusal
        };
      }

      inFlight = true;
      try {
        const result =
          options.runtimeOptions !== undefined
            ? await runAction(action, allowedRoot, options.runtimeOptions)
            : await runAction(action, allowedRoot);

        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while running the action.");
        }

        return result;
      } finally {
        inFlight = false;
      }
    }
  );
}
