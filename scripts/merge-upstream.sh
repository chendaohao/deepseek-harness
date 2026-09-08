#!/usr/bin/env bash
set -euo pipefail

# Merge the upstream branch into the current branch with the generator-owned
# artifact set resolved mechanically: take the merge ref's side, then
# regenerate from merged source. Hand-written conflicts stay unmerged and are
# printed as a manual queue. The script never commits.
#
# Usage:
#   scripts/merge-upstream.sh [--ref <git-ref>]  start or resume a merge
#                                                (default ref: upstream/master)
#   scripts/merge-upstream.sh --finish           run pnpm install, regenerate
#                                                every artifact, and stage,
#                                                after the manual queue is
#                                                resolved
#
# Generator-owned artifacts (auto-resolved from the merge ref):
#   THIRD_PARTY_NOTICES.md, apps/cli/composition.md,
#   docs/agent-lifecycle.md, docs/capability-seams.md, docs/config-catalog.md,
#   docs/cordis-api/{context,events,fiber,registry,service,inherited}.md,
#   docs/event-producer-consumer.md, docs/graph-atlas.md, docs/module-graph.md,
#   docs/module-graph.zh.md, docs/persistence-catalog.md, docs/tool-catalog.md,
#   docs/tool-execution-pipeline.md,
#   packages/core/scope/src/scoped-events.generated.ts,
#   packages/core/session/src/known-event-types.ts,
#   packages/extensions/tool-cordis/src/api-catalog.ts,
#   packages/extensions/cordis-client-runner/src/client/{api-catalog,slot-catalog}.ts,
#   pnpm-lock.yaml, tsconfig.base.json (alias block re-injected, see below).
#
# The hand-paired Chinese counterparts of generated English documents are
# never auto-resolved; verify-translation-pairing names the stale pairs after
# regeneration.

REF=upstream/master
MODE=start
while (( $# > 0 )); do
  case $1 in
    --ref)
      REF=${2:?--ref requires a value}
      shift 2
      ;;
    --finish)
      MODE=finish
      shift
      ;;
    *)
      echo "merge-upstream: unknown argument $1" >&2
      exit 1
      ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"

die() {
  echo "merge-upstream: $*" >&2
  exit 1
}

warn() {
  echo "merge-upstream: $*" >&2
}

# Generator-owned artifacts; regeneration in --finish overwrites whatever the
# merge left here, so taking the ref's side loses nothing hand-written.
GENERATED_ARTIFACTS=(
  THIRD_PARTY_NOTICES.md
  apps/cli/composition.md
  docs/agent-lifecycle.md
  docs/capability-seams.md
  docs/config-catalog.md
  docs/cordis-api/context.md
  docs/cordis-api/events.md
  docs/cordis-api/fiber.md
  docs/cordis-api/inherited.md
  docs/cordis-api/registry.md
  docs/cordis-api/service.md
  docs/event-producer-consumer.md
  docs/graph-atlas.md
  docs/module-graph.md
  docs/module-graph.zh.md
  docs/persistence-catalog.md
  docs/tool-catalog.md
  docs/tool-execution-pipeline.md
  packages/core/scope/src/scoped-events.generated.ts
  packages/core/session/src/known-event-types.ts
  packages/extensions/cordis-client-runner/src/client/api-catalog.ts
  packages/extensions/cordis-client-runner/src/client/slot-catalog.ts
  packages/extensions/tool-cordis/src/api-catalog.ts
)

# Hand-written tsconfig.base.json aliases the fork owns. The generator maps a
# package only when its declared name equals its directory name and emits no
# src/* wildcards, so these entries cannot be regenerated; they are re-injected
# outside the generated region whenever the merge ref's tsconfig.base.json is
# taken. Extend this list when a fork package needs a hand-written alias, and
# keep the same block committed in the working file.
FORK_ALIAS_BLOCK_FILE=$(mktemp)
trap 'rm -f "$FORK_ALIAS_BLOCK_FILE"' EXIT
cat >"$FORK_ALIAS_BLOCK_FILE" <<'EOF'
      // Fork-local hand-written aliases, re-injected by scripts/merge-upstream.sh
      // after taking the merge ref's tsconfig.base.json; keep them outside the
      // generated region.
      "@deepseek-ai/dsh-mcp-client/src/*": ["./packages/mcp/mcp-client/src/*"],
      "@deepseek-ai/dsh-client-ui-remote": ["./packages/client/ui-remote/src"],
      "@deepseek-ai/dsh-client-ui-remote/client": ["./packages/client/ui-remote/src/client"],
EOF

