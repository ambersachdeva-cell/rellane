import type {
  LocalChatRequest,
  LocalChatResult,
  RuntimeDescriptor,
  RuntimeKind
} from "@cadrane/contracts";
import type { SingleLaneScheduler } from "../single-lane.js";

export type RuntimeAdapterScheduling =
  | { readonly owner: "manager" }
  | {
      readonly owner: "adapter";
      /**
       * Adapter-owned work must enqueue on the exact scheduler injected into
       * LocalRuntimeManager. The identity check prevents a hidden second GPU
       * lane and the double-enqueue deadlock that would result from wrapping
       * the same operation twice.
       */
      readonly lane: SingleLaneScheduler;
    };

export interface LocalRuntimeAdapter {
  readonly id: string;
  readonly kind: RuntimeKind;
  /** Public, configured identity; it makes no claim that a model is ready. */
  readonly identity: { readonly name: string; readonly baseUrl: string | null };
  /**
   * External adapters remain manager-scheduled when this is omitted.
   * The managed adapter can own scheduling because its supervisor must combine
   * lane, lifecycle, and caller cancellation within one operation.
   */
  readonly scheduling?: RuntimeAdapterScheduling;
  probe(): Promise<RuntimeDescriptor>;
  chat(request: LocalChatRequest, signal: AbortSignal): Promise<LocalChatResult>;
  shutdown?(): Promise<void>;
}
