/**
 * The crew, against real seats on real accounts. Skipped unless asked for.
 *
 * `CREW_LIVE=1 ./node_modules/.bin/vitest run apps/desktop/src/main/crew/live.test.ts`
 *
 * Everything else in this folder is engine-blind, which is right for a loop and
 * proves nothing about whether the arrangement works. D-030 and D-031 were both
 * found by a real model failing in a way no stub would have reproduced: the loop
 * was correct, the parser was correct, and a real model still could not use a
 * tool because the prompt withheld a folder path. A fake engine returns whatever
 * the test author imagined.
 *
 * This spends real quota, which is why it is off by default.
 */

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Board } from "./claims.js";
import { work, type CrewSeat, type FanOutDeps } from "./fanout.js";
import { Governor } from "../subscription-brain/governor.js";
import type { Seat } from "../subscription-brain/accounts.js";
import type { Turn } from "./untrusted.js";

const LIVE = process.env["CREW_LIVE"] === "1";

interface LiveSeat extends CrewSeat {
  readonly home: string;
}

const SEATS: readonly LiveSeat[] = [
  {
    label: "Builder", pool: "config1:gemini", home: "config1",
    brief: "You are the BUILDER. Answer in at most four short lines."
  },
  {
    label: "Tester", pool: "config2:gemini", home: "config2",
    brief:
      "You are the TESTER. Say what you would assert, against the done-when only. " +
      "TypeScript and vitest — the first live run answered in Python because this " +
      "brief never named a language, and a seat cannot infer a stack it was not told. " +
      "At most four short lines."
  }
];

function askRealSeat(seat: LiveSeat, prompt: string): Promise<{ text: string; cost: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "agy",
      ["-p", prompt, "--model", "gemini-3.8-flash-high", "--print-timeout", "10m",
       "--dangerously-skip-permissions"],
      {
        // Only HOME is overridden, so a seat says whose environment the vendor's
        // own binary runs in and nothing else about it. The token stays in that
        // directory, unread (D-091).
        env: { ...process.env, HOME: path.join(os.homedir(), "agy-setup", seat.home) },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("close", (code) => {
      if (code === 0 && out.trim().length > 0) {
        resolve({ text: out.trim(), cost: Math.ceil(out.length / 4) });
      } else {
        reject(new Error(err.trim().slice(0, 200) || `exit ${String(code)}, no output`));
      }
    });
    child.on("error", (e: Error) => { reject(e); });
  });
}

describe.skipIf(!LIVE)("the crew, on real subscriptions", () => {
  it(
    "runs two seats on two accounts through one board, governed",
    async () => {
      const governor = new Governor({
        maxInFlight: 1,
        maxInFlightPerPool: 1,
        dailyPerPool: 200_000,
        perCase: 150_000
      });
      const board = new Board();
      board.add({
        id: "j1",
        what: "Name the single riskiest edge case when reading an Indian invoice with split CGST and SGST.",
        doneWhen: "one edge case, named, and why it is risky"
      });
      board.add({
        id: "j2",
        what: "Say what a test would assert to prove that edge case is handled.",
        doneWhen: "one assertion a test could make"
      });

      const said: Turn[] = [];
      const prompts: string[] = [];

      const deps: FanOutDeps = {
        admit: (seat, estimate) => {
          const [accountId, family] = seat.pool.split(":");
          const asSeat: Seat = {
            accountId: accountId ?? "",
            family: (family ?? "gemini") as Seat["family"],
            providerId: "antigravity",
            modelId: "gemini-3.8-flash-high",
            label: seat.label
          };
          return governor.admit(asSeat, "live-case", estimate);
        },
        finished: (ticket, actual) => { governor.finished(ticket, actual); },
        ask: async (seat, prompt) => {
          prompts.push(prompt);
          return askRealSeat(seat as LiveSeat, prompt);
        },
        say: (turn) => { said.push(turn); }
      };

      const result = await work(
        SEATS, board, deps,
        "A bill parser reads Indian invoices that carry CGST and SGST separately.",
        3
      );

      // Both seats really answered, on different accounts.
      expect(said.length).toBeGreaterThanOrEqual(2);
      expect(new Set(said.map((turn) => turn.seat)).size).toBe(2);
      expect(result.settled).toBe(true);

      // The second seat read the first one's answer — the whole point of one
      // shared room rather than two private conversations.
      expect(prompts[1]).toContain(said[0]!.body.slice(0, 40));

      // The governor charged two different pools, which is the claim the whole
      // pitch rests on: three logins are six budgets.
      expect(governor.spentToday({ accountId: "config1", family: "gemini" })).toBeGreaterThan(0);
      expect(governor.spentToday({ accountId: "config2", family: "gemini" })).toBeGreaterThan(0);

      // eslint-disable-next-line no-console
      console.log("\n--- what the seats actually said ---");
      for (const turn of said) {
        // eslint-disable-next-line no-console
        console.log(`[${turn.seat}] ${turn.body.slice(0, 300).replace(/\n/gu, " ")}`);
      }
    },
    15 * 60 * 1000
  );
});
