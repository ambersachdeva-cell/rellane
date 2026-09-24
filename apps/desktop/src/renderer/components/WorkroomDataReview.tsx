/** A checked figure and its records should be easier to inspect than a prompt.
 * This view sends typed choices; calculations and source resolution stay in main. */
import { useEffect, useRef, useState } from "react";
import type { CaseDataQuery, CaseDataReview, CaseRoom } from "@cadrane/contracts";
import { CASE_DATA_SEAT_PREFIX, isCaseDataSource } from "../../shared/case-sources.js";
import { workroomMessage } from "../workroom-message.js";

export interface PreparedDataRequest {
  readonly sourceTurnId: string;
  readonly question: string;
}

export function WorkroomDataReview({ room, onUpdate, onPrepared, localRunning }: {
  readonly room: CaseRoom;
  readonly onUpdate: (room: CaseRoom) => void;
  readonly onPrepared: (request: PreparedDataRequest) => void;
  readonly localRunning: boolean;
}) {
  const data = room.turns.filter(isCaseDataSource);
  const caseId = room.case!.id;
  const [chosen, setChosen] = useState("");
  const sourceId = data.some(source => source.id === chosen) ? chosen : data[0]?.id ?? "";
  const [info, setInfo] = useState<CaseDataReview | null>(null);
  const [checked, setChecked] = useState<{ query: CaseDataQuery; result: CaseDataReview } | null>(null);
  const [operation, setOperation] = useState<"count" | "total">("count");
  const [valueColumn, setValueColumn] = useState("");
  const [groupColumn, setGroupColumn] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [unit, setUnit] = useState<"number" | "INR">("number");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [intro, setIntro] = useState(true);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setInfo(null); setChecked(null);
    setOperation("count"); setValueColumn(""); setGroupColumn("");
    setFilterColumn(""); setFilterValue(""); setUnit("number");
    if (!sourceId) return;
    let abandoned = false;
    setBusy(true);
    const query: CaseDataQuery = { id: caseId, sourceTurnId: sourceId, operation: "count", valueColumn: null, groupColumn: null, unit: "number", filter: null };
    void window.cadrane.cases.reviewData(query).then(result => {
      if (!abandoned) { setInfo(result); setChecked({ query, result }); }
    }).catch(error => {
      if (!abandoned) setMessage(workroomMessage(error, "This data could not be opened."));
    }).finally(() => { if (!abandoned) setBusy(false); });
    return () => { abandoned = true; };
  }, [caseId, sourceId]);

  function changed(update: () => void) { update(); setChecked(null); setMessage(""); }
  async function sample() {
    setBusy(true); setMessage("");
    try {
      const next = await window.cadrane.cases.addDataSample({ id: caseId });
      if (!mounted.current) return;
      const last = next.turns.filter(isCaseDataSource).at(-1);
      if (last) setChosen(last.id);
      onUpdate(next);
      setMessage("Fictional print orders added. Try a total of Outstanding INR, grouped by Customer, with Status equal to Awaiting payment.");
    } catch (error) {
      if (mounted.current) setMessage(workroomMessage(error, "The sample could not be added."));
    } finally { if (mounted.current) setBusy(false); }
  }
  async function calculate() {
    const query: CaseDataQuery = {
      id: caseId, sourceTurnId: sourceId, operation,
      valueColumn: valueColumn === "" ? null : Number(valueColumn),
      groupColumn: groupColumn === "" ? null : Number(groupColumn), unit,
      filter: filterColumn === "" ? null : { column: Number(filterColumn), equals: filterValue }
    };
    setBusy(true); setChecked(null); setMessage("");
    try {
      const result = await window.cadrane.cases.reviewData(query);
      if (mounted.current) setChecked({ query, result });
    } catch (error) {
      if (mounted.current) setMessage(workroomMessage(error, "This calculation could not be completed."));
    } finally { if (mounted.current) setBusy(false); }
  }
  async function prepare() {
    if (!checked) return;
    setBusy(true); setMessage("");
    try {
      const saved = await window.cadrane.cases.saveDataReview({ query: checked.query, operationId: crypto.randomUUID() });
      if (!mounted.current) return;
      onUpdate(saved.room);
      onPrepared({ sourceTurnId: saved.sourceTurnId, question: "Explain this checked data result in plain language, in at most 150 words. Preserve its exact figures and source reference. State the snapshot and missing-value limits. Suggest up to three practical next checks without inventing causes, commitments or customer facts." });
    } catch (error) {
      if (mounted.current) setMessage(workroomMessage(error, "The checked result could not be saved."));
    } finally { if (mounted.current) setBusy(false); }
  }
  const options = info?.columns.map((column, index) => <option key={index} value={index}>{column}</option>);
  const result = checked?.result;
  const displayValue = (value: string | null) => value === null ? "—" : `${checked?.query.unit === "INR" ? "₹" : ""}${value}`;
  return <section className="data-review" aria-labelledby="data-review-heading">
    <div className="data-review__head"><div><span className="eyebrow">DATA REVIEW</span><h3 id="data-review-heading">Make sense of your records</h3></div><button className="link" type="button" onClick={() => setIntro(value => !value)}>{intro ? "Hide guide" : "How it works"}</button></div>
    {intro && <div className="data-review__guide"><p>Count enquiries, compare orders or total a column. Check the figures and their rows before asking AI what they mean.</p><ol><li>Add a CSV export using <strong>Add a file</strong> above.</li><li>Choose the figures and records to include.</li><li>Save the checked result and use it in a local AI request.</li></ol><p className="muted">Works with a saved snapshot. Your spreadsheet or database stays unchanged.</p></div>}
    {!data.length ? <div className="data-review__empty"><p>Start with your own export, or try six fictional print orders.</p><button className="btn" type="button" disabled={busy} onClick={() => void sample()}>{busy ? "Adding sample…" : "Try sample data"}</button></div> : <>
      <label className="data-review__source">CSV to review<select className="input" value={sourceId} disabled={busy} onChange={event => setChosen(event.target.value)}>{data.map(source => <option key={source.id} value={source.id}>{source.seat.slice(CASE_DATA_SEAT_PREFIX.length)}</option>)}</select></label>
      {info && <><p className="muted">{info.sourceRows.toLocaleString()} data rows · {info.columns.length} columns · snapshot saved in this workroom</p>
        <fieldset disabled={busy} className="data-review__choices"><legend className="sr-only">Choose a data calculation</legend>
          <label>Find<select className="input" value={operation} onChange={event => changed(() => setOperation(event.target.value as "count" | "total"))}><option value="count">Number of records</option><option value="total">Total of a column</option></select></label>
          {operation === "total" && <><label>Column to total<select className="input" value={valueColumn} onChange={event => changed(() => setValueColumn(event.target.value))}><option value="">Choose a column</option>{options}</select></label><label>Values are<select className="input" value={unit} onChange={event => changed(() => setUnit(event.target.value as "number" | "INR"))}><option value="number">Numbers</option><option value="INR">Indian rupees (₹)</option></select></label></>}
          <label>Break down by<select className="input" value={groupColumn} onChange={event => changed(() => setGroupColumn(event.target.value))}><option value="">One combined result</option>{options}</select></label>
          <label>Include records where<select className="input" value={filterColumn} onChange={event => changed(() => setFilterColumn(event.target.value))}><option value="">All records</option>{options}</select></label>
          {filterColumn !== "" && <label>Equals exactly<input className="input" list={`data-values-${caseId}`} value={filterValue} maxLength={2_000} onChange={event => changed(() => setFilterValue(event.target.value))} placeholder="Choose or type a value"/><datalist id={`data-values-${caseId}`}>{[...new Set(info.previewRows.map(row => row.cells[Number(filterColumn)]?.trim() ?? ""))].map(value => <option key={value} value={value} />)}</datalist><span className="muted">Case-sensitive. An empty value selects blank cells.</span></label>}
        </fieldset><button className="btn" type="button" disabled={busy || (operation === "total" && valueColumn === "")} onClick={() => void calculate()}>{busy ? "Checking…" : "Check figures"}</button></>}
      {result && checked && <div className="data-review__result" aria-live="polite">
        <div className="data-review__figure"><span>{checked.query.operation === "total" ? `Total · ${result.columns[checked.query.valueColumn!]}` : "Matching records"}</span><strong>{checked.query.operation === "total" ? displayValue(result.total) : result.matchedRows.toLocaleString()}</strong><span>{result.matchedRows} of {result.sourceRows} source rows match</span></div>
        {result.blankValues > 0 && <p className="data-review__warning">{result.blankValues} matching {result.blankValues === 1 ? "row has" : "rows have"} no amount. The total covers known values only.</p>}
        {result.matchedRows === 0 && <p>No records match this exact filter. Check the column and spelling before drawing a conclusion.</p>}
        {checked.query.groupColumn !== null && <div className="data-review__table-wrap"><table><caption>Breakdown by {result.columns[checked.query.groupColumn]}</caption><thead><tr><th scope="col">Group</th><th scope="col">Records</th>{checked.query.operation === "total" && <th scope="col">Total</th>}<th scope="col">Data rows</th></tr></thead><tbody>{result.groups.map(group => <tr key={group.label}><th scope="row">{group.label || "(blank)"}</th><td>{group.count}</td>{checked.query.operation === "total" && <td>{displayValue(group.total)}</td>}<td>{group.rowNumbers.slice(0, 12).join(", ")}{group.rowNumbers.length > 12 ? ` + ${group.rowNumbers.length - 12} more` : ""}</td></tr>)}</tbody></table></div>}
        <details><summary>Inspect contributing records</summary><div className="data-review__table-wrap"><table><caption>First {result.previewRows.length} of {result.matchedRows} matching records. Row numbers exclude the header.</caption><thead><tr><th scope="col">Row</th>{result.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{result.previewRows.map(row => <tr key={row.row}><th scope="row">{row.row}</th>{row.cells.map((cell, index) => <td key={index}>{cell || <span className="muted">(blank)</span>}</td>)}</tr>)}</tbody></table></div></details>
        <p className="muted">Calculated from the CSV. These figures do not reconcile payments or verify the original records.</p>
        <button className="btn btn--primary" type="button" disabled={busy || localRunning} onClick={() => void prepare()}>Use checked result with AI →</button><p className="muted">Saves the calculation as evidence and prepares a request. You review it before asking the local model.</p>
      </div>}
    </>}
    {message && <p role="status" className="source-preview__status">{message}</p>}
  </section>;
}
