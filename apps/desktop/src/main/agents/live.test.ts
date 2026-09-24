import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "./run.js";
import { newBrief } from "./brief.js";
import { askEngine } from "./ask.js";
import { createSandbox } from "../tools/sandbox.js";
import { readEngineRoom } from "../subscription-brain/engine-room.js";

/**
 * An agent reaching for a file, on the real engines on this machine.
 *
 * Skipped unless AGENTS_LIVE=1, because it spends the owner's subscription.
 *
 * The unit tests prove the loop is correct against a fake engine. They cannot
 * prove that a real model, reading the real system prompt, emits the TOOL line
 * in the shape the parser expects — and that is the only part of this feature
 * that cannot be established by reasoning about the code. A protocol nobody has
 * watched a live model speak is a guess.
 */
describe("an agent using a tool, live", () => {
  it.runIf(process.env["AGENTS_LIVE"] === "1")(
    "reads a file it was not given, to answer a question it could not otherwise answer",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "cadrane-live-"));
      try {
        // Deliberately a number that appears in no prompt: if the answer
        // contains it, the file was genuinely read rather than guessed.
        await writeFile(
          join(folder, "quote-devgiri.txt"),
          [
            "Devgiri Traders — quotation, 24 Aug 2026",
            "120 pcs brass hinge 4 inch @ 68/- = 8,160",
            "40 pcs tower bolt 6 inch @ 145/- = 5,800",
            "Transport 400",
            "Total 14,360. Paid 5,000 advance by UPI. Balance 9,360."
          ].join("\n")
        );
        await writeFile(join(folder, "note.md"), "Ring Devgiri on Tuesday.");

        const brief = newBrief({
          id: "live",
          name: "Reader",
          purpose: "Answer a question about a folder by reading what is in it",
          folders: [folder],
          reads: ["folders"],
          capabilities: ["list_folder", "read_text"],
          tier: "fast",
          maxSteps: 6,
          maxMinutes: 3,
          outbound: "never"
        });

        const run = await runAgent(brief, "How much does Devgiri still owe?", {
          room: await readEngineRoom(),
          ceiling: {
            grantedFolders: [folder],
            availableCapabilities: ["list_folder", "read_text"], storedAgents: []
          },
          ask: askEngine,
          // Nothing pre-gathered on purpose: the only way to the answer is a
          // tool call. An agent handed the contents would prove nothing.
          gather: async () => [],
          tools: { sandbox: await createSandbox([folder]) }
        });

        // eslint-disable-next-line no-console
        console.log(
          `\n${run.outcome} on ${run.ranOn?.engineLabel ?? "—"} · ${run.used
            .map((step) => step.said)
            .join(" | ")}\n${run.answer}\n`
        );

        expect(run.outcome).toBe("answered");
        expect(run.used.length).toBeGreaterThan(0);
        expect(run.answer).toContain("9,360");
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    240_000
  );
});
