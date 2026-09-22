#!/usr/bin/env bash
# sync-fork-main.sh — reset fork main to upstream/main and cherry-pick the fork's PR work on top.
#
# Replaces rebuild.sh (retired 2026-09-17). Fork main = upstream/main + cherry-picked
# PR commits (real subjects, real review trail). No squash layer, no force-push.
#
# Usage:
#   ./sync-fork-main.sh              # full run: reset + cherry-pick + push (lease-guarded)
#   ./sync-fork-main.sh --no-push    # do everything, leave the push to you
#   ./sync-fork-main.sh --dry        # print the plan, touch nothing
#
# PR set: edit pr_commits() below when the PR list changes.
set -euo pipefail

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DRY=0; NO_PUSH=0
for arg in "$@"; do
	case "$arg" in
		--no-push) NO_PUSH=1;;
		--dry) DRY=1;;
		*) printf 'unknown option: %s\n' "$arg" >&2; exit 1;;
	esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

say "== fetch =="
git fetch origin main --quiet
git fetch upstream main --quiet

UPSTREAM="$(git rev-parse upstream/main)"
ORIGIN="$(git rev-parse origin/main)"
say "upstream/main = $UPSTREAM"
say "origin/main   = $ORIGIN"

if [[ "$UPSTREAM" == "$ORIGIN" ]]; then
	say "fork main already equals upstream main. nothing to do."
	exit 0
fi

# Fork-local base under the old protocol: the pre-merge fork main that carried the
# PR cherry-picks (the 2026-09-17 layer 85eccd33b0 sits on dbf3afad48).
FORK_BASE="85eccd33b0"
if ! git rev-parse --verify --quiet "$FORK_BASE^{commit}" >/dev/null; then
	die "fork base $FORK_BASE not found; adjust FORK_BASE"
fi

