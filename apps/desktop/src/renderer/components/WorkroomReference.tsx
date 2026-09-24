/** Readable views of saved evidence. Presentation never changes the stored source or model packet. */
import {
  ENQUIRY_FIELDS, ENQUIRY_PROPOSAL_SEAT, ENQUIRY_REVIEW_SEAT,
  EnquiryProposalSchema, EnquiryReviewSnapshotSchema, type CaseTurnView
} from "@cadrane/contracts";
import { isCaseReference } from "../../shared/case-sources.js";

export function readEnquirySummary(turn: CaseTurnView, turns: readonly CaseTurnView[]) {
  if (turn.kind !== "verbatim" || turn.seat !== ENQUIRY_REVIEW_SEAT || turn.body.length > 12_000) return null;
  try {
    const parsed = EnquiryReviewSnapshotSchema.safeParse(JSON.parse(turn.body));
    if (!parsed.success) return null;
    const review = parsed.data;
    const source = turns.find(value => value.id === review.sourceId && isCaseReference(value));
    const proposalTurn = turns.find(value => value.id === review.proposalId &&
      value.kind === "finding" && value.seat === ENQUIRY_PROPOSAL_SEAT);
    if (!source || !proposalTurn) return null;
    const proposal = EnquiryProposalSchema.safeParse(JSON.parse(proposalTurn.body));
    if (!proposal.success || proposal.data.suggestion.scope !== "one_job" ||
        proposal.data.sourceTurnId !== source.id || proposal.data.sourceSha256 !== review.sourceSha256 ||
        review.fields.find(field => field.field === "item")?.quote === null ||
        review.fields.some(field => field.quote !== null && !source.body.includes(field.quote))) return null;
    return { ...review, sourceSeq: source.seq };
  } catch { return null; }
}

export function referencePreview(turn: CaseTurnView, turns: readonly CaseTurnView[]): string {
  const review = readEnquirySummary(turn, turns);
  if (!review) return turn.body.length > 300 ? `${turn.body.slice(0, 300)}…` : turn.body;
  const keys = ["item", "quantities", "artwork", "fulfilment"];
  const excerpts = keys.flatMap(key => {
    const quote = review.fields.find(field => field.field === key)?.quote;
    return quote ? [quote] : [];
  });
  const text = [...new Set(excerpts)].join(" · ");
  const missing = review.fields.filter(field => field.state === "unknown").length;
  return `${text.length > 260 ? `${text.slice(0, 260)}…` : text} · ${missing} unresolved field${missing === 1 ? "" : "s"}`;
}

export function WorkroomReference({ turn, turns }: {
  readonly turn: CaseTurnView; readonly turns: readonly CaseTurnView[];
}) {
  const review = readEnquirySummary(turn, turns);
  if (!review) return <p className="turn__body">{turn.body}</p>;
  return <section className="reference-brief" aria-label="Saved enquiry brief">
    <p className="reference-brief__intro">Your reviewed excerpts · original message {review.sourceSeq}.
      This records the enquiry, not a confirmed order.</p>
    <dl className="reference-brief__fields">
      {ENQUIRY_FIELDS.map(definition => {
        const field = review.fields.find(value => value.field === definition.id)!;
        return <div key={field.field}>
          <dt>{definition.label}</dt>
          <dd className={field.quote === null ? "reference-brief__unknown" : undefined}>
            {field.quote ?? (field.state === "not_needed_by_reviewer" ? "Not needed · your choice" : "Unknown · needs follow-up")}
          </dd>
        </div>;
      })}
    </dl>
    <p className="muted">Excerpts can contain options, changes or relative dates. Recheck the original before promising prices, dates or production.</p>
    <details className="reference-brief__record">
      <summary>View the complete saved source</summary>
      <p className="turn__body">{turn.body}</p>
    </details>
  </section>;
}

/** Receipt text is presentation evidence only. It never authorises or resumes
 * work, and an unmatched start must never be presented as a live model. */
export function savedAgentOutcome(turns: readonly CaseTurnView[]) {
  const receipts = turns.filter(turn => turn.kind === "receipt" && turn.seat === "agent run");
  const starts = receipts.flatMap(turn => {
    const match = /^Agent run ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) started on this Mac\.\n/u.exec(turn.body);
    return match ? [{ turn, id: match[1]! }] : [];
  }).sort((a, b) => b.turn.seq - a.turn.seq);
  const start = starts[0];
  if (!start) return null;
  const endings = receipts.filter(turn => turn.seq > start.turn.seq &&
    turn.body.startsWith(`Agent run ${start.id} finished — `));
  if (endings.length !== 1) return "unconfirmed";
  const outcome = endings[0]!.body.split("\n")[0]?.slice(`Agent run ${start.id} finished — `.length);
  return outcome === "answered." ? "answered" : outcome === "stopped." ? "stopped" :
    outcome === "failed." ? "failed" : outcome === "refused." ? "refused" : "unconfirmed";
}

export function WorkroomConversationGuide({ turns, hasAnswers, onSources, onActivity }: {
  readonly turns: readonly CaseTurnView[]; readonly hasAnswers: boolean;
  readonly onSources: () => void; readonly onActivity: () => void;
}) {
  const agentOutcome = savedAgentOutcome(turns);
  if (agentOutcome && agentOutcome !== "answered") return <div className="conversation-empty">
    <h2>{agentOutcome === "stopped" ? "This agent run was stopped." :
      agentOutcome === "failed" ? "This agent run did not finish." :
      agentOutcome === "refused" ? "This agent run was refused." : "No completion is recorded for this agent run."}</h2>
    <p>{agentOutcome === "unconfirmed"
      ? "Check the Agents page for an active run. If it was interrupted, reopening this workroom does not restart it."
      : "Activity keeps the outcome and any completed reads. Reopening this workroom does not restart the agent."}</p>
    <button type="button" className="link" onClick={onActivity}>View the run record →</button>
  </div>;
  const latest = [...turns].reverse().find(turn => turn.kind === "finding" && turn.seat === ENQUIRY_PROPOSAL_SEAT);
  if (latest) {
    const reviewed = turns.some(turn => readEnquirySummary(turn, turns)?.proposalId === latest.id);
    return <div className="enquiry-ready"><p>{reviewed ? "Your reviewed enquiry brief is ready." : "Enquiry details are ready for your review."}</p>
      <button type="button" className="link" onClick={onSources}>
        {reviewed ? "View your reviewed brief →" : "Review fields and original message →"}
      </button></div>;
  }
  if (hasAnswers) return null;
  const references = turns.filter(isCaseReference).length;
  return <div className="conversation-empty">
    <h2>{references > 1 ? "Your sources are ready." : references === 1 ? "Start with your brief." : "Start with what you know."}</h2>
    <p>{references ? "Choose the sources below and say what you want to make, understand or improve. Your answer will appear here."
      : "Add reference notes in Sources, then choose what the model can use."}</p>
    <button type="button" className="link" onClick={onSources}>{references ? "Review sources →" : "Add sources →"}</button>
  </div>;
}
