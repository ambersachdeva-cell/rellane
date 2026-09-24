export const DURABLE_SPACES_GATE_MARKER = "switchboard-durable-spaces-gate-v1" as const;
export const DURABLE_SPACES_ENABLED = false as const;

/** Deliberately generic and fail-closed until runtime capability proof is separately accepted. */
export function assertDurableSpacesAvailable(): never {
  throw new Error("Durable spaces are unavailable.");
}
