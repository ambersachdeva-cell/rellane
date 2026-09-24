# Pinned local runtime

The macOS arm64 llama.cpp b10182 runtime binaries are not stored in this source repository. `packages/runtime` and `apps/desktop` contain the integration code. For a locally packaged app, obtain the pinned upstream archive from the source URL in `third_party/llama.cpp/b10182/macos-arm64/source-receipt.json`, verify its SHA-256 against that receipt, and place the required runtime files in this directory before packaging.

The upstream MIT license is preserved here and in `NOTICES.md`. Do not replace the pin with an unverified binary.
