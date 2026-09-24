# Writing a skill

A skill is a **folder with a `skill.json` in it**. That is the whole format. It can be read,
diffed, versioned, and sent to somebody over AirDrop — no marketplace, no account, no server.

The important consequence, and the reason the format is this small: **a skill declares, it does
not execute.** It names tools that already exist inside Rellane. It ships no code, so there is
no path by which somebody else's skill runs something the sandbox has not already bounded, and
no path by which it finishes without leaving a receipt.

That means the worst a badly-written skill can do is ask for something and be refused.

---

## The smallest one that works

```
tidy-quotes/
  skill.json
```

```json
{
  "id": "tidy-quotes",
  "name": "Tidy quotes",
  "description": "Put loose quote PDFs into a folder per client.",
  "version": "1.0.0",
  "author": "Amber Sachdeva",
  "tools": ["list_folder", "read_text", "move_file"],
  "autonomy": { "read": "auto", "write": "confirm" },
  "triggers": ["tidy quotes", "sort quotes"],
  "watch": null
}
```

Drop that folder into Rellane's skills directory and it appears in the catalogue with its
permissions written out in plain words. Nothing happens until somebody runs it.

## The fields

| Field | What it does |
|---|---|
| `id` | Lowercase, hyphens, 2–41 characters. Must be unique on the Mac. |
| `name` / `description` | What a person sees. Write the description as *what it does for me*, not what it does technically. |
| `version` | `major.minor.patch`, exactly. |
| `author` | Shown at install. **Never used as authorisation** — a familiar name grants nothing. |
| `tools` | Tools it may call. Anything not listed is refused at run time, not merely discouraged. |
| `autonomy` | What it may do *without being asked*, per risk class. See below. |
| `triggers` | Words that surface it in the command bar. |
| `watch` | When it runs by itself, if ever: a folder, a schedule, or a message. `null` for never. |

Anything unrecognised is **refused, not ignored** — a typo'd field name fails the install rather
than silently doing nothing, because a skill that half-loaded is worse than one that did not.

## Autonomy, and the ceiling you cannot pass

Each risk class takes `off`, `draft`, `confirm` or `auto`.

| Risk | Ceiling | Meaning |
|---|---|---|
| `read` | `auto` | May read inside granted folders freely. |
| `write` | `confirm` | Every change is shown before it happens. |
| `network` | `confirm` | |
| `outbound` | **`confirm`, always** | Nothing reaches another person without the owner. |
| `shell` | **`confirm`, always** | |

Asking for more than the ceiling is not an error — you simply do not get it, **and the install
screen says you asked.** That is deliberate: a skill reaching past the rules is worth knowing
about, and it is the difference between one that fits them and one that would ignore them given
the chance.

`outbound` and `shell` are locked. There is no manifest value, no setting and no install choice
that raises them, which is what makes *"nothing leaves this Mac without you"* a property of the
software rather than a promise in its marketing.

## What a skill can rely on

- **The sandbox.** Every path resolves inside a folder the owner granted. Symlinks pointing out
  are refused, and so is a path that merely looks like it is inside one.
- **A receipt.** Every run produces one, listing each step, whether it succeeded, and whether it
  can be undone. This is not optional and not something a skill provides.
- **Undo.** Anything that changed files is reversible for a window afterwards, from a pre-image
  taken before the first change.

## What a skill cannot do

- Run its own code, or load any.
- Reach a file outside the granted folders.
- Send anything anywhere without the owner approving that specific message.
- Complete without a receipt.
- Grant itself anything by claiming a trusted author.

## Testing yours

Install it, then run it once on a folder of copies. Read the plan sheet before approving: it
lists every file that will change, and if it names something you did not expect, the skill is
wrong and you have found out for free.

If it does not appear in the catalogue, it was rejected — the Skills screen lists rejected
folders with every problem at once, rather than one at a time.
