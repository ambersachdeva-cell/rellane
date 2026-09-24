/**
 * A native session runs on a subscription, not on a key.
 *
 * Every one of these CLIs will quietly fall back to an API key in the
 * environment. That is the difference between work that costs nothing beyond a
 * plan the owner already pays for and work that bills a card — and it would
 * happen silently, because the session would look exactly the same.
 */
import { describe, expect, it } from "vitest";
import { WORKSTATION_REMOVED_ENV_KEYS, nativeChildEnv } from "./env.js";

describe("the environment a native session gets", () => {
  it("removes the API-key fallbacks without touching this process", () => {
    const restore: [string, string | undefined][] = WORKSTATION_REMOVED_ENV_KEYS.map((key) => [
      key,
      process.env[key]
    ]);
    for (const key of WORKSTATION_REMOVED_ENV_KEYS) process.env[key] = "placeholder";

    try {
      const child = nativeChildEnv();
      for (const key of WORKSTATION_REMOVED_ENV_KEYS) {
        expect(child[key]).toBeUndefined();
        // The app's own environment is left exactly as it was: mutating it
        // would change what every later child process inherits.
        expect(process.env[key]).toBe("placeholder");
      }
      // It is a copy, not an empty object: the child still needs PATH.
      expect(Object.keys(child).length).toBeGreaterThan(0);
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("points HOME at a profile folder only for the child", () => {
    const before = process.env["HOME"];
    const child = nativeChildEnv("/tmp/agy-setup/config2");
    expect(child["HOME"]).toBe("/tmp/agy-setup/config2");
    expect(process.env["HOME"]).toBe(before);
  });

  it("leaves HOME alone when no profile was given", () => {
    expect(nativeChildEnv()["HOME"]).toBe(process.env["HOME"]);
  });
});
