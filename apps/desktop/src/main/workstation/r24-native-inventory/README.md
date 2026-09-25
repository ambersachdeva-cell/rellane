# R24 native inventory prerequisite

This standalone macOS helper inventories **synthetic or separately attested quiescent** trees. It is not connected to the desktop app, export, import, or recovery preflight. Do not run it on live owner data. It reads file payload bytes to compute SHA-256; it does not inspect their meaning or print their contents.

Build with the installed Apple Command Line Tools, without adding a package:

```sh
xcrun clang -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -O2 \
  apps/desktop/src/main/workstation/r24-native-inventory/inventory.c \
  -o /private/tmp/r24-inventory
```

Run on a **synthetic** tree:

```sh
/private/tmp/r24-inventory /private/tmp/synthetic-copy
```

The first line is `R24-NOFOLLOW-INVENTORY<TAB>1`. Following lines are sorted bytewise by relative path. Each directory line is `D<TAB>hex-encoded-path`; each regular-file line is `F<TAB>hex-encoded-path<TAB>byte-count<TAB>sha256`. There is no stdout manifest if scanning fails. A caller must also require exit status zero before accepting output.

The helper canonicalizes ancestor aliases, then opens and pins the canonical root with `O_NOFOLLOW_ANY`. It recursively opens each single-component child through its parent descriptor with `openat(..., O_NOFOLLOW)`, enumerates directories through `fdopendir`, and checks inode/metadata before and after hashing. It rejects symlinks below the opened root, hard-linked files, special files, cross-volume mount entries, changing entries, more than 10,000 entries, more than 32 directory levels, paths longer than 2,048 bytes, and more than 64 MiB of total regular-file bytes. Descriptor containment begins **at the opened root**; the caller must separately attest its canonical identity and intended boundary. The manifest is an observation of one pass. It cannot prove a coherent snapshot if a writer changes multiple files between reads, that a copied SQLite Book and WAL form one transaction state, or that encrypted stores and Keychain references can reopen elsewhere.

The deterministic race seam is compiled only by `inventory.test.ts` with `-DR24_INVENTORY_TESTING`; do not enable that macro in a product build. The suite skips on non-macOS hosts or when `xcrun` is unavailable. Run its synthetic tests with:

```sh
./node_modules/.bin/vitest run apps/desktop/src/main/workstation/r24-native-inventory/inventory.test.ts
```

Before any product integration, the app still needs an independently attested immutable/quiescent whole-root snapshot or an explicit writer-freeze contract, a WAL-aware Book export receipt from a trusted open connection, a complete owned-store and key-portability policy, and staged no-overwrite import with rollback and reopen verification. SQLite's [online backup API](https://www.sqlite.org/backup.html) and [`VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html) can produce a consistent *Book* snapshot through a trusted connection; raw per-file copies cannot substitute for that.
