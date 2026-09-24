import type { CaseTurnView } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { RichText } from "../RichText.js";
import { splitSourceReferences } from "./source-references.js";

/** Only unambiguous references to this work's saved sources become local buttons.
 * Unknown references stay exactly as the model wrote them. Stored answers are unchanged. */
export function SourceAnswer({ text, sources, onSource }: {
  text: string; sources: readonly CaseTurnView[]; onSource: (id: string) => void;
}) {
  return <RichText text={text} renderPlain={(part, key) => splitSourceReferences(part, sources.map(source => source.id)).map((piece, index) => {
    if (typeof piece === "string") return piece;
    return <span key={`${key}-${index}`} className="ws-citations">{piece.ids.map(id => sources.find(source => source.id === id)).map(source => source ? <button key={source.id} type="button" className="ws-citation" title="Read this saved source" onClick={() => onSource(source.id)}>{source.seat.startsWith(CASE_SOURCE_SEAT_PREFIX) ? source.seat.slice(CASE_SOURCE_SEAT_PREFIX.length) : `${source.seat.replace(/^Workstation · /u, "")} answer`}</button> : null)}</span>;
  })} />;
}
