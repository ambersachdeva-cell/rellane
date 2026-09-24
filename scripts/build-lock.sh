#!/bin/bash
#
# One build at a time, machine-wide.
#
# ## Why this exists
#
# On 2026-09-04 two `package:dir` runs overlapped — one had timed out into the
# background and was still signing while a second started and cleaned the same
# output tree. One deleted a file while the other was sealing it, and the result
# was an app whose signature said `a sealed resource is missing or invalid`.
# Nothing reported an error until `codesign --verify` was run by hand, which is
# the worst kind of failure this repository has: silent, and discovered later.
#
# `npm run build` and `electron-builder` both write to fixed paths — `dist/`,
# `release/` — with no locking of their own. That was survivable while one person
# ran one command. It stops being survivable the moment the crew can trigger a
# verification, because six seats finishing near each other is not an unlikely
# race, it is the normal case.
#
# ## Why a directory and not a lockfile
#
# `mkdir` is atomic on every filesystem this will ever run on, and it cannot
# leave a half-written file behind the way `echo $$ > lock` can. The pid inside
# is for the human reading the refusal, never for the locking itself.
#
# A stale lock — a holder that was killed, as happened on 2026-09-04 with an
# exit 137 — is detected by asking the OS whether that pid is still alive, and
# is broken with a line saying so. A lock that outlives its holder is a build
# system that has stopped working and says nothing, which is the failure we are
# here to remove rather than reproduce.
#
# Usage:  scripts/build-lock.sh npm run package:dir

set -euo pipefail

LOCK_DIR="${TMPDIR:-/tmp}/cadrane-build.lock"
WAIT_SECONDS="${BUILD_LOCK_WAIT:-1800}"

if [ "$#" -eq 0 ]; then
  echo "build-lock: nothing to run. Usage: scripts/build-lock.sh <command...>" >&2
  exit 64
fi

waited=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"

  # A holder that is gone is not a holder. Break it, and say so — a build that
  # silently waits 30 minutes on a dead process is indistinguishable from a hang.
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    echo "build-lock: pid $holder holds the lock and is not running. Breaking it." >&2
    rm -rf "$LOCK_DIR"
    continue
  fi

  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    echo "build-lock: pid ${holder:-unknown} has held the build lock for ${WAIT_SECONDS}s." >&2
    echo "build-lock: refusing to build beside it. Two builds share dist/ and release/," >&2
    echo "build-lock: and the second one corrupts the first one's signature." >&2
    exit 75
  fi

  if [ "$waited" -eq 0 ]; then
    echo "build-lock: waiting for pid ${holder:-unknown} to finish its build…" >&2
  fi
  sleep 2
  waited=$((waited + 2))
done

echo "$$" > "$LOCK_DIR/pid"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LOCK_DIR/since"

# Released on success, on failure, and on being killed — the exit-137 case is
# the one that started this file, so it is the one the trap most has to cover.
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

"$@"