# ---------------------------------------------------------------
# pr_commits — the cherry-pick set, in dependency order.
# Each line: <sha> required
#   sha            upstream-PR-derived tip (merge-forward head) carrying the work
#   (order)        deps first; a failed pick aborts the run for manual replay
# ---------------------------------------------------------------
pr_commits() {
	# shas verified 2026-09-21 against the PR heads (gh pr view --json headRefOid).
	# When a PR merges upstream, DELETE its line here (an already-merged pick is a
	# no-op empty pick, kept only for self-documentation).
	cat <<'EOF'
f05bdccdcf fix(retry): honor retry-after + 429 chain tests   (#8926 head)
96e448e952 test(hashline): corpus guard + native-predicate follow  (#12170 head)
0d1b0f23b8 feat: advisor usage windows in cost segment       (#8904 1/4)
50b722c138 feat: two-line statusbar overflow                 (#8904 2/4)
341454a2a1 fix: gallery fixture advisorUsage                 (#8904 3/4)
b087285932 fix: clamp the overflow row                       (#8904 4/4)
2caad4a07b fix: repair advisor fixture + ctor stubs          (#8904 repair)
d9ff773d2a fix(sharpshooter): idempotent enrollment          (#12161 tail 1/3)
b1d0376e6d fix(sharpshooter): carry queued prompts           (#12161 tail 2/3)
3be016a3de docs(changelog): notes to Unreleased              (#12161 tail 3/3)
7cd9b33b18 chore: ignore .watch/                             (fork hygiene)
EOF
}

# The sharpshooter PAIRING trunk (#12161 core) is fork-only until upstream merges
# the PR; it cannot be expressed as plain cherry-picks (its 30 commits were
# conflict-stitched). After the picks, apply the trunk from the current PR head
# 9a9532563b (re-check `gh pr view 12161 --json headRefOid` first; update if it
# moved). When can1357 merges #12161, DELETE trunk_apply and the trunk step.
trunk_apply() {
	git checkout 9a9532563b -- \
		packages/coding-agent/src/memory-backend/with-sharpshooter.ts \
		packages/coding-agent/src/memory-backend/types.ts \
		packages/coding-agent/src/memory-backend/resolve.ts \
		packages/coding-agent/src/memory-backend/runtime.ts \
		packages/coding-agent/src/session/session-memory.ts \
		packages/coding-agent/src/hindsight/backend.ts \
		packages/coding-agent/src/sharpshooter/consolidate.ts \
		packages/coding-agent/test/sharpshooter-extract.test.ts \
		packages/coding-agent/test/sharpshooter-backend.test.ts \
		packages/coding-agent/test/sharpshooter-consolidate.test.ts \
		packages/coding-agent/test/sharpshooter-pairing.test.ts \
		packages/coding-agent/test/agent-session-memory-backend.test.ts
	# side-effects applier lacks a 12161 home; committed trunk copy carries it.
	# Hand-fixes the trunk needs (see SKILL omp-fork-sync-cherry-pick):
	#   settings-schema.ts sharpshooter.enabled block,
	#   selector-controller.ts sharpshooter.enabled case,
	#   agent-session.ts applyPairedMemoryBackend,
	#   event-controller.ts refreshIdleRecapTimer hook,
	#   hindsight-backend.test.ts applyPairedMemoryBackend stub.
	say "pairing trunk applied from 9a9532563b"
}

if (( DRY )); then
	say "== dry plan =="
	say "git checkout -B sync-fork-main $UPSTREAM"
	pr_commits | awk '{print "git cherry-pick " $1}'
	say "git push origin +sync-fork-main:main --force-with-lease=main:$ORIGIN  # only if main moved past a merge; else plain push"
	exit 0
fi

step() { say "== $1 =="; }

step "reset sync branch onto upstream/main"
git branch -D sync-fork-main >/dev/null 2>&1 || true
git checkout -q -B sync-fork-main "$UPSTREAM"

step "cherry-pick fork PR commits"
while read -r line; do
	sha="$(printf '%s' "$line" | awk '{print $1}')"
	[[ -z "$sha" ]] && continue
	say "cherry-pick $sha  ${line#* }"
	if ! git cherry-pick "$sha" >/dev/null 2>&1; then
		if git diff --quiet; then
			say "  -> empty pick (already on upstream), skipping"
			git cherry-pick --skip >/dev/null 2>&1 || git cherry-pick --abort >/dev/null 2>&1 || true
		else
			die "conflict on $sha. resolve in $(pwd), then: git cherry-pick --continue && rerun with remaining shas"
		fi
	fi
done < <(pr_commits)

step "pairing trunk"
if ! git show "$UPSTREAM":packages/coding-agent/src/memory-backend/with-sharpshooter.ts >/dev/null 2>&1; then
	trunk_apply
	git add packages/coding-agent
	git commit --quiet -m "feat(coding-agent): sharpshooter pairing trunk + memory-backend reason wiring" || true
fi

step "sanitize trailers"
# Strip any fork provenance trailers accidentally carried; keep real authorship.
git filter-branch --msg-filter 'sed "/^[Cc]herry picked from/d; /^Rebased from/d"' \
	-- "$UPSTREAM..HEAD" >/dev/null 2>&1 || true

step "result"
git log --oneline "$UPSTREAM"..HEAD | cat
COUNT="$(git rev-list --count "$UPSTREAM"..HEAD)"
say "fork main = upstream/main + $COUNT commits"

if (( NO_PUSH )); then
	say "no-push: branch sync-fork-main ready; push with:"
	say "  git push origin +sync-fork-main:main --force-with-lease=main:$ORIGIN"
	exit 0
fi

step "push"
# Prefer fast-forward; force-with-lease only when necessary.
if git merge-base --is-ancestor "$ORIGIN" HEAD; then
	git push origin HEAD:main
else
	say "non-ff: lease push (this is expected only when cherry-picked shas replaced squashed content)"
	git push origin +HEAD:main --force-with-lease=main:"$ORIGIN"
fi
NEW_ORIGIN="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
say "origin/main = $NEW_ORIGIN"
