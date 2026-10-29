#!/usr/bin/env bash
# sync-fork-main.sh — rebuild fork main as upstream/main plus one squashed layer per open PR.
#
# Fork main = upstream/main
#           + "layer #N: <title>" for each open PR, oldest first (git merge --squash of its head)
#           + the fork-local commits carried over from the current fork main (every commit
#             that is not a layer: .gitignore tweaks, this script, docs drafts).
#
# Every PR must apply to upstream alone. Run --check first: it real-merges each PR head onto
# upstream/main and lists the ones that conflict. Rebase those onto upstream/main and
# force-with-lease their PR branches, then build.
#
# Usage:
#   scripts/sync-fork-main.sh --check     # report which PRs conflict with upstream/main
#   scripts/sync-fork-main.sh             # build, bun check, lease-push fork main
#   scripts/sync-fork-main.sh --no-push   # build and bun check, leave the push to you
#   scripts/sync-fork-main.sh --no-check  # skip bun check
#   scripts/sync-fork-main.sh --resume    # continue after resolving a layer conflict by hand
#
# A conflict between two PRs stops the build in the worktree it prints. Resolve the files,
# `git add` them, commit as "layer #N: <title>", then rerun with --resume. Keep rerere on
# (rerere.enabled, rerere.autoupdate): the resolution replays on the next cycle.
#
# Talks to github.com, so run it outside the agent sandbox.
set -euo pipefail

UPSTREAM_REPO="can1357/oh-my-pi"
AUTHOR="STRML"
# Other people's open PRs we also layer onto fork main. Drop a number once it merges.
EXTRA_PRS=(16726)

CHECK_ONLY=0; RESUME=0; NO_PUSH=0; NO_CHECK=0
for arg in "$@"; do
	case "$arg" in
		--check) CHECK_ONLY=1;;
		--resume) RESUME=1;;
		--no-push) NO_PUSH=1;;
		--no-check) NO_CHECK=1;;
		*) printf 'unknown option: %s\n' "$arg" >&2; exit 1;;
	esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# The main checkout, even when this runs from a worktree, so the build worktree never nests.
ROOT="$(dirname -- "$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)")"
WT="$ROOT/.claude/worktrees/sync-fork-main"
BRANCH="sync-fork-main"

# Files left conflicted after a merge: unmerged paths plus staged files still holding markers.
# rerere.autoupdate stages its replayed resolutions, so a failed merge can leave nothing here.
unresolved() {
	{
		git diff --name-only --diff-filter=U
		git diff --cached --name-only -z | xargs -0 grep -l '^<<<<<<< ' 2>/dev/null || true
	} | sort -u
}

# Writes "<number>\t<title>" for every PR to layer, oldest first.
list_prs() {
	{
		gh pr list -R "$UPSTREAM_REPO" --author "$AUTHOR" --state open --limit 200 \
			--json number,title --jq '.[] | "\(.number)\t\(.title)"'
		for n in "${EXTRA_PRS[@]}"; do
			gh pr view "$n" -R "$UPSTREAM_REPO" --json number,title,state \
				--jq 'select(.state == "OPEN") | "\(.number)\t\(.title)"'
		done
	} | sort -n -u -k1,1
}

fetch_prs() {
	local refspecs=() n
	while IFS=$'\t' read -r -u 3 n _; do refspecs+=("pull/$n/head:refs/pr/$n"); done 3< "$PRS"
	git fetch -q --force upstream "${refspecs[@]}"
}

check_prs() {
	local bad=0 n left
	while IFS=$'\t' read -r -u 3 n _; do
		git checkout -q --detach "$UPSTREAM"
		if git merge -q --no-ff --no-edit "refs/pr/$n" >/dev/null 2>&1; then
			say "ok        #$n"
		else
			left="$(unresolved | tr '\n' ' ')"
			if [[ -n "$left" ]]; then say "CONFLICT  #$n: $left"; bad=1; else say "rerere    #$n"; fi
		fi
		git merge --abort >/dev/null 2>&1 || true
		git reset -q --hard "$UPSTREAM"
	done 3< "$PRS"
	return "$bad"
}

