/** Keep the useful failure message without Electron's internal channel name. */
export function workroomMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return (
    error.message
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "")
      .trim() || fallback
  );
}