# One hint per hand-resolved path prefix; printed with the manual queue.
queue_hint() {
  case $1 in
    docs/subsystems/*)
      echo "  (cordis-surface regions resolve either side; gen-cordis-catalog rewrites regions in --finish; merge non-region prose by hand)" ;;
    packages/api/session-controller/*|packages/api/gateway/*)
      echo "  (upstream Session API drift; adapt the local behavior and tests)" ;;
    apps/web/tests/*)
      echo "  (the fork removed the remote-welcome flow; keep deletions unless upstream reworked the feature)" ;;
    tsconfig.host.json|tsconfig.client.json)
      echo "  (register fork packages in the compiler faces)" ;;
    packages/*/package.json)
      echo "  (reconcile fork package dependencies with upstream versions)" ;;
  esac
}

unmerged_paths() {
  git diff --name-only --diff-filter=U
}

declare -A unmerged_set=()
load_unmerged() {
  unmerged_set=()
  while IFS= read -r path; do
    [[ -n $path ]] && unmerged_set[$path]=1
  done < <(unmerged_paths)
}

is_unmerged() {
  [[ ${unmerged_set[$1]+present} ]]
}

# Resolve one unmerged path by taking the merge ref's side; accept the ref's
# deletion when the artifact is gone there.
take_ref_side() {
  local path=$1
  if git cat-file -e "$REF:$path" 2>/dev/null; then
    git checkout "$REF" -- "$path"
  else
    git rm -q -- "$path"
  fi
}

inject_fork_aliases() {
  local tsconfig=$1
  local tmp
  tmp=$(mktemp)
  awk -v blockfile="$FORK_ALIAS_BLOCK_FILE" '
    FNR == NR { block[++n] = $0; next }
    /^ *\/\/ BEGIN generated package aliases/ && !injected {
      while (i++ < n) print block[i]
      injected = 1
    }
    { print }
    END { if (!injected) exit 3 }
  ' "$FORK_ALIAS_BLOCK_FILE" "$tsconfig" >"$tmp" || {
    rm -f "$tmp"
    die "$tsconfig is missing the generated-region marker; re-add the fork alias block by hand"
  }
  mv "$tmp" "$tsconfig"
  git add -- "$tsconfig"
}

