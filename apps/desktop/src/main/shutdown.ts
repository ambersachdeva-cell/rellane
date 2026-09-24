/** One broken disposer must not strand an app after its service has stopped.
 * Cleanup failures are reported individually and later steps still run. */
export interface ShutdownStep {
  readonly name: string;
  readonly run: () => void | Promise<unknown>;
}

export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  onFailure: (name: string) => void
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      try {
        onFailure(step.name);
      } catch {
        /* Diagnostics must not prevent the remaining cleanup. */
      }
    }
  }
}
