#!/usr/bin/env bash
# sync-fork-main.sh — rebuild fork main as upstream/main plus one squashed layer per open PR.
#
# Fork main = upstream/main
#           + "layer #N: <title>" for each open PR, oldest first (git merge --squash of its head)
#           + the fork-local commits carried over from the current fork main (every commit
#             that is not a layer: .gitignore tweaks, this script, docs drafts).
#
# Every PR must apply to upstream alone, so GitHub sees it as mergeable. A plain run rebases
# each $AUTHOR PR that conflicts with upstream/main (rerere replays known resolutions), layers
# the rebased head, and after bun check lease-pushes the PR branch along with fork main.
# A rebase that hits a new conflict stops the run: rebase that PR by hand, push it, rerun.
# Other people's PRs are never rebased; they must merge cleanly or through rerere.
#
# Usage:
#   scripts/sync-fork-main.sh --check     # report which PRs conflict and whether they rebase
#   scripts/sync-fork-main.sh             # rebase, build, bun check, lease-push main + PRs
#   scripts/sync-fork-main.sh --no-push   # same, leave the pushes to you
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

# Writes "<number>\t<head owner>\t<head branch>\t<title>" for every PR to layer, oldest first.
list_prs() {
	local fields='"\(.number)\t\(.headRepositoryOwner.login)\t\(.headRefName)\t\(.title)"'
	{
		gh pr list -R "$UPSTREAM_REPO" --author "$AUTHOR" --state open --limit 200 \
			--json number,headRepositoryOwner,headRefName,title --jq ".[] | $fields"
		for n in "${EXTRA_PRS[@]}"; do
			gh pr view "$n" -R "$UPSTREAM_REPO" --json number,headRepositoryOwner,headRefName,title,state \
				--jq "select(.state == \"OPEN\") | $fields"
		done
	} | sort -n -u -k1,1
}

fetch_prs() {
	local refspecs=() n
	while IFS=$'\t' read -r -u 3 n _; do refspecs+=("pull/$n/head:refs/pr/$n"); done 3< "$PRS"
	git fetch -q --force upstream "${refspecs[@]}"
}

# GitHub's view: does the PR head merge onto upstream/main with no help from rerere?
# Prints the merged tree when it does.
merges_clean() {
	local out
	out="$(git merge-tree --write-tree "$UPSTREAM" "refs/pr/$1")" || return 1
	printf '%s\n' "${out%%$'\n'*}"
}

# Files where a merge or rebase result <tree> changed more than the PR itself does, plus
# CHANGELOGs that gained released "## [x.y.z]" sections. Both mean git resurrected text that
# upstream deleted: in 2026-10 a "clean" rebase put 865 archived CHANGELOG lines back.
suspect() {
	local pr="$1" tree="$2" mb f
	mb="$(git merge-base "$UPSTREAM" "$pr")"
	join -t $'\t' -a2 -e0 -o 0,1.2,2.2 \
		<(git diff --numstat "$mb" "$pr" | awk -F'\t' '{print $3 "\t" $1 + $2}' | sort) \
		<(git diff --numstat "$UPSTREAM" "$tree" | awk -F'\t' '{print $3 "\t" $1 + $2}' | sort) |
		awk -F'\t' '$3 > $2 + 20 {print $1}'
	while read -r f; do
		if (( $(git show "$tree:$f" | grep -c '^## \[[0-9]' || true) > $(git show "$UPSTREAM:$f" | grep -c '^## \[[0-9]' || true) )); then
			printf '%s\n' "$f"
		fi
	done < <(git diff --name-only --diff-filter=M "$UPSTREAM" "$tree" -- '*CHANGELOG.md')
}

# Rebases refs/pr/N onto upstream/main in the worktree, continuing through every stop that
# rerere fully resolved. Leaves the rebased head checked out (detached) on success; aborts
# and returns 1 on a conflict rerere does not know.
rebase_pr() {
	local n="$1" stops=0
	git checkout -q --detach "refs/pr/$n"
	git rebase -q "$UPSTREAM" >/dev/null 2>&1 && return 0
	while [[ -d "$(git rev-parse --git-path rebase-merge)" ]]; do
		if [[ -n "$(unresolved)" ]] || (( ++stops > 200 )); then
			git rebase --abort >/dev/null 2>&1
			return 1
		fi
		# A commit the resolution emptied cannot be continued, only skipped.
		if git diff --cached --quiet; then
			git rebase --skip >/dev/null 2>&1 || true
		else
			GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 || true
		fi
	done
}

