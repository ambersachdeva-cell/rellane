/** A readable view of the exact packet; the original remains available below it. */
interface PacketSource { id: string; label: string; text: string; truncated: boolean }
interface Packet { request: string; sources: PacketSource[]; omitted: { label: string; reason: string }[] }

function packetView(raw: string): Packet | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const packet = value as Record<string, unknown>;
    if (packet.version !== "1" || typeof packet.request !== "string" || !Array.isArray(packet.sources) || !Array.isArray(packet.omitted)) return null;
    if (!packet.sources.every(source => source && typeof source === "object" && typeof source.id === "string" && typeof source.label === "string" && typeof source.text === "string" && typeof source.truncated === "boolean")) return null;
    if (!packet.omitted.every(source => source && typeof source === "object" && typeof source.label === "string" && typeof source.reason === "string")) return null;
    return packet as unknown as Packet;
  } catch { return null; }
}

export function ReviewPacket({ raw }: { raw: string }) {
  const packet = packetView(raw);
  if (!packet) return <pre className="ws-source-preview ws-review-packet">{raw}</pre>;
  return <>
    <section className="ws-request-review" aria-label="Request being sent">
      <h3>Your request</h3><p>{packet.request}</p>
      {packet.sources.length ? <div className="ws-review-sources"><h3>Context being shared</h3>{packet.sources.map(source => <details key={source.id} open={packet.sources.length === 1}>
        <summary><strong>{source.label.replace(/^Source \d+ · (?:Source · )?/u, "")}</strong><span>{source.truncated ? "Selected excerpt" : "Full selected text"} · {source.text.length.toLocaleString()} characters</span></summary>
        <pre>{source.text}</pre>
      </details>)}</div> : <p className="ws-review-no-sources">No files or earlier answers are attached to this request.</p>}
      {packet.omitted.length ? <div className="ws-review-omissions"><strong>Not included in this request</strong>{packet.omitted.map((source, index) => <p key={index}>{source.label}: {source.reason}</p>)}</div> : null}
    </section>
    <details className="ws-review-integrity"><summary>View the exact packet</summary><pre className="ws-source-preview">{raw}</pre></details>
  </>;
}
