# Contributing to Rellane

Rellane is an early public source project. The primary maintainer reviews changes for product fit, data safety, and whether the behavior can be demonstrated in the desktop app.

1. Search existing issues before opening a new one. Include the macOS version, app or source revision, steps to reproduce, expected behavior, actual behavior, and a small synthetic example.
2. For code changes, keep the pull request focused. Explain the user-visible behavior and any data migration or outbound effect.
3. Run `pnpm run build`, then `pnpm run typecheck`, then `pnpm run test`. Mention any skipped or unavailable checks in the pull request.
4. Do not include real customer records, AI profile directories, API keys, tokens, or signing materials. Use synthetic fixtures.
5. Keep explicit owner review for outbound actions. Changes that touch persisted data should preserve existing records and explain recovery behavior.

For a security issue, follow [SECURITY.md](SECURITY.md) instead of filing a public issue with exploit details.
