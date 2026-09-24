import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

/** Cap at 5,000 receipts to protect the renderer from unbounded heap usage. */
export const WORKSTATION_USAGE_RECEIPT_CAP = 5_000;

export const WorkstationUsageWindowSchema = z.enum(["today", "week", "month"]);
export type WorkstationUsageWindow = z.infer<typeof WorkstationUsageWindowSchema>;

export const WorkstationUsageInputSchema = z.object({
  window: WorkstationUsageWindowSchema
});
export type WorkstationUsageInput = z.infer<typeof WorkstationUsageInputSchema>;

export interface UsageReceiptView {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string | null;
  readonly status: "completed" | "stopped" | "failed" | "interrupted";
  readonly startedAt: number;
  readonly endedAt: number;
  readonly caseId: string;
}

export interface WorkstationUsageResult {
  readonly receipts: readonly UsageReceiptView[];
  readonly known: readonly { readonly id: string; readonly label: string }[];
  readonly skipped: number;
  readonly capped: boolean;
}

export interface InstallUsageOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Every session receipt body, newest first, already limited by the caller. */
  readonly receipts: () => readonly { readonly body: string; readonly at: number }[];
  /** The subscriptions this Mac has, whether or not they have been used. */
  readonly known: () => Promise<readonly { readonly id: string; readonly label: string }[]>;
}

export function parseUsageReceipt(
  entry: { readonly body: string; readonly at: number },
  knownLabels: ReadonlyMap<string, string>
): UsageReceiptView | null {
  let raw: unknown;
  try {
    raw = JSON.parse(entry.body);
  } catch {
    // Malformed JSON is skipped to prevent an unparseable row taking down the screen.
    return null;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // Non-object bodies cannot satisfy the session receipt contract.
    return null;
  }

  const record = raw as Record<string, unknown>;

  const providerIdRaw = record["providerId"] ?? record["provider"];
  if (typeof providerIdRaw !== "string" || providerIdRaw.trim().length === 0) {
    return null;
  }
  const providerId = providerIdRaw.trim();

  const caseIdRaw = record["caseId"] ?? record["case_id"];
  if (typeof caseIdRaw !== "string" || caseIdRaw.trim().length === 0) {
    return null;
  }
  const caseId = caseIdRaw.trim();

  const rawLabel = record["providerLabel"] ?? record["label"];
  const providerLabel =
    typeof rawLabel === "string" && rawLabel.trim().length > 0
      ? rawLabel.trim()
      : knownLabels.get(providerId) ?? providerId;

  const rawModel = record["modelId"] ?? record["model"];
  const modelId =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : null;

  // Optimistic reading of unknown states is forbidden; an unrecognised status fails safe.
  let status: "completed" | "stopped" | "failed" | "interrupted" = "failed";
  const rawStatus = record["status"];
  if (
    rawStatus === "completed" ||
    rawStatus === "stopped" ||
    rawStatus === "failed" ||
    rawStatus === "interrupted"
  ) {
    status = rawStatus;
  }

  let startedAt: number | null = null;
  let endedAt: number | null = null;

  const rawStartedAt = record["startedAt"] ?? record["started_at"];
  if (typeof rawStartedAt === "number" && Number.isFinite(rawStartedAt)) {
    startedAt = rawStartedAt;
  }

  const rawEndedAt = record["endedAt"] ?? record["ended_at"];
  if (typeof rawEndedAt === "number" && Number.isFinite(rawEndedAt)) {
    endedAt = rawEndedAt;
  }

  if (startedAt === null && endedAt !== null) {
    startedAt = endedAt;
  } else if (endedAt === null && startedAt !== null) {
    endedAt = startedAt;
  } else if (startedAt === null && endedAt === null) {
    const rawAt = record["at"];
    if (typeof rawAt === "number" && Number.isFinite(rawAt)) {
      startedAt = rawAt;
      endedAt = rawAt;
    } else if (typeof entry.at === "number" && Number.isFinite(entry.at)) {
      startedAt = entry.at;
      endedAt = entry.at;
    }
  }

  if (startedAt === null || endedAt === null) {
    return null;
  }

  // Never leak case titles, prompts, or turns; only clean counting metadata leaves this channel.
  return {
    providerId,
    providerLabel,
    modelId,
    status,
    startedAt,
    endedAt,
    caseId
  };
}

export function installUsage(options: InstallUsageOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  ipcMain.handle(
    IPC_CHANNELS.workstationUsage,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationUsageResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      WorkstationUsageInputSchema.parse(
        typeof input === "string" ? { window: input } : input
      );

      const known = await options.known();

      // Verify sender trust and identity stability across asynchronous dispatch.
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while reading usage.");
      }

      const knownLabels = new Map<string, string>();
      for (const sub of known) {
        knownLabels.set(sub.id, sub.label);
      }

      const rawList = options.receipts();
      const receipts: UsageReceiptView[] = [];
      let skipped = 0;
      let capped = rawList.length > WORKSTATION_USAGE_RECEIPT_CAP;

      for (const entry of rawList) {
        if (receipts.length >= WORKSTATION_USAGE_RECEIPT_CAP) {
          capped = true;
          break;
        }

        const parsed = parseUsageReceipt(entry, knownLabels);
        if (parsed === null) {
          skipped += 1;
        } else {
          receipts.push(parsed);
        }
      }

      return {
        receipts,
        known,
        skipped,
        capped
      };
    }
  );
}
