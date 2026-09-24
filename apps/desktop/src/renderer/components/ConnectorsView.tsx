/**
 * Connectors — other people's software, doing the parts we did not build.
 *
 * The screen has one job that is harder than it looks: make an approval decision
 * possible. A person cannot judge "may this tool run" from a tool name, so the
 * thing this shows most prominently is **the description the connector wrote**,
 * which is the only evidence there is.
 *
 * Three states are kept visually distinct because they need different reactions:
 *
 *   - **Not approved** — you have not looked at this yet.
 *   - **Changed since you approved it** — a connector altered something you had
 *     already agreed to. This is the one that gets colour, because it is the one
 *     that means somebody may be trying something (D-027: colour marks the
 *     exception).
 *   - **Reads only, it says** — the connector's claim, phrased as a claim. Never
 *     "safe", never a tick. A server can assert `readOnlyHint` on a tool called
 *     `delete_everything`, and the wording has to survive that.
 */

import type { ConnectorsSnapshot, ConnectorToolView } from "@cadrane/contracts";
import { Button, Chip } from "./ui";

export function ConnectorsView({
  snapshot,
  busy,
  onInstall,
  onRemove,
  onApprove
}: {
  readonly snapshot: ConnectorsSnapshot | null;
  readonly busy: boolean;
  readonly onInstall: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onApprove: (tool: ConnectorToolView, approved: boolean) => void;
}) {
  if (snapshot === null) {
    return <p className="ag__loading">Looking for connectors.</p>;
  }

  return (
    <div className="conn">
      {snapshot.installed.length === 0 ? (
        <p className="conn__empty">
          Nothing installed. A connector is somebody else&rsquo;s program that gives Rellane a
          new ability — reading a database, fetching a page — without us writing it.
        </p>
      ) : (
        <ul className="conn__list">
          {snapshot.installed.map((connector) => (
            <li key={connector.id} className="conn__row">
              <div className="conn__head">
                <span className="conn__name">{connector.label}</span>
                <code className="conn__cmd">{connector.command}</code>
                <span className="conn__spacer" />
                <Button onClick={() => onRemove(connector.id)}>Remove</Button>
              </div>

              {connector.problem === null ? null : (
                <p className="conn__problem">{connector.problem}</p>
              )}

              {connector.tools === null || connector.tools.length === 0 ? null : (
                <ul className="conn__tools">
                  {connector.tools.map((tool) => (
                    <li key={tool.name} className="ctool">
                      <div className="ctool__head">
                        <span className="ctool__name">{tool.name}</span>
                        {tool.claimsReadOnly ? (
                          <Chip tone="muted">reads only, it says</Chip>
                        ) : null}
                        {tool.changedSinceApproval ? (
                          <Chip tone="warn">changed since you approved it</Chip>
                        ) : null}
                        <span className="conn__spacer" />
                        {/* Approve is a plain button, deliberately.
                            A connector advertises fifteen tools, so a primary
                            colour here stacks fifteen call-to-action buttons
                            down the page and reads as "click these" — which is
                            the opposite of what approving each one means. The
                            emphasis belongs on the description, not the
                            button (D-027: colour marks the exception). */}
                        <Button disabled={busy} onClick={() => onApprove(tool, !tool.approved)}>
                          {tool.approved ? "Withdraw" : "Approve"}
                        </Button>
                      </div>

                      {/* The description is the evidence. It is also written by
                          whoever wrote the connector, so it is shown as a quote
                          rather than as the app's own words. */}
                      <blockquote className="ctool__says">{tool.description}</blockquote>

                      {tool.suspicious === null ? null : (
                        <p className="ctool__warn">{tool.suspicious}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {snapshot.available.length === 0 ? null : (
        <section className="conn__offers">
          <h2 className="conn__offerhead">Available</h2>
          <ul className="conn__list">
            {snapshot.available.map((offer) => (
              <li key={offer.id} className="conn__row">
                <div className="conn__head">
                  <span className="conn__name">{offer.label}</span>
                  {/* The licence sits next to the install button on purpose:
                      it is the whole cost of using this software, and it is
                      checked before anything appears in this list. */}
                  <span className="conn__licence">
                    {offer.licence} · {offer.by}
                  </span>
                  <span className="conn__spacer" />
                  <Button tone="primary" disabled={busy} onClick={() => onInstall(offer.id)}>
                    Install
                  </Button>
                </div>
                <p className="conn__gives">{offer.gives}</p>
                {offer.needs === null ? null : (
                  <p className="conn__needs">Needs: {offer.needs}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="conn__notices">
        <summary className="agrow__disclosure">Attribution for what is installed</summary>
        <pre className="conn__noticetext">{snapshot.notices}</pre>
      </details>
    </div>
  );
}
