/**
 * Two places, and Today is first.
 *
 * The rail used to carry five groups over thirteen destinations, which asked a
 * visitor to assemble the workflow in their head before the product did
 * anything for them. THE-PRODUCT §2.2 already ruled on this: Today is why you
 * opened the app, and a Deal is how you act on a line in Today. Everything
 * else is a view inside a Deal or a drawer — the code stays, the rail place
 * does not.
 *
 * Retired destinations keep their route so the command palette still reaches
 * them and nothing is orphaned; they simply stop competing for the eye of
 * someone who opened the app to get work done.
 *
 * Business records is not among them. Billing was cut on 12 September — Rellane
 * is not accounting software and Tally keeps the books — so the Book is not a
 * place a person can navigate to at all. The code and the schema remain: these
 * migrations are append-only, and dropping an owner's tables to tidy a menu
 * would destroy history to win an argument about scope.
 */
import type { Place } from "../navigation.js";

const RAIL: readonly { id: Place; label: string; icon: string }[] = [
  {
    id: "today",
    label: "Today",
    icon: "M12 3 3 8v7l9 6 9-6V8Z M12 8v5 M12 16h.01"
  },
  {
    // "Deals" is Salesforce's word. This product's own six steps are written in
    // the shop's nouns — an enquiry arrives, a quotation is drafted — and a rail
    // that says a third thing is two vocabularies for one idea, which is how a
    // codebase ends up with a Case, a Deal and an Enquiry meaning the same job.
    id: "deals",
    label: "Enquiries",
    icon: "M3 5h6l2 2h10v12H3Z M8 12h8 M8 15h5"
  }
];

/**
 * Reachable, not advertised. Each of these is either a view inside a Deal or a
 * drawer in Workspace settings; the palette keeps them addressable so no
 * existing screen becomes unreachable while the rail stays at two.
 */
const RETIRED: readonly { id: Place; label: string }[] = [
  { id: "cases", label: "Workrooms" },
  { id: "desk", label: "Quick ask" },
  { id: "memory", label: "Knowledge & privacy" },
  { id: "timeline", label: "File history" },
  { id: "agents", label: "Agent library" },
  { id: "settings", label: "Workspace settings" },
  { id: "models", label: "Local models" },
  { id: "engines", label: "AI connections" },
  { id: "connectors", label: "Connectors" }
];

/** Search uses the same route names as the sidebar. */
export const PRODUCT_ROUTES = [
  ...RAIL.map((place) => ({ id: place.id, label: place.label })),
  ...RETIRED
];

export function ProductNavigation({
  place,
  onGo
}: {
  readonly place: Place;
  readonly onGo: (place: Place) => void;
}) {
  return (
    <div className="side__group product-nav">
      {RAIL.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`place${place === entry.id ? " place--on" : ""}`}
          aria-current={place === entry.id ? "page" : undefined}
          onClick={() => onGo(entry.id)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={entry.icon} />
          </svg>
          {entry.label}
        </button>
      ))}
    </div>
  );
}
