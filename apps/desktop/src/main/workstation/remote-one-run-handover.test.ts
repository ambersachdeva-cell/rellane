/** Exercise the real server transaction without opening a socket or running a model. */
import { afterEach, expect, it, vi } from "vitest";
import { createRemoteDispatchServer, type RemoteDispatchServer,
  type RemoteOneRunHandoverScope } from "./remote-dispatch-server.js";

const oldId = `prnc_${"a".repeat(32)}`;
const newId = `prnc_${"b".repeat(32)}`;
const scope: RemoteOneRunHandoverScope = { caseId: "case-1",
  operationId: "11111111-1111-4111-8111-111111111111",
  oldPrincipalId: oldId, newPrincipalId: newId };
const timers: ReturnType<typeof setTimeout>[] = [];

function fixture(): { server: RemoteDispatchServer; active: Map<string, unknown>;
  replay: Map<string, unknown>; reviews: Map<string, unknown> } {
  const server = createRemoteDispatchServer({ pin: "246810", host: "127.0.0.1" });
  Reflect.set(server, "isRunningServer", true);
  Reflect.set(server, "generation", 7);
  const active = Reflect.get(server, "activePrincipals") as Map<string, unknown>;
  const replay = Reflect.get(server, "replayMap") as Map<string, unknown>;
  const reviews = Reflect.get(server, "preparedReviews") as Map<string, unknown>;
  const now = Date.now();
  const oldTimer = setTimeout(() => {}, 120_000);
  const newTimer = setTimeout(() => {}, 120_000);
  oldTimer.unref(); newTimer.unref(); timers.push(oldTimer, newTimer);
  active.set(oldId, { principalId: oldId, kind: "phone", sequence: 1,
    pairedAt: now - 30_000, expiresAt: now + 120_000, timer: oldTimer });
  active.set(newId, { principalId: newId, kind: "phone", sequence: 2,
    pairedAt: now, expiresAt: now + 120_000, timer: newTimer });
  return { server, active, replay, reviews };
}
afterEach(() => { for (const timer of timers.splice(0)) clearTimeout(timer); vi.restoreAllMocks(); });

it("requires a one-use Mac review, transfers synchronously, then revokes the old principal", () => {
  const { server, active, reviews } = fixture();
  const revoked: string[] = [];
  server.onRevokePrincipal(({ principalId }) => { revoked.push(principalId); });
  reviews.set("old-review", { principalId: oldId, review: {}, expiresAt: Date.now() + 60_000 });
  const shown = server.prepareOneRunHandover(scope);
  expect(shown).toMatchObject({ ...scope, generation: 7 });
  expect(shown.token).toMatch(/^[a-f0-9]{64}$/u);
  expect(active.has(oldId)).toBe(true);
  let transferSawOldBearer = false;
  expect(server.commitOneRunHandover(shown.token, (exact) => {
    expect(exact).toMatchObject(scope);
    transferSawOldBearer = active.has(oldId);
  })).toMatchObject(scope);
  expect(transferSawOldBearer).toBe(true);
  expect(active.has(oldId)).toBe(false);
  expect(active.has(newId)).toBe(true);
  expect(reviews.has("old-review")).toBe(false);
  expect(revoked).toEqual([oldId]);
  expect(() => server.commitOneRunHandover(shown.token, () => {})).toThrow(/already used/u);
});

it("refuses PIN-only, reversed, reused, expired, and restarted handover authority", () => {
  const { server, active } = fixture();
  expect(() => server.prepareOneRunHandover({ ...scope, newPrincipalId: `prnc_${"c".repeat(32)}` }))
    .toThrow(/newly paired/u);
  expect(() => server.prepareOneRunHandover({ ...scope, oldPrincipalId: newId,
    newPrincipalId: oldId })).toThrow(/newly paired/u);
  const shown = server.prepareOneRunHandover(scope);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  expect(() => server.commitOneRunHandover(shown.token, () => {})).toThrow(/expired/u);
  expect(active.has(oldId)).toBe(true);
  vi.restoreAllMocks();
  const afterExpiry = server.prepareOneRunHandover(scope);
  Reflect.set(server, "generation", 8);
  expect(() => server.commitOneRunHandover(afterExpiry.token, () => {})).toThrow(/expired/u);
  expect(active.has(oldId)).toBe(true);
});

it("refuses transfer while old effects may be in flight or the new phone has issued commands", () => {
  const { server, active, replay } = fixture();
  replay.set(`${oldId}:stop-pending`, { fingerprint: "x", status: "pending" });
  expect(() => server.prepareOneRunHandover(scope)).toThrow(/active/u);
  replay.clear();
  const shown = server.prepareOneRunHandover(scope);
  replay.set(`${oldId}:decision-pending`, { fingerprint: "y", status: "pending" });
  let transferred = false;
  expect(() => server.commitOneRunHandover(shown.token, () => { transferred = true; }))
    .toThrow(/active/u);
  expect(transferred).toBe(false);
  expect(active.has(oldId)).toBe(true);
  replay.clear();
  replay.set(`${newId}:other-command`, { fingerprint: "z", status: "completed" });
  expect(() => server.prepareOneRunHandover(scope)).toThrow(/already issued commands/u);
});

it("leaves old bearer and run untouched when the exact Host transfer rejects", () => {
  const { server, active } = fixture();
  const shown = server.prepareOneRunHandover(scope);
  expect(() => server.commitOneRunHandover(shown.token, () => {
    throw new Error("The run finished before Mac approval");
  })).toThrow(/run finished/u);
  expect(active.has(oldId)).toBe(true);
  expect(() => server.commitOneRunHandover(shown.token, () => {})).toThrow(/already used/u);
});
