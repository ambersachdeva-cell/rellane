import { describe, expect, it } from "vitest";
import { undoTerms } from "./PlanSheet";

/**
 * The footer of the plan sheet is where consent is given, so these assertions
 * are about a promise rather than about a string.
 *
 * Until 2026-08-30 this line read "Rellane copies the folder first" on every
 * folder, including ones where the executor would then refuse to run at all.
 * That is the failure mode DESIGN.md §8 forbids by name — offering an undo the
 * app cannot perform — printed on the one screen the trust model rests on.
 */
describe("what the plan sheet promises about putting a folder back", () => {
  it("says the snapshot costs no disk when the volume can clone", () => {
    const terms = undoTerms({ kind: "instant", bytes: 64 * 1024 * 1024 }, 10);

    expect(terms.blocks).toBe(false);
    expect(terms.line).toContain("64.0 MB");
    expect(terms.line).toContain("no extra disk");
    expect(terms.line).toContain("10 minutes");
  });

  it("warns that a real copy is coming when the volume cannot clone", () => {
    const terms = undoTerms({ kind: "copied", bytes: 40 * 1024 * 1024 }, 10);

    // Still allowed — it works, it just is not instant, and the reader is
    // about to wait for it. Saying so is the difference between a slow app and
    // an app that seems to have hung.
    expect(terms.blocks).toBe(false);
    expect(terms.line).toContain("40.0 MB");
    expect(terms.line).toMatch(/takes a moment/u);
  });

  it("blocks the run outright when no snapshot is possible", () => {
    const terms = undoTerms(
      {
        kind: "unavailable",
        bytes: 900 * 1024 * 1024,
        reason: "This volume cannot take instant snapshots, and Invoices is 900 MB."
      },
      10
    );

    // Not a UI preference: the executor already refuses a run it cannot
    // snapshot, so an enabled button would promise work already decided
    // against. The reason is passed through rather than re-worded, so the
    // sentence the reader sees is the one the executor produced.
    expect(terms.blocks).toBe(true);
    expect(terms.line).toBe("This volume cannot take instant snapshots, and Invoices is 900 MB.");
  });

  it("never claims an undo window on a folder that has no undo", () => {
    const terms = undoTerms({ kind: "unavailable", bytes: 0, reason: "That folder is gone." }, 10);

    expect(terms.line).not.toMatch(/minute/u);
  });

  it("counts one minute as one", () => {
    // "1 minutes" is the cheapest possible signal that nobody read the screen.
    expect(undoTerms({ kind: "instant", bytes: 1024 }, 1).line).toContain("1 minute ");
  });
});
