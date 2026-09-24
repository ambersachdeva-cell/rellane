# Rellane

Rellane is a local-first macOS desktop workspace for business records and AI-assisted work. Its design centres on a reviewable plan, an explicit owner decision before outbound actions, and a record of what the app changed. The application is built with Electron, React, TypeScript, and SQLite.

**Status:** early public source snapshot. The repository contains a working application codebase and automated tests, but it is not a supported release or a claim that every feature is usable end to end. See [project status](docs/STATUS.md) before evaluating a feature. The public snapshot starts from the last committed private source revision (`840c2c8`, 16 September 2026); later uncommitted work is not included.

## Why it exists

Small teams often have their work scattered between files, messages, invoices, and AI chats. Rellane explores one local workspace where those pieces can be connected without making a remote service the system of record. Local model support and owner-controlled use of signed-in AI tools are part of the design. No API key is required to build or run the core app.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Electron app and React interface |
| `apps/daemon` | Local automation runtime |
| `packages/contracts` | Shared validated messages and types |
| `packages/runtime` | Local model, capability, and storage primitives |
| `native` | macOS document helper source and bundled executable |
| `vendor`, `third_party`, `NOTICES.md` | Pinned upstream components and attribution |

## Build on macOS

Use an Apple Silicon Mac, Node.js 24.14.x, and pnpm 11.9.0. The desktop package is currently configured for the existing Cadrane bundle identity; changing it would be a separate migration for existing user data.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test
```

The build runs before typecheck because workspace packages resolve through generated `dist/` directories. `pnpm run dev` starts the desktop development app. Local model weights and the pinned llama.cpp runtime binaries must be obtained separately for a packaged local-model build; see the [runtime note](apps/desktop/vendor/llama-b10182/README.md). Tests that require a live paid AI subscription are skipped unless explicitly enabled.

## Contribute

Issues, focused fixes, and documentation improvements are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please keep real customer data, credentials, and private profile directories out of reports and commits.

## License

Original Rellane source in this repository is available under the [MIT License](LICENSE). Bundled third-party components retain their own licenses and notices in [NOTICES.md](NOTICES.md), `vendor/`, and `third_party/`.
