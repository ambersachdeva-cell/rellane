/** Only named, trusted shapes reach the bundled server. A grammar is not a fact check. */
import { BILL_FIELDS, ENQUIRY_FIELDS, type LocalChatRequest } from "@cadrane/contracts";
import { RuntimeBoundaryError } from "../errors.js";

export function responseProfileOptions(request: LocalChatRequest, bundled: boolean) {
  if (request.responseProfile === undefined) return {};
  if (!bundled || request.runtimeId !== "cadrane-local-loopback" ||
      !["print-enquiry-v1", "local-draft-v1", "bill-excerpts-v1"].includes(request.responseProfile))
    throw new RuntimeBoundaryError({ code: "BAD_REQUEST",
      message: "This response profile is supported only by the bundled local model.",
      retryable: false });
  // Short interactive drafts need a final answer within their existing budget.
  // This is a named host policy, never an arbitrary renderer template override.
  if (request.responseProfile === "local-draft-v1")
    return { chat_template_kwargs: { enable_thinking: false } };
  const quote = { anyOf: [{ type: "string", minLength: 1, maxLength: 400 }, { type: "null" }] };
  const bill = request.responseProfile === "bill-excerpts-v1";
  const fields = bill ? [...BILL_FIELDS] : ENQUIRY_FIELDS.map(field => field.id);
  return {
    // b10182 server-common.cpp unwraps json_schema.schema for this type.
    // Its README's sibling-schema example silently selects generic JSON.
    response_format: { type: "json_schema", json_schema: {
      name: bill ? "bill_excerpts_v1" : "print_enquiry_v1", strict: true,
      schema: {
        type: "object", additionalProperties: false, required: ["scope", "fields"],
        properties: {
          scope: { type: "string", enum: bill ? ["one_bill", "multiple_bills", "unclear"] : ["one_job", "multiple_jobs", "unclear"] },
          fields: { type: "object", additionalProperties: false,
            required: fields,
            properties: Object.fromEntries(fields.map(field => [field, quote]))
          }
        }
      }
    } },
    chat_template_kwargs: { enable_thinking: false }
  };
}

export function requireCompleteProfile(request: LocalChatRequest, finishReason: string | null | undefined): void {
  if (request.responseProfile && finishReason !== "stop")
    throw new RuntimeBoundaryError({ code: "RUNTIME_RESPONSE_INVALID",
      message: request.responseProfile === "print-enquiry-v1"
        ? "The local model did not finish the enquiry fields. No suggestion was saved. Try a shorter source."
        : request.responseProfile === "bill-excerpts-v1"
          ? "The local model did not finish the bill fields. Nothing was applied. Try a shorter source."
        : "The local model did not finish its answer. Nothing was saved. Ask for a shorter result.",
      retryable: false });
}
