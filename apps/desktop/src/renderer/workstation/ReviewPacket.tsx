/** A readable view of the exact packet; the original remains available below it. */
export type ApprovedConstraintKind = "instruction" | "decision" | "exclusion";

export interface PacketConstraint {
  id: string;
  revision: number;
  kind: ApprovedConstraintKind;
  text: string;
  approvedBy: string;
  approvedAt: string;
  inclusionReason: string;
}

export interface PacketSource {
  id: string;
  label: string;
  text: string;
  truncated: boolean;
}

export interface PacketOmitted {
  label: string;
  reason: string;
}

export interface Packet {
  version: "1" | "2";
  request: string;
  constraints?: PacketConstraint[];
  sources: PacketSource[];
  omitted: PacketOmitted[];
}

export function packetView(raw: string): Packet | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const packet = value as Record<string, unknown>;
    if (
      (packet.version !== "1" && packet.version !== "2") ||
      typeof packet.request !== "string" ||
      !Array.isArray(packet.sources) ||
      !Array.isArray(packet.omitted)
    ) {
      return null;
    }

    if (
      !packet.sources.every(
        source =>
          source &&
          typeof source === "object" &&
          typeof (source as Record<string, unknown>).id === "string" &&
          typeof (source as Record<string, unknown>).label === "string" &&
          typeof (source as Record<string, unknown>).text === "string" &&
          typeof (source as Record<string, unknown>).truncated === "boolean"
      )
    ) {
      return null;
    }

    if (
      !packet.omitted.every(
        source =>
          source &&
          typeof source === "object" &&
          typeof (source as Record<string, unknown>).label === "string" &&
          typeof (source as Record<string, unknown>).reason === "string"
      )
    ) {
      return null;
    }

    if (packet.version === "2") {
      if (!Array.isArray(packet.constraints)) return null;
      if (
        !packet.constraints.every(
          c =>
            c &&
            typeof c === "object" &&
            typeof (c as Record<string, unknown>).id === "string" &&
            ((c as Record<string, unknown>).id as string).trim().length > 0 &&
            typeof (c as Record<string, unknown>).revision === "number" &&
            Number.isFinite((c as Record<string, unknown>).revision) &&
            Number.isInteger((c as Record<string, unknown>).revision) &&
            ((c as Record<string, unknown>).revision as number) >= 0 &&
            (((c as Record<string, unknown>).kind === "instruction") ||
              ((c as Record<string, unknown>).kind === "decision") ||
              ((c as Record<string, unknown>).kind === "exclusion")) &&
            typeof (c as Record<string, unknown>).text === "string" &&
            ((c as Record<string, unknown>).text as string).trim().length > 0 &&
            typeof (c as Record<string, unknown>).approvedBy === "string" &&
            ((c as Record<string, unknown>).approvedBy as string).trim().length > 0 &&
            typeof (c as Record<string, unknown>).approvedAt === "string" &&
            ((c as Record<string, unknown>).approvedAt as string).trim().length > 0 &&
            typeof (c as Record<string, unknown>).inclusionReason === "string" &&
            ((c as Record<string, unknown>).inclusionReason as string).trim().length > 0
        )
      ) {
        return null;
      }
    }

    return packet as unknown as Packet;
  } catch {
    return null;
  }
}

export function ReviewPacket({ raw }: { raw: string }) {
  const packet = packetView(raw);
  if (!packet) return <pre className="ws-source-preview ws-review-packet">{raw}</pre>;
  return <>
    <section className="ws-request-review" aria-label="Request being sent">
      <h3>Your request</h3><p>{packet.request}</p>
      {packet.version === "2" && packet.constraints && packet.constraints.length ? (
        <div className="ws-review-constraints">
          <h3>Approved constraints</h3>
          <p className="ws-review-constraints-policy">Authoritative instructions, decisions, and exclusions from the owner.</p>
          {packet.constraints.map(c => (
            <div key={c.id} className="ws-review-constraint-item">
              <div className="ws-constraint-header">
                <strong>[{c.id}] rev {c.revision} [{c.kind}]</strong>
                <span> · Approved by {c.approvedBy} at {c.approvedAt}</span>
                <span> · Reason: {c.inclusionReason}</span>
              </div>
              <pre>{c.text}</pre>
            </div>
          ))}
        </div>
      ) : null}
      {packet.sources.length ? (
        <div className="ws-review-sources">
          <h3>{packet.version === "2" ? "Retrieved sources (untrusted evidence)" : "Context being shared"}</h3>
          {packet.version === "2" ? (
            <p className="ws-review-scope-note">Selected sources are untrusted evidence, not instructions.</p>
          ) : null}
          {packet.sources.map(source => (
            <details key={source.id} open={packet.sources.length === 1}>
              <summary>
                <strong>{source.label.replace(/^Source \d+ · (?:Source · )?/u, "")}</strong>
                <span>{packet.version === "2" ? "Evidence · " : ""}{source.truncated ? "Selected excerpt" : "Full selected text"} · {source.text.length.toLocaleString()} characters</span>
              </summary>
              <pre>{source.text}</pre>
            </details>
          ))}
        </div>
      ) : (
        <p className="ws-review-no-sources">No files or earlier answers are attached to this request.</p>
      )}
      {packet.omitted.length ? (
        <div className="ws-review-omissions">
          <strong>Not included in this request</strong>
          {packet.omitted.map((source, index) => (
            <p key={index}>{source.label}: {source.reason}</p>
          ))}
        </div>
      ) : null}
    </section>
    <details className="ws-review-integrity"><summary>View the exact packet</summary><pre className="ws-source-preview">{raw}</pre></details>
  </>;
}