# A captured list, not a `grep -q` pipe: under pipefail an early grep exit SIGPIPEs git log.
has_subject() {
	local subjects
	subjects="$(git log --format=%s "$UPSTREAM..HEAD")"
	[[ $'\n'"$subjects"$'\n' == *$'\n'"$1"$'\n'* ]]
}

layer() {
	local n="$1" title="$2" subject="layer #$1: $2"
	if has_subject "$subject"; then say "have      #$n"; return; fi
	if ! git merge --squash -q "refs/pr/$n" >/dev/null 2>&1; then
		local left; left="$(unresolved)"
		if [[ -n "$left" ]]; then
			say "CONFLICT  #$n in $WT:"; say "$left"
			die "resolve, git add, git commit -m \"$subject\", then rerun with --resume"
		fi
		say "rerere    #$n"
	fi
	if git diff --cached --quiet; then say "empty     #$n (already upstream?)"; return; fi
	git commit -q --no-verify -m "$subject"
	say "layered   #$n"
}

# Fork-local commits: everything on the old fork main past its upstream base that is not a layer.
carry_local() {
	local base sha subject
	base="$(git merge-base "$ORIGIN" "$UPSTREAM")"
	while read -r -u 3 sha subject; do
		[[ "$subject" == "layer #"* ]] && continue
		if has_subject "$subject"; then say "have      $subject"; continue; fi
		git cherry-pick "$sha" >/dev/null || die "carry of $sha ($subject) conflicted in $WT; resolve, git cherry-pick --continue, rerun with --resume"
		say "carried   $subject"
	done 3< <(git log --reverse --format='%H %s' "$base..$ORIGIN")
}

say "== fetch =="
git -C "$ROOT" fetch -q origin main
git -C "$ROOT" fetch -q upstream main

if [[ ! -d "$WT" ]]; then
	git -C "$ROOT" worktree add -q --detach "$WT" upstream/main
fi
cd "$WT"
STATE="$(git rev-parse --git-path sync-fork-main.state)"
PRS="$(git rev-parse --git-path sync-fork-main.prs)"

if (( RESUME )); then
	[[ -f "$STATE" ]] || die "no saved run to resume"
	# shellcheck source=/dev/null
	source "$STATE"
	[[ "$(git branch --show-current)" == "$BRANCH" ]] || die "$WT is not on $BRANCH"
	[[ -z "$(unresolved)" ]] || die "unresolved files remain in $WT"
else
	# The worktree belongs to this script: drop whatever an abandoned run left behind.
	git merge --abort >/dev/null 2>&1 || true
	git cherry-pick --abort >/dev/null 2>&1 || true
	git reset -q --hard
	UPSTREAM="$(git rev-parse upstream/main)"
	ORIGIN="$(git rev-parse origin/main)"
	printf 'UPSTREAM=%s\nORIGIN=%s\n' "$UPSTREAM" "$ORIGIN" > "$STATE"
	list_prs > "$PRS"
	fetch_prs
fi
say "upstream/main = $UPSTREAM"
say "origin/main   = $ORIGIN"
say "PRs: $(cut -f1 "$PRS" | tr '\n' ' ')"

if (( CHECK_ONLY )); then
	say "== check PRs against upstream/main =="
	check_prs || die "rebase the conflicting PRs onto upstream/main and lease-push them, then rerun"
	exit 0
fi

if (( ! RESUME )); then
	say "== reset $BRANCH onto upstream/main =="
	git checkout -q -B "$BRANCH" "$UPSTREAM"
fi

say "== layers =="
while IFS=$'\t' read -r -u 3 n title; do layer "$n" "$title"; done 3< "$PRS"

say "== fork-local commits =="
carry_local

say "== result =="
git log --oneline "$UPSTREAM..HEAD" | cat

if (( ! NO_CHECK )); then
	say "== bun check =="
	bun install --frozen-lockfile >/dev/null
	bun check
fi

if (( NO_PUSH )); then
	say "push with: git -C $WT push origin HEAD:refs/heads/main --force-with-lease=refs/heads/main:$ORIGIN"
	exit 0
fi

say "== push =="
git push origin HEAD:refs/heads/main --force-with-lease=refs/heads/main:"$ORIGIN"
say "origin/main = $(git ls-remote origin refs/heads/main | cut -f1)"
