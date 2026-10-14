#!/usr/bin/env bash
# Sync the read-only opencode reference tree (reference/opencode/) with upstream.
#
#   scripts/sync-opencode.sh          # check + pull if changed
#   scripts/sync-opencode.sh --check  # check only, non-zero exit when outdated
#
# Baseline hash lives in reference/opencode.pin. After a pull, review the
# printed file list, re-read the changed sources under reference/opencode/,
# and update PLAN.md (behavior spec table + deviation register + baseline hash).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$ROOT/reference/opencode"
PIN_FILE="$ROOT/reference/opencode.pin"
BRANCH="dev"
# Only these subtrees are ported; keep in sync with the sparse-checkout set.
PATHS=(packages/core/src packages/tui/src LICENSE)

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

if [[ ! -d "$REF/.git" ]]; then
  echo "reference/opencode missing; cloning (sparse) ..."
  mkdir -p "$ROOT/reference"
  git clone --filter=blob:none --no-checkout --depth 1 \
    "https://github.com/anomalyco/opencode.git" "$REF"
  ( cd "$REF" && git sparse-checkout init --cone \
    && git sparse-checkout set --skip-checks "${PATHS[@]}" \
    && git checkout -q )
  ( cd "$REF" && git rev-parse HEAD ) > "$PIN_FILE"
  echo "pinned $(cat "$PIN_FILE")"
  exit 0
fi

cd "$REF"
CURRENT="$(git rev-parse HEAD)"
# Fetch recent tip history (metadata + trees only: the clone uses
# --filter=blob:none). Enough depth to diff across a few upstream updates;
# missing blobs are lazily fetched on demand from origin.
git fetch --quiet --depth 50 origin "$BRANCH"
UPSTREAM="$(git rev-parse FETCH_HEAD)"

if [[ "$CURRENT" == "$UPSTREAM" ]]; then
  echo "up to date: $CURRENT"
  exit 0
fi

echo "outdated: $CURRENT -> $UPSTREAM"

if (( CHECK_ONLY )); then
  exit 1
fi

git checkout -q --detach "$UPSTREAM"
git sparse-checkout reapply --skip-checks >/dev/null 2>&1 || git sparse-checkout set --skip-checks "${PATHS[@]}"
echo "$UPSTREAM" > "$PIN_FILE"

echo
echo "changed files under ported paths:"
git diff --stat "$CURRENT" "$UPSTREAM" -- "${PATHS[@]}" 2>/dev/null \
  | grep -v "packages/.*/test/" || echo "  (none, or blobs unavailable offline)"
echo
echo "NEXT: re-read changed sources, then update PLAN.md behavior spec + baseline hash."
