/**
 * Models — the ones that run on this Mac.
 *
 * This surfaces a catalogue that has existed, fully working and fully wired to
 * IPC, with **no interface at all**. The components that used it were deleted
 * in the 0.2.3 era and nothing replaced them, so eighteen channels of real
 * functionality sat unreachable while the app looked empty.
 *
 * What the backend already does, and what this is therefore able to show
 * honestly rather than approximate:
 *
 *   - **Fit against this actual machine.** Not "recommended" — a score, a
 *     verdict, the reasons behind it, and the memory headroom left over. The
 *     hardware profile is measured, so the verdict has a source.
 *   - **Licences reviewed rather than assumed.** Every entry carries a review
 *     state, and "unreviewed" is shown as unreviewed instead of being quietly
 *     treated as fine.
 *   - **Artifacts pinned all-or-nothing.** A model with a digest, a revision
 *     and an immutable URL can be verified on arrival; one without them cannot
 *     be installed at all, and the screen says which is which.
 *
 * The ordering rule: what runs well here, first. A catalogue sorted by
 * parameter count is a leaderboard, and a leaderboard on a 16 GB laptop is an
 * invitation to download something that will not run.
 */

import type { ConciergeSnapshot, ModelFit, ModelInstallStatus } from "@cadrane/contracts";
import { Button } from "./ui";
import { size } from "../../shared/copy.js";

interface Props {
  snapshot: ConciergeSnapshot | null;
  installs: readonly ModelInstallStatus[];
  busy: string | null;
  onReview(modelId: string): void;
  onCancel(operationId: string): void;
}

