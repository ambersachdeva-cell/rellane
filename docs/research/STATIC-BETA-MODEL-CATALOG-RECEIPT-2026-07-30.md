# Static beta model catalog source receipt

Status: immutable local beta input, generation 1, `darwin-arm64` only.

## Signed inputs

- Catalog ID: `switchboard-model-catalog`
- Key ID: `switchboard-static-beta-2026-07-30`
- Validity: `2026-07-30T00:00:00.000Z` through (exclusive) `2027-07-30T00:00:00.000Z`
- Model: `qwen3-4b-q4-k-m`
- Repository: `Qwen/Qwen3-4B-GGUF`
- Revision: `bc640142c66e1fdd12af0bd68f40445458f3869b`
- File: `Qwen3-4B-Q4_K_M.gguf`
- Bytes: `2497280256`
- SHA-256: `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`
- Exact notice source: `third_party/model-licenses/apache-2.0/LICENSE.txt`
- Notice bytes: `11358`
- Notice SHA-256: `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

## Signing receipt

Node's built-in cryptography generated a one-time Ed25519 pair in one process.
The exact envelope bytes used the same canonical shape and key ordering as the
existing `catalogSigningBytes` implementation (`algorithm`, `body`, `keyId`).
The process emitted only the public SPKI, its fingerprint, the catalog
signature, and non-secret digests. The secret signing half was never printed or
written and was discarded when the process ended.

- Public SPKI SHA-256: `fd4d4ce55ece7e857a07b6b0c38221fe7e48e5d62747fd8b8b93a6d5bf31f76d`
- Canonical signing-bytes SHA-256: `62968c09dd64ce502d56396391295ece4ec2b15ba362abc524cd081016997b01`
- Signature: `yGDV7Frl91VcVFIE/hU/2hZgREfVUsdK1E7kJLAqW+onZ9RMk1SNuHJfJjHchM/e1yzNpns6jQZczuQYjl3QAw==`

## Boundary

This is a static beta allowlist, not release signing and not an auto-refresh
mechanism. It proves the catalog envelope and exact pinned inputs only. It does
not claim native conformance, model execution, runtime readiness, Apple
distribution signing, or production trust-root rotation. The starter
catalog's `validatedTargets` remains unchanged.
