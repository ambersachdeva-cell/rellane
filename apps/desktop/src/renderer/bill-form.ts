import type { BillRead } from "@cadrane/contracts";
import { ledgerInteger, parseRupees } from "../main/book/money.js";

export interface BillForm {
  party: string; number: string; issued: string; due: string; amount: string; tax: string;
}

export function whenOf(value: string, edge: "start" | "end" = "start"): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1900 || year > 2200) return null;
  const date = new Date(`${value}T${edge === "start" ? "00:00:00" : "23:59:59"}`);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return null;
  return date.getTime();
}

function moneyInput(paise: number | null): string {
  if (paise === null || ledgerInteger(paise) === null) return "";
  const amount = Math.abs(paise);
  return `${paise < 0 ? "-" : ""}${Math.trunc(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

/** Replacement is explicit and complete: no unsupported value leaks from the previous bill. */
export function billFormFromProposal(bill: NonNullable<BillRead["bill"]>, parties: readonly { name: string; partyId: string }[]): BillForm {
  const name = bill.partyName.value?.trim().toLocaleLowerCase();
  const matches = name ? parties.filter(p => p.name.trim().toLocaleLowerCase() === name) : [];
  return { party: matches.length === 1 ? matches[0]!.partyId : "", number: bill.number.value ?? "",
    issued: bill.issuedOn.value ?? "", due: bill.dueOn.value ?? "",
    amount: moneyInput(bill.subtotalPaise.value), tax: moneyInput(bill.taxPaise.value) };
}

export function validateBillForm(form: BillForm) {
  const subtotal = parseRupees(form.amount), tax = parseRupees(form.tax);
  const total = subtotal === null || tax === null ? null : ledgerInteger(subtotal + tax);
  const issued = whenOf(form.issued), due = whenOf(form.due, "end");
  return { subtotal, tax, total, issued, due,
    ok: !!form.party && form.number.length <= 64 && total !== null && issued !== null && (!form.due || due !== null) };
}