export function ModelsView({ snapshot, installs, busy, onReview, onCancel }: Props) {
  if (snapshot === null) {
    return <p className="muted">Measuring this Mac and reading the catalogue.</p>;
  }

  const byId = new Map(installs.map((install) => [install.modelId, install]));
  const runnable = snapshot.recommendations.filter((fit) => fit.fit !== "unsupported");
  const tooBig = snapshot.recommendations.filter((fit) => fit.fit === "unsupported");

  return (
    <div className="models">
      <p className="models__machine">
        {machineLine(snapshot)}
      </p>

      <div className="band">
        <h2 className="band__title">Runs on this Mac</h2>
        <span className="band__note">catalogue reviewed {snapshot.catalogReviewedAt}</span>
      </div>

      {runnable.length === 0 ? (
        <p className="muted">
          Nothing in the catalogue fits this machine comfortably. Rellane will not offer a
          model it expects to fail here.
        </p>
      ) : (
        <ul className="mlist">
          {runnable.map((fit) => (
            <ModelRow
              key={fit.model.id}
              fit={fit}
              install={byId.get(fit.model.id)}
              busy={busy !== null}
              onReview={onReview}
              onCancel={onCancel}
            />
          ))}
        </ul>
      )}

      {tooBig.length === 0 ? null : (
        <>
          <div className="band">
            <h2 className="band__title">Too big for this Mac</h2>
          </div>
          {/**
           * Shown rather than hidden. Knowing a model exists and will not run
           * here is useful — it is what tells somebody what a larger machine
           * would buy them, and hiding it would look like a smaller catalogue.
           */}
          <ul className="mlist">
            {tooBig.map((fit) => (
              <li key={fit.model.id} className="mrow mrow--out">
                <span className="mrow__name">{fit.model.displayName}</span>
                <span className="mrow__why">{fit.reasons[0] ?? "Does not fit this machine."}</span>
                <span className="mrow__size">{size(fit.model.artifact.downloadBytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ModelRow({
  fit,
  install,
  busy,
  onReview,
  onCancel
}: {
  fit: ModelFit;
  install: ModelInstallStatus | undefined;
  busy: boolean;
  onReview(modelId: string): void;
  onCancel(operationId: string): void;
}) {
  const model = fit.model;
  const installed = install?.state === "installed";
  const downloading = install !== undefined && ["queued", "downloading", "verifying"].includes(install.state);

  return (
    <li className="mrow">
      <div className="mrow__head">
        <span className="mrow__name">{model.displayName}</span>
        <span className={`fit fit--${fit.fit}`}>{fitWord(fit.fit)}</span>
        <span className="mrow__meta">
          {model.parametersBillions}B · {model.artifact.quantization} ·{" "}
          {size(model.artifact.downloadBytes)}
        </span>
        <span className="mrow__spacer" />
        {installed ? (
          <span className="mrow__done">Installed</span>
        ) : downloading ? (
          <Button
            disabled={install.operationId === null} onClick={() => install.operationId !== null && onCancel(install.operationId)}
          >
            Stop
          </Button>
        ) : fit.canInstall ? null : (
          <span className="mrow__blocked">{whyBlocked(fit)}</span>
        )}
        <Button disabled={busy || downloading} onClick={() => onReview(model.id)}>Review model</Button>
      </div>

      <p className="mrow__desc">{model.description}</p>

      {/* The verdict's own reasons. A score with no reasoning is a number to
          take on faith, which is what principle 4 exists to prevent. */}
      <ul className="mrow__reasons">
        {fit.reasons.slice(0, 2).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
        {fit.warnings.map((warning) => (
          <li key={warning} className="mrow__warn">
            {warning}
          </li>
        ))}
      </ul>

      {downloading ? (
        <div className="mrow__progress">
          <div
            className="mrow__bar"
            style={{ width: `${percent(install.bytesReceived, install.totalBytes)}%` }}
          />
          <span className="mrow__pct">
            {size(install.bytesReceived)} of {size(install.totalBytes)}
            {install.resumeAvailable ? " · can resume" : ""}
          </span>
        </div>
      ) : null}

      {install?.error == null ? null : (
        <p className="mrow__error">{install.detail}</p>
      )}

      <p className="mrow__licence">
        {licenceLine(model.license.name, model.license.distributionReview)}
        {model.artifact.sha256 === null
          ? " · Not pinned, so it cannot be verified on arrival and will not install."
          : " · Downloads are checked against the pinned digest before installation."}
      </p>
    </li>
  );
}

/**
 * Why a model that fits cannot yet be installed.
 *
 * The catalogue deliberately gates installation behind a signed catalogue
 * envelope, a managed runtime and native conformance on the target — see
 * docs/MODEL-CATALOG.md. That is a good gate and a terrible thing to express as
 * a greyed-out button, because a refusal with no reason reads as a bug.
 */
export function whyBlocked(fit: ModelFit): string {
  if (fit.model.artifact.sha256 === null) {
    return "Not pinned yet — no digest to verify it against.";
  }
  const conformance = fit.warnings.find((warning) => warning.includes("conformance"));
  return conformance === undefined
    ? "Not installable yet."
    : "Not verified on this hardware yet.";
}

/** The verdict, in a word a person can act on. */
export function fitWord(fit: ModelFit["fit"]): string {
  switch (fit) {
    case "excellent":
      return "Comfortable";
    case "good":
      return "Fine";
    case "tight":
      return "Tight";
    case "unsupported":
      return "Will not run";
  }
}

/**
 * The licence, said plainly.
 *
 * "Reviewed" is an engineering statement about distribution terms, not legal
 * advice, and the wording says so — overclaiming here would be the exact kind
 * of loose language the security section forbids.
 */
export function licenceLine(
  name: string,
  review: "permissive-terms-reviewed" | "conditional" | "unreviewed"
): string {
  switch (review) {
    case "permissive-terms-reviewed":
      return `${name}, terms reviewed as permissive`;
    case "conditional":
      return `${name}, conditional terms — read them before you rely on it`;
    case "unreviewed":
      return `${name}, terms not reviewed`;
  }
}

/** One line about the machine the verdicts are measured against. */
export function machineLine(snapshot: ConciergeSnapshot): string {
  const profile = snapshot.profile;
  return `${profile.chip} · ${size(profile.memoryBytes)} memory · ${size(
    profile.freeDiskBytes
  )} free · ${profile.acceleration}`;
}

function percent(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((received / total) * 100));
}