# One line per PR. With "apply", rebases the conflicting $AUTHOR PRs for real: refs/pr/N moves
# to the rebased head and "<number>\t<branch>\t<old head>\t<new head>" goes to $REBASED.
check_prs() {
	local mode="${1:-report}" bad=0 n owner branch old left tree bogus
	while IFS=$'\t' read -r -u 3 n owner branch _; do
		if tree="$(merges_clean "$n")"; then
			bogus="$(suspect "refs/pr/$n" "$tree" | sort -u | tr '\n' ' ')"
			if [[ -n "$bogus" ]]; then say "SUSPECT   #$n: merge resurrects deleted text in $bogus"; bad=1; else say "ok        #$n"; fi
			continue
		fi
		old="$(git rev-parse "refs/pr/$n")"
		if [[ "$owner" == "$AUTHOR" ]]; then
			if rebase_pr "$n"; then
				bogus="$(suspect "$old" HEAD | sort -u | tr '\n' ' ')"
				if [[ -n "$bogus" ]]; then
					say "SUSPECT   #$n ($branch): rebase resurrects deleted text in $bogus; rebase it by hand"; bad=1
					continue
				fi
				say "rebased   #$n ($branch)"
				if [[ "$mode" == apply ]]; then
					git update-ref "refs/pr/$n" HEAD
					printf '%s\t%s\t%s\t%s\n' "$n" "$branch" "$old" "$(git rev-parse HEAD)" >> "$REBASED"
				fi
			else
				say "CONFLICT  #$n ($branch): rebase it by hand"; bad=1
			fi
			continue
		fi
		# Someone else's branch: we cannot push a rebase, so only rerere can save the layer.
		git checkout -q --detach "$UPSTREAM"
		git merge -q --no-ff --no-edit "refs/pr/$n" >/dev/null 2>&1 || true
		left="$(unresolved | tr '\n' ' ')"
		if [[ -n "$left" ]]; then
			say "CONFLICT  #$n: $left"; bad=1
		elif bogus="$(suspect "refs/pr/$n" "$(git write-tree)" | sort -u | tr '\n' ' ')"; [[ -n "$bogus" ]]; then
			say "SUSPECT   #$n: merge resurrects deleted text in $bogus"; bad=1
		else
			say "rerere    #$n (not ours, stays conflicted on GitHub)"
		fi
		git merge --abort >/dev/null 2>&1 || true
		git reset -q --hard "$UPSTREAM"
	done 3< "$PRS"
	git checkout -q --detach "$UPSTREAM"
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
REBASED="$(git rev-parse --git-path sync-fork-main.rebased)"

if (( RESUME )); then
	[[ -f "$STATE" ]] || die "no saved run to resume"
	# shellcheck source=/dev/null
	source "$STATE"
	[[ "$(git branch --show-current)" == "$BRANCH" ]] || die "$WT is not on $BRANCH"
	[[ -z "$(unresolved)" ]] || die "unresolved files remain in $WT"
else
	# The worktree belongs to this script: drop whatever an abandoned run left behind.
	git merge --abort >/dev/null 2>&1 || true
	git rebase --abort >/dev/null 2>&1 || true
	git cherry-pick --abort >/dev/null 2>&1 || true
	git reset -q --hard
	: > "$REBASED"
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
	check_prs || die "rebase the CONFLICT PRs onto upstream/main by hand and lease-push them, then rerun"
	exit 0
fi

if (( ! RESUME )); then
	say "== rebase PRs that conflict with upstream/main =="
	check_prs apply || die "rebase the CONFLICT PRs onto upstream/main by hand and lease-push them, then rerun"
	say "== reset $BRANCH onto upstream/main =="
	git checkout -q -B "$BRANCH" "$UPSTREAM"
fi

say "== layers =="
while IFS=$'\t' read -r -u 3 n _ _ title; do layer "$n" "$title"; done 3< "$PRS"

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
	say "push with:"
	say "  git -C $WT push origin HEAD:refs/heads/main --force-with-lease=refs/heads/main:$ORIGIN"
	while IFS=$'\t' read -r -u 3 n branch old new; do
		say "  git -C $WT push origin $new:refs/heads/$branch --force-with-lease=refs/heads/$branch:$old  # #$n"
	done 3< "$REBASED"
	exit 0
fi

say "== push =="
git push origin HEAD:refs/heads/main --force-with-lease=refs/heads/main:"$ORIGIN"
say "origin/main = $(git ls-remote origin refs/heads/main | cut -f1)"
# The lease is the head we fetched: a branch someone pushed to since then is left alone.
while IFS=$'\t' read -r -u 3 n branch old new; do
	git push origin "$new:refs/heads/$branch" --force-with-lease="refs/heads/$branch:$old"
	say "#$n $branch = $new"
done 3< "$REBASED"
