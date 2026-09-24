/** A useful name changes navigation, never the original request or its evidence. */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
export const WorkTitleRequest = z.strictObject({caseId:z.string().min(1).max(64), title:z.string().trim().min(1).max(200), expectedTitle:z.string().min(1).max(200)});
export function renameWork(db: DatabaseSync, input: z.infer<typeof WorkTitleRequest>): void {
  const request = WorkTitleRequest.parse(input);
  const result = db.prepare("UPDATE work_case SET title = ? WHERE id = ? AND title = ?").run(request.title, request.caseId, request.expectedTitle);
  if (Number(result.changes) !== 1) throw new Error("This work changed or is no longer available. Reopen it before renaming.");
}
