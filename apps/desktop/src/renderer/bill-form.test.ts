import { expect, it } from "vitest";
import type { BillRead } from "@cadrane/contracts";
import { billFormFromProposal, validateBillForm, whenOf } from "./bill-form.js";

const unknown = { value: null, from: null };
const bill: NonNullable<BillRead["bill"]> = {
  partyName: { value: "Example Studio", from: "Example Studio" }, number: { value: "S-42", from: "S-42" },
  issuedOn: { value: "2026-09-08", from: "08/09/2026" }, dueOn: unknown,
  subtotalPaise: { value: 105050, from: "1,050.50" }, taxPaise: unknown, totalPaise: unknown
};
it("replaces every field, leaves unmatched or ambiguous customers unselected and preserves paise", () => {
  const first = billFormFromProposal({ ...bill, taxPaise: { value: 0, from: "0" }, dueOn: { value: "2026-09-10", from: "10/09/2026" } }, [{ name: "Example Studio", partyId: "one" }]);
  expect(first).toEqual({ party: "one", number: "S-42", issued: "2026-09-08", due: "2026-09-10", amount: "1050.50", tax: "0.00" });
  const second = billFormFromProposal({ ...bill, partyName: unknown, number: unknown, issuedOn: unknown }, [{ name: "Example Studio", partyId: "one" }]);
  expect(second).toEqual({ party: "", number: "", issued: "", due: "", amount: "1050.50", tax: "" });
  expect(validateBillForm(second).ok).toBe(false);
  expect(billFormFromProposal(bill, [{ name: "Example Studio", partyId: "one" }, { name: "example studio", partyId: "two" }]).party).toBe("");
});
it("requires a real issue day and explicit tax, refuses invalid days, fractions and overflowing sums", () => {
  const form = billFormFromProposal(bill, [{ name: "Example Studio", partyId: "one" }]);
  expect(validateBillForm(form).ok).toBe(false);
  expect(validateBillForm({ ...form, tax: "0" })).toMatchObject({ ok: true, total: 105050 });
  for (const changed of [{ issued: "" }, { issued: "2026-02-31" }, { due: "2026-13-10" }, { amount: "12.345" }, { amount: "90071992547409.00", tax: "1.00" }])
    expect(validateBillForm({ ...form, tax: "0", ...changed }).ok).toBe(false);
  expect(whenOf("2026-09-08", "end")! - whenOf("2026-09-08")!).toBe(86_399_000);
  expect(whenOf("2026-02-31")).toBeNull();
});