if [[ $MODE == finish ]]; then
  git rev-parse -q --verify MERGE_HEAD >/dev/null \
    || die "--finish requires a merge in progress"
  load_unmerged
  remaining=${#unmerged_set[@]}
  (( remaining == 0 )) || die "--finish requires zero unmerged paths; $remaining remain (list them with: git diff --name-only --diff-filter=U)"
else
  # Untracked paths are ignored: this workspace keeps local runtime dirs
  # (.codegraph/, .omc/, apps/mobile/, tarballs) untracked by policy, and a
  # merge only corrupts tracked content. A merge also refuses to start while
  # untracked paths would be overwritten, so nothing is hidden here.
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die "tracked worktree changes present; commit or stash before merging"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required"
  git rev-parse -q --verify "$REF" >/dev/null || die "unknown ref $REF; fetch its remote first"
  git rev-parse -q --verify MERGE_HEAD >/dev/null && die "a merge is already in progress; resolve it, or run with --finish once the queue is clear"

  remote=${REF%%/*}
  if git remote get-url "$remote" >/dev/null 2>&1; then
    git fetch "$remote" --quiet || warn "could not fetch $remote now; merging the previously fetched $REF"
  fi

  if git merge-base --is-ancestor "$REF" HEAD; then
    echo "merge-upstream: already up to date with $REF ($(git rev-parse --short "$REF") $(git log -1 --format=%s "$REF"))"
    exit 0
  fi

  echo "merge-upstream: merging $REF ($(git rev-parse --short "$REF") $(git log -1 --format=%s "$REF")) into $(git branch --show-current)"

  merge_output=$(git merge --no-ff --no-commit "$REF" 2>&1) || true
  git rev-parse -q --verify MERGE_HEAD >/dev/null \
    || die "the merge failed to start; git output:
$merge_output"
  [[ $merge_output == *"Automatic merge failed"* ]] \
    && echo "merge-upstream: automatic merge reported conflicts; resolving the generator-owned set"

  load_unmerged

  for path in "${GENERATED_ARTIFACTS[@]}"; do
    if is_unmerged "$path"; then
      take_ref_side "$path"
      echo "merge-upstream: took $REF side of generated artifact $path"
    fi
  done

  if is_unmerged pnpm-lock.yaml; then
    take_ref_side pnpm-lock.yaml
    echo "merge-upstream: took $REF side of pnpm-lock.yaml (pnpm install re-resolves fork deps in --finish)"
  fi

  if is_unmerged tsconfig.base.json; then
    take_ref_side tsconfig.base.json
    inject_fork_aliases tsconfig.base.json
    echo "merge-upstream: re-injected the fork alias block into tsconfig.base.json"
  fi

  load_unmerged
  for path in $(unmerged_paths); do
    if [[ $path == *.i18n.yaml ]]; then
      pairing_unresolved=1
      break
    fi
  done
  if [[ ${pairing_unresolved:-} ]]; then
    if pnpm run --silent resolve-translation-pairing-conflicts; then
      echo "merge-upstream: resolved pairing records with resolve-translation-pairing-conflicts"
    else
      warn "resolve-translation-pairing-conflicts failed; pairing records stay in the manual queue"
    fi
    load_unmerged
  fi

  load_unmerged
  if (( ${#unmerged_set[@]} > 0 )); then
    echo
    echo "merge-upstream: manual queue (${#unmerged_set[@]} path(s)); resolve these, then run:"
    echo "  scripts/merge-upstream.sh --finish"
    for path in $(unmerged_paths); do
      echo "  $path"
      queue_hint "$path"
    done
    exit 1
  fi

  echo "merge-upstream: no hand-written conflicts; continuing with regeneration"
fi

# Finish phase: regenerate every artifact from merged source, stage, and
# report. Failures here leave the merge state intact; fix the cause and rerun
# --finish. Never aborts: operator resolutions already exist on disk.

untracked_before=$(git status --porcelain | awk '/^\?\?/ {print $2}' | LC_ALL=C sort)

echo "merge-upstream: pnpm install"
pnpm install

# A conflict-free merge takes the merge ref's tsconfig.base.json verbatim, so
# the fork alias block is absent. Re-inject before generating: the block lives
# outside the generated region, and the sentinel comment keeps the injection
# idempotent across --finish reruns.
if ! grep -qF 'Fork-local hand-written aliases, re-injected by scripts/merge-upstream.sh' tsconfig.base.json; then
  inject_fork_aliases tsconfig.base.json
  echo "merge-upstream: re-injected the fork alias block into tsconfig.base.json"
fi

regenerate_fail() {
  die "pnpm run $1 failed; fix the cause and rerun scripts/merge-upstream.sh --finish"
}
for gen in \
  gen-tsconfig-paths \
  gen-scoped-events \
  gen-cordis-catalog \
  gen-cordis-inspect-catalog \
  gen-client-catalog \
  gen-tool-catalog \
  gen-config-catalog \
  gen-persistence-catalog \
  gen-module-graph \
  gen-doc-graphs \
  gen-third-party-notices; do
  echo "merge-upstream: pnpm run $gen"
  pnpm run --silent "$gen" || regenerate_fail "$gen"
done

# The block was injected whole; a per-alias miss means a hand edit dropped a
# line that regeneration cannot restore, and a count above one means a hand
# edit re-added an alias outside the block (vite/esbuild then reports
# duplicate-object-key).
while IFS= read -r alias; do
  count=$(grep -cF "$alias" tsconfig.base.json || true)
  if (( count == 0 )); then
    die "tsconfig.base.json lost the fork alias $alias; add it back to FORK_ALIAS_BLOCK_FILE in scripts/merge-upstream.sh and rerun --finish"
  elif (( count > 1 )); then
    die "tsconfig.base.json has $count copies of the fork alias $alias; keep only the block re-injected by scripts/merge-upstream.sh"
  fi
done <<'EOF'
"@deepseek-ai/dsh-mcp-client/src/*"
"@deepseek-ai/dsh-client-ui-remote"
EOF

git add -u

# Regeneration may legitimately create new files (a first-time generated
# artifact); surface only what this run added, not pre-existing untracked state.
untracked_after=$(git status --porcelain | awk '/^\?\?/ {print $2}' | LC_ALL=C sort)
new_untracked=$(comm -13 <(echo "$untracked_before") <(echo "$untracked_after"))
if [[ -n $new_untracked ]]; then
  warn "untracked paths appeared during regeneration; review and add or remove them:"
  echo "$new_untracked" | sed 's/^/  /' >&2
fi

if pairing_report=$(pnpm run --silent verify-translation-pairing 2>&1); then
  echo "merge-upstream: all translation pairs are consistent"
else
  warn "translation pairs need re-pairing (regenerated English sides drifted from the hand-paired Chinese counterparts):"
  echo "$pairing_report" | head -20 | sed 's/^/  /' >&2
fi

version=$(git show "$REF":package.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
branch=$(git branch --show-current)
echo
echo "merge-upstream: regeneration complete and staged. Review, then conclude the merge with:"
echo "  git commit -m \"merge: upstream master (dsh ${version:-<version>}) into $branch\""
