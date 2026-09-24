import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  isBehind,
  RELEASES_URL,
  UPDATE_COSTS,
  VERSIONS_URL
} from "./version.js";

const ok = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;

describe("deciding whether to mention a newer build", () => {
  it("compares the parts, not the string", () => {
    expect(isBehind("0.2.3", "0.2.10")).toBe(true);
    expect(isBehind("0.9.0", "0.10.0")).toBe(true);
    expect(isBehind("1.0.0", "0.9.9")).toBe(false);
    expect(isBehind("0.2.3", "0.2.3")).toBe(false);
  });

  it("claims nothing when either version is unreadable", () => {
    // Telling somebody they are out of date when they are not sends them to
    // download a build they already have, and after that they stop reading the
    // message at all.
    expect(isBehind("0.2.3", "next")).toBe(false);
    expect(isBehind("", "1.0.0")).toBe(false);
    expect(isBehind("0.2.3", "1.0.0-beta")).toBe(false);
  });
});

describe("the check itself", () => {
  it("sends nothing about this Mac", async () => {
    const fetcher = vi.fn(ok({ version: "0.3.0" }));

    await checkForUpdate("0.2.3", fetcher as unknown as typeof fetch);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(VERSIONS_URL);
    expect(String(url)).not.toContain("0.2.3");
    expect(init).toMatchObject({ headers: { accept: "application/json" } });
    // No body, no identifier, no query string. The comparison happens here.
    expect((init as RequestInit | undefined)?.body).toBeUndefined();
  });

  it("says what updating costs, before the link", async () => {
    const result = await checkForUpdate("0.2.3", ok({ version: "0.3.0" }));

    expect(result.behind).toBe(true);
    expect(result.url).toBe(RELEASES_URL);
    expect(result.costs).toEqual(UPDATE_COSTS);
    // The cost that has actually bitten on this machine: a new build is a new
    // identity, so grants are withdrawn and a workspace key can be orphaned.
    expect(result.costs.join(" ")).toContain("granting again");
    expect(result.said).toContain("will not install it for you");
  });

  it("never throws, and never claims a build is bad because a server is", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const result = await checkForUpdate("0.2.3", failing);

    expect(result.behind).toBe(false);
    expect(result.latest).toBeNull();
    expect(result.said).toContain("changes nothing about this build");
  });

  it("treats a bad response as unknown rather than as up to date", async () => {
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const result = await checkForUpdate("0.2.3", notFound);

    expect(result.latest).toBeNull();
    expect(result.said).toContain("Nothing is wrong with this build");
  });
});

describe("what the module will not do", () => {
  it("has no timer, no interval and no launch ping", async () => {
    // "Nothing leaves this Mac without you" has to survive contact with the
    // mundane features too, or it is a slogan rather than a rule. The one
    // request here happens because somebody pressed a button.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./version.ts", import.meta.url), "utf8")
    );

    expect(source).not.toMatch(/setInterval|setTimeout\s*\(/u);
    expect(source).not.toMatch(/autoUpdater|electron-updater/u);
    // One outbound call, and it is the one the owner asked for.
    expect(source.match(/fetcher\(/gu)).toHaveLength(1);
  });
});
