/**
 * What macOS is about to ask, said before macOS asks it.
 *
 * The done-when is exact: **no OS dialog appears un-preceded.** A system prompt
 * is a stranger's voice — it names the app, names the folder, and gives no
 * reason, at a moment the person did not choose. Somebody who has not been told
 * what is coming reads it as the app helping itself to their files, and the
 * honest answer is the one that arrives first.
 *
 * ## Why it is shown once
 *
 * Repeated before every grant it would become a dialog people dismiss without
 * reading, which is the same as not having explained anything. So it is
 * recorded (`consent.foldersExplained`) and shown before the first folder only.
 *
 * ## Why it says what it will not do
 *
 * The prompt macOS shows says what access is being requested. It cannot say what
 * the app will refrain from doing, and that is the part that decides whether
 * somebody grants it.
 */

import { Button } from "./ui";

interface Props {
  onContinue(): void;
  onCancel(): void;
}

export function Preflight({ onContinue, onCancel }: Props) {
  return (
    <div className="pf" role="dialog" aria-modal="true" aria-labelledby="pf-title">
      <div className="pf__card">
        <h2 className="pf__title" id="pf-title">
          macOS is about to ask you something
        </h2>
        <p className="pf__body">
          You are going to pick a folder. Straight after, macOS will show its own box asking
          whether Rellane may read files there. That box is from the system, not from us, and it
          cannot say why — so here is why.
        </p>
        <ul className="pf__list">
          <li>
            <strong>Only the folder you pick.</strong> Nothing above it, nothing beside it. A path
            that merely looks like it is inside is refused too.
          </li>
          <li>
            <strong>Nothing is sent anywhere.</strong> Reading happens on this Mac. Anything
            leaving it asks you first, every time, and there is no setting that turns that off.
          </li>
          <li>
            <strong>Everything is written down.</strong> Every file touched appears in the record,
            and changes can be undone.
          </li>
          <li>
            <strong>You can take it back.</strong> Revoke the folder, or pause it, whenever you
            like — What it has seen shows exactly what was picked up.
          </li>
        </ul>
        <p className="pf__note">
          If you say no to the system box, nothing breaks. Rellane will say the folder could not be
          opened, and you can grant it later.
        </p>
        <div className="pf__acts">
          <Button onClick={onCancel}>Not now</Button>
          <Button tone="primary" onClick={onContinue}>
            Show me the folder picker
          </Button>
        </div>
      </div>
    </div>
  );
}
