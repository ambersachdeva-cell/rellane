import { NativeCapabilityQaMessageSchema, type NativeCapabilityQaResult } from "@cadrane/contracts/native-capability-qa";

type State = "awaiting-result" | "awaiting-shutdown-complete" | "awaiting-exit" | "complete" | "failed";

export class NativeCapabilityQaMainController {
  private state: State = "awaiting-result";
  private storedResult: NativeCapabilityQaResult | null = null;
  constructor(private readonly runId: string) {}

  receive(value: unknown): "send-shutdown" | "await-exit" {
    const parsed = NativeCapabilityQaMessageSchema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== this.runId || this.state === "failed" || this.state === "complete") return this.fail();
    if (this.state === "awaiting-result" && parsed.data.type === "qa.result") {
      this.storedResult = parsed.data;
      this.state = "awaiting-shutdown-complete";
      return "send-shutdown";
    }
    if (this.state === "awaiting-shutdown-complete" && parsed.data.type === "qa.shutdown-complete") {
      this.state = "awaiting-exit";
      return "await-exit";
    }
    return this.fail();
  }

  observeExit(code: number): NativeCapabilityQaResult {
    if (this.state !== "awaiting-exit" || code !== 0 || this.storedResult === null) return this.fail();
    this.state = "complete";
    return this.storedResult;
  }

  timeout(): never { return this.fail(); }
  private fail(): never { this.state = "failed"; throw new Error("Native capability QA main controller rejected its transcript."); }
}
