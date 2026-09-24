/** A cold bundled engine may become ready after the window opens. Recheck it
 * finitely without admitting inference or retaining an earlier green result. */
import type { RuntimeDescriptor, RuntimeModel } from "@cadrane/contracts";

const MAX_CHECKS = 8;

export async function checkBundledModel(
  discover: () => Promise<readonly RuntimeDescriptor[]>,
  signal: AbortSignal,
  onWaiting: (completedChecks: number, maximumChecks: number) => void
): Promise<readonly RuntimeModel[]> {
  for (let attempt = 1; attempt <= MAX_CHECKS; attempt += 1) {
    signal.throwIfAborted();
    const runtimes = await discover();
    signal.throwIfAborted();
    const bundled = runtimes.find((runtime) => runtime.id === "cadrane-local-loopback");
    if (bundled?.state === "available" && bundled.models.length > 0)
      return bundled.models;
    // Missing configuration or an invalid runtime contract needs attention,
    // not background retries that make the problem look like ordinary startup.
    if (!bundled || bundled.state === "attention" || attempt === MAX_CHECKS)
      return [];
    onWaiting(attempt, MAX_CHECKS);
    await pauseBeforeRecheck(signal);
  }
  return [];
}

function pauseBeforeRecheck(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 2_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
