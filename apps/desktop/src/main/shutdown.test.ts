/** TypeScript / vitest: a failed disposer must not strand the remaining cleanup. */
import { describe, expect, it } from "vitest";
import { runShutdownSteps } from "./shutdown.js";

describe("shutdown cleanup", () => {
  it("awaits cleanup in order and continues past synchronous and asynchronous failures", async () => {
    const visited: string[] = [];
    const failures: string[] = [];
    await runShutdownSteps(
      [
        {
          name: "service",
          run: async () => {
            await Promise.resolve();
            visited.push("service");
          }
        },
        {
          name: "presence",
          run: () => {
            visited.push("presence");
            throw new Error("broken");
          }
        },
        {
          name: "connector",
          run: async () => {
            visited.push("connector");
            throw new Error("broken");
          }
        },
        {
          name: "book",
          run: () => {
            visited.push("book");
          }
        }
      ],
      (name) => failures.push(name)
    );
    expect(visited).toEqual(["service", "presence", "connector", "book"]);
    expect(failures).toEqual(["presence", "connector"]);
  });
  it("still reaches later cleanup when diagnostics also fail", async () => {
    let reached = false;
    await runShutdownSteps(
      [
        {
          name: "broken",
          run: () => {
            throw new Error("broken");
          }
        },
        {
          name: "last",
          run: () => {
            reached = true;
          }
        }
      ],
      () => {
        throw new Error("diagnostics unavailable");
      }
    );
    expect(reached).toBe(true);
  });
});
