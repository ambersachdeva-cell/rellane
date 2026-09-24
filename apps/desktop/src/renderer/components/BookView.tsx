import { useRef, useState } from "react";
import type { BookStanding, DesktopBridge } from "@cadrane/contracts";
import { parseRupees, rupees } from "../../main/book/money.js";
import { Button } from "./ui";
import { BillReader } from "./BillReader.js";
import { billFormFromProposal, validateBillForm, whenOf, type BillForm } from "../bill-form.js";
export { whenOf } from "../bill-form.js";

/** Today, as the date input wants it. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

export function BookView({
  standing,
  busy,
  onAddParty,
  onAddInvoice,
  onAddPayment,
  api,
  initialText = ""
}: {
  readonly standing: BookStanding | null;
  readonly busy: boolean;
  readonly onAddParty: (input: { name: string; phone: string | null; gstin: string | null }) => void;
  readonly onAddInvoice: (input: {
    partyId: string;
    number: string | null;
    issuedOn: number;
    dueOn: number | null;
    subtotalPaise: number;
    taxPaise: number;
    totalPaise: number;
  }) => Promise<boolean>;
  readonly onAddPayment: (input: {
    partyId: string;
    receivedOn: number;
    amountPaise: number;
    method: "cash" | "upi" | "bank" | "cheque" | "other";
  }) => void;
  readonly api: DesktopBridge | undefined;
  readonly initialText?: string;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");

  const [billForm, setBillForm] = useState<BillForm>({ party: "", number: "", issued: today(), due: "", amount: "", tax: "" });
  const [billMessage, setBillMessage] = useState<string | null>(null);
  const [savingBill, setSavingBill] = useState(false);
  const saving = useRef(false);
  const billHeading = useRef<HTMLHeadingElement>(null);
  const { party: billParty, number: billNumber, issued: billIssued, due: billDue, amount: billAmount, tax: billTax } = billForm;
  const editBill = (field: keyof BillForm, value: string) => setBillForm(current => ({ ...current, [field]: value }));

  const [payParty, setPayParty] = useState("");
  const [payWhen, setPayWhen] = useState(today());
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"cash" | "upi" | "bank" | "cheque" | "other">("upi");

  // Everyone can be billed; only those who owe can sensibly be paying.
  const everyone = standing?.parties ?? [];
  const parties = standing?.owing ?? [];

  const { subtotal, tax, total, issued, due, ok } = validateBillForm(billForm);
  const billOk = ok && everyone.some(party => party.partyId === billParty);
  const paid = parseRupees(payAmount);

  return (
    <div className="book">
      {standing === null ? (
        <p className="ag__loading">Opening the book.</p>
      ) : standing.counts.invoices === 0 ? (
        <p className="book__empty">
          Nothing in the book yet. Add a customer, then a bill, and the standing appears here and
          on Home.
        </p>
      ) : (
        <section className="book__standing">
          <p className="owed__total">
            <span className="owed__amount">{rupees(standing.totalOwedPaise)}</span>
            <span className="owed__what">outstanding</span>
          </p>
          <ul className="owed__list">
            {standing.owing.map((party) => (
              <li key={party.partyId} className="owed__row">
                <span className="owed__name">{party.name}</span>
                <span className="owed__bills">
                  {party.openBills} · billed {rupees(party.billedPaise)} · paid{" "}
                  {rupees(party.paidPaise)}
                </span>
                <span className="owed__figure">{rupees(party.owedPaise)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <BillReader api={api} initialText={initialText} disabled={busy || savingBill} onApply={proposal => {
        setBillForm(billFormFromProposal(proposal, everyone));
        setBillMessage("Applied for review. Choose the customer and fill any unknowns. Check the stated total above before recording.");
        billHeading.current?.focus();
      }} />
      <div className="book__forms">
        <section className="bform">
          <h2 className="bform__title">Add a customer</h2>
          <input
            className="input"
            value={name}
            placeholder="Devgiri Traders"
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="input"
            value={phone}
            placeholder="Phone, with the country code"
            aria-label="Phone number, with the country code"
            maxLength={32}
            onChange={(event) => setPhone(event.target.value)}
          />
          <input
            className="input"
            value={gstin}
            placeholder="GSTIN, if they have one"
            aria-label="GSTIN, if they have one"
            maxLength={15}
            onChange={(event) => setGstin(event.target.value)}
          />
          <Button
            tone="primary"
            disabled={busy || name.trim().length === 0}
            onClick={() => {
              onAddParty({
                name: name.trim(),
                phone: phone.trim() || null,
                gstin: gstin.trim().toUpperCase() || null
              });
              setName("");
              setPhone("");
              setGstin("");
            }}
          >
            Add
          </Button>
          {/* The state code decides CGST+SGST against IGST, and it is the first
              two characters of the GSTIN. Shown while typing so a wrong one is
              obvious before it is saved. */}
          {gstin.trim().length >= 2 ? (
            <p className="bform__hint">State code {gstin.trim().slice(0, 2)}</p>
          ) : null}
        </section>

        <section className="bform" aria-label="Bill form">
          <h2 className="bform__title" ref={billHeading} tabIndex={-1}>Record a checked bill</h2>
          <p className="bform__hint">Reading and applying store nothing. Record only after checking the original.</p>
          {billMessage ? <p className="bform__hint" role="status">{billMessage}</p> : null}
          <select
            className="select"
            aria-label="Bill customer" disabled={busy || savingBill} value={billParty}
            onChange={(event) => editBill("party", event.target.value)}
          >
            <option value="">Which customer…</option>
            {everyone.map((party) => (
              <option key={party.partyId} value={party.partyId}>
                {party.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            disabled={busy || savingBill} value={billNumber}
            placeholder="Bill number, as written on it"
            aria-label="Bill number, as written on it"
            maxLength={64}
            onChange={(event) => editBill("number", event.target.value)}
          />
          <label className="bform__field">
            <span className="bform__label">Issued</span>
            <input
              className="input"
              type="date"
              disabled={busy || savingBill} value={billIssued}
              onChange={(event) => editBill("issued", event.target.value)}
            />
          </label>
          <label className="bform__field">
            <span className="bform__label">Due, if agreed</span>
            <input
              className="input"
              type="date"
              disabled={busy || savingBill} value={billDue}
              onChange={(event) => editBill("due", event.target.value)}
            />
          </label>
          <input
            className="input"
            disabled={busy || savingBill} value={billAmount}
            placeholder="Amount before tax, in rupees"
            aria-label="Amount before tax, in rupees"
            onChange={(event) => editBill("amount", event.target.value)}
          />
          <input
            className="input"
            disabled={busy || savingBill} value={billTax}
            placeholder="Tax amount in rupees — enter 0 if none"
            aria-label="GST, in rupees"
            onChange={(event) => editBill("tax", event.target.value)}
          />
          {total !== null ? (
            <p className="bform__total">Calculated total {rupees(total, { paise: true })}</p>
          ) : (
            <p className="bform__hint">Enter both the amount before tax and the tax amount. Use 0 only when you have checked that no tax is due. Amounts need at most two decimal places and a safely representable total.</p>
          )}
          {issued === null ? <p className="bform__hint">An issue date is required; an unknown date does not become today.</p> : null}
          {billDue && due === null ? <p className="bform__warn">Enter a real due date or leave it empty.</p> : null}
          <Button tone="primary" disabled={busy || savingBill || !billOk} onClick={() => {
            if (saving.current || !billOk || subtotal === null || tax === null || total === null || issued === null) return;
            saving.current = true; setSavingBill(true); setBillMessage(null);
            void onAddInvoice({ partyId: billParty, number: billNumber.trim() || null,
              issuedOn: issued, dueOn: due, subtotalPaise: subtotal, taxPaise: tax, totalPaise: total })
              .then(saved => {
                if (!saved) { setBillMessage("Saving could not be confirmed. Your checked fields are still here. Check the book before recording again."); return; }
                setBillForm({ party: "", number: "", issued: "", due: "", amount: "", tax: "" });
                setBillMessage("Bill recorded.");
              })
              .catch(() => setBillMessage("Saving could not be confirmed. Your checked fields are still here. Check the book before recording again."))
              .finally(() => { saving.current = false; setSavingBill(false); });
          }}>{savingBill ? "Recording…" : "Record this bill"}</Button>
        </section>

        <section className="bform">
          <h2 className="bform__title">Money received</h2>
          <select
            className="select"
            value={payParty}
            onChange={(event) => setPayParty(event.target.value)}
          >
            <option value="">Who paid…</option>
            {parties.map((party) => (
              <option key={party.partyId} value={party.partyId}>
                {party.name} — {rupees(party.owedPaise)} outstanding
              </option>
            ))}
          </select>
          <label className="bform__field">
            <span className="bform__label">Received</span>
            <input
              className="input"
              type="date"
              value={payWhen}
              onChange={(event) => setPayWhen(event.target.value)}
            />
          </label>
          <input
            className="input"
            value={payAmount}
            placeholder="Amount, in rupees"
            aria-label="Amount, in rupees"
            onChange={(event) => setPayAmount(event.target.value)}
          />
          <select
            className="select"
            value={payMethod}
            onChange={(event) =>
              setPayMethod(event.target.value as "cash" | "upi" | "bank" | "cheque" | "other")
            }
          >
            <option value="upi">UPI</option>
            <option value="cash">Cash</option>
            <option value="bank">Bank transfer</option>
            <option value="cheque">Cheque</option>
            <option value="other">Something else</option>
          </select>
          <Button
            tone="primary"
            disabled={busy || paid === null || payParty.length === 0}
            onClick={() => {
              const when = whenOf(payWhen);
              if (paid === null || when === null) {
                return;
              }
              onAddPayment({
                partyId: payParty,
                receivedOn: when,
                amountPaise: paid,
                method: payMethod
              });
              setPayAmount("");
            }}
          >
            Record it
          </Button>
          {/* Money that settles nothing in particular is a real state here, not
              an error — so no allocation is demanded at entry. */}
          <p className="bform__hint">
            It counts against their balance straight away, whether or not you say which bill.
          </p>
        </section>
      </div>
    </div>
  );
}
