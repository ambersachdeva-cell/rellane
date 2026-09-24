/**
 * The facts the shell states about itself, and the one problem worth interrupting for.
 *
 * These were the top of a home page that no longer exists. The Desk replaced it
 * (D-087) because a dashboard showed figures and offered no verb — but the facts
 * themselves were never the problem with that screen, and throwing them away
 * with it would have lost the one rule they encode:
 *
 * **Never a count that was not observed.** `null` means the probe has not run,
 * which is a different fact from zero, and it reads as "checking…" rather than
 * as a confident nothing. That distinction is the whole trust model in four
 * lines of code.
 *
 * They live here rather than in a component because the status strip states
 * them on every screen now, and a fact that follows you around the app should
 * not be owned by any one page.
 */

import type { ActivityLog, AgentCard, EngineRoomStatus } from "@cadrane/contracts";
import { plural } from "../shared/copy.js";

export interface HomeFact {
  readonly label: string;
  readonly value: string;
  readonly go: "agents" | "timeline" | "engines" | "connectors" | "settings";
  /** True when this is the one worth acting on, so colour marks the exception. */
  readonly wanting: boolean;
}

export function facts(
  engines: EngineRoomStatus | null,
  folders: readonly string[],
  agents: readonly AgentCard[] | null,
  activity: ActivityLog | null
): readonly HomeFact[] {
  const detected = engines?.engines.filter(engine => engine.access === "subscription" &&
    (engine.state === "detected" || engine.state === "ready")).length ?? 0;
  const runnable = (agents ?? []).filter((agent) => !agent.inert).length;

  return [
    {
      label: "Provider tools",
      // Never a count it has not observed: null means the probe has not run,
      // which is a different fact from zero.
      value: engines === null ? "checking…" : `${detected} detected`,
      go: "engines",
      wanting: false
    },
    {
      label: "Folder access",
      value: folders.length === 0 ? "none granted" : plural(folders.length, "folder"),
      go: "settings",
      wanting: false
    },
    {
      label: "Saved agents",
      value: agents === null ? "reading briefs…" : plural(runnable, "agent"),
      go: "agents",
      wanting: agents !== null && runnable === 0
    },
    {
      label: "On the record",
      value:
        activity === null
          ? "reading…"
          : !activity.trustworthy
            ? "unavailable"
            : activity.entries.length === 0
            ? "nothing yet"
            : plural(activity.entries.length, "entry", "entries"),
      go: "timeline",
      wanting: activity !== null && !activity.trustworthy
    }
  ];
}
