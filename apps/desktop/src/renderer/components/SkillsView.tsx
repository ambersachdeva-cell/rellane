/**
 * The skills browser.
 *
 * Its job is not to list skills — the rail already does that. Its job is to
 * answer "what is this thing allowed to do on my machine", for something that
 * may have arrived from a stranger.
 *
 * So permissions lead, in the owner's words, showing what the skill will
 * *actually* get after the platform ceiling rather than what its manifest
 * asked for. A skill requesting more than it can have is displayed at the
 * lower number, because promising the higher one would be a lie told at the
 * exact moment someone is deciding whether to trust it.
 */

import type { InstalledSkill } from "@cadrane/contracts";
import { Button, Chip, Empty, Section } from "./ui";

interface Props {
  skills: readonly InstalledSkill[];
  rejected: readonly { folder: string; problems: readonly string[] }[];
  onRun(skillId: string): void;
  busy: boolean;
  canRun: boolean;
}

export function SkillsView({ skills, rejected, onRun, busy, canRun }: Props) {
  return (
    <div className="stack">
      <Section title={`Installed · ${skills.length}`}>
        {skills.length === 0 ? (
          <Empty
            title="No skills yet"
            body="Skills are folders. Drop one into Rellane's skills directory and it appears here, with everything it is allowed to do listed before you run it."
          />
        ) : (
          skills.map((skill) => (
            <article key={skill.id} className="skill">
              <header className="skill__head">
                <div className="skill__ident">
                  <h3 className="skill__name">{skill.name}</h3>
                  <span className="skill__meta mono">
                    {skill.version} · {skill.author}
                  </span>
                </div>
                <Button
                  onClick={() => onRun(skill.id)}
                  disabled={busy || !canRun}
                  title={canRun ? undefined : "Grant a folder first"}
                >
                  Run
                </Button>
              </header>

              <p className="skill__desc">{skill.description}</p>

              <div className="skill__perms">
                <span className="skill__permhead">It is allowed to</span>
                <ul className="skill__permlist">
                  {skill.permissions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>

              {skill.triggers.length === 0 ? null : (
                <div className="skill__triggers">
                  <span className="skill__permhead">Say</span>
                  <span className="row">
                    {skill.triggers.slice(0, 6).map((trigger) => (
                      <Chip key={trigger}>{trigger}</Chip>
                    ))}
                  </span>
                </div>
              )}
            </article>
          ))
        )}
      </Section>

      {rejected.length === 0 ? null : (
        <Section title={`Could not be loaded · ${rejected.length}`}>
          {/* Named rather than silently skipped: a skill that quietly fails to
              appear is indistinguishable from one that was never installed. */}
          {rejected.map((entry) => (
            <div key={entry.folder} className="skill skill--broken">
              <span className="skill__meta mono">{entry.folder}</span>
              <ul className="skill__permlist">
                {entry.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
