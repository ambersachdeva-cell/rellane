# Subscription brain

Runs work through a CLI the user installed and pays for. Replaces the old
`gemini-cli-bridge.ts`, which fabricated answers when no CLI was present.

## The two rules

**We never touch credentials.** Nothing here reads `~/.gemini`, copies a token,
or calls a vendor endpoint. We start the vendor's own binary, as the user, and
read what it prints — the same thing that happens when they type the command
themselves. The old bridge scanned the credential directory and inferred an
identity from filenames; that is gone.

**We never invent output.** Every failure path throws `RuntimeBoundaryError`
with a real reason. There is no branch that returns plausible text when nothing
ran. Capabilities are reported available only after a probe has actually
succeeded.

## Where this may and may not be used

Use it for work a person asked for and is waiting on: drafting, extraction,
turning a sentence into a rule.

Do **not** put it in an unattended path. Lead ingestion, rule evaluation and
message delivery stay deterministic and must keep working when no CLI is
installed, no one is signed in, and the machine is asleep. Two reasons: a docked
CLI holds a personal quota, and it is slow — see below.

## Measured, not assumed

Taken on this machine (M1 Pro, 16 GB) against `agy` 1.1.17 on 2026-08-21:

| What | Result |
|---|---|
| Round trip, small prompt | 13.6 s / 15.7 s |
| Three capability probes, serialised | 42.8 s |
| Hinglish enquiry → structured JSON | correct on every field, confidence 0.95 |

Roughly 14 s per call is process startup, not inference. That is fine for a
person who clicked a button and unacceptable for per-lead triage — which is why
the boundary above exists.

The extraction test that produced that result:

> `sir mujhe 2000 rigid box chahiye 300 gsm sbs matte lamination ke sath, noida me delivery, urgent hai kal tak chahiye rate bata do`

```json
{"item":"rigid box","quantity":2000,"unit":"pcs","substrate":"sbs","gsm":300,
 "finish":"matte lamination","city":"noida","junk":false,
 "urgency":"high","confidence":0.95}
```

## Model identifiers

`agy models` is stale. It lists `gemini-3.6-flash-*` as newest, but
`gemini-3.7-flash-{low,medium,high}` resolves and the model self-identifies as
Gemini 3.7 Flash. `providers.ts` uses the 3.7 strings. The suffix is reasoning
effort, not a different model — `low` for mechanical extraction, `high` for
judgement.

`agy` also supports `--output-format json` and `--json-schema <file>`, which is
a more robust way to get structured output than asking for JSON in the prompt.
Worth adopting for anything whose shape must be guaranteed.

## Discovery

A packaged Electron app launched from Finder does not inherit the login shell's
`PATH`, so `agy` at `~/.local/bin/agy` is invisible to a plain lookup — the old
bridge only checked `/usr/local/bin` and `/opt/homebrew/bin` and would never
have found it. `cli-discovery.ts` searches `PATH` plus the usual install
directories, and confirms a candidate by running it rather than by trusting that
the file exists.

## Verifying against the real tool

Unit tests cannot tell you whether the CLI still behaves as `providers.ts`
claims. Run the live check after changing anything here:

```bash
export PATH="$HOME/.local/bin:$PATH"
CADRANE_BRAIN_LIVE=1 ./node_modules/.bin/vitest run \
  apps/desktop/src/main/subscription-brain/subscription-brain.integration.test.ts \
  --pool=threads --maxWorkers=1 --reporter=verbose
```

It takes about 90 seconds and uses real quota.

## Known risk

Google has stated that driving Gemini CLI from third-party software may breach
its terms, and suspended accounts in February 2026 for proxying its OAuth
tokens. This module deliberately takes the narrower path — it starts the
binary and never handles a credential — but the risk is not zero, and it is
Amber's call, made knowingly.

Two things keep it contained: calls are serialised and paced (`request-queue.ts`)
rather than bursted, which is what abuse detection looks at; and everything
routes through the `BrainRunner` interface, so swapping the provider is a change
to `providers.ts` rather than a rewrite.

## Not done yet

- The renderer still stores OpenAI/Anthropic/DeepSeek API keys in
  `localStorage` via `subscription-brain.ts`, and `ipc.ts` still has those
  metered branches. They contradict the no-API-key direction and should go.
- `ChatStudioView` does not stream; a docked CLI returns one block at the end.
  `agy --output-format stream-json` is the path if streaming is wanted.
