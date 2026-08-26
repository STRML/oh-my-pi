#!/usr/bin/env bash
set -euo pipefail

# Restore the caller's starting branch on every exit path, so running this
# script never leaves the user on the default branch.
start_branch="$(git branch --show-current)"
restore() {
	[[ -n "$start_branch" ]] && git switch --quiet "$start_branch" 2>/dev/null || true
}
trap restore EXIT

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

default_ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
if [[ -z "$default_ref" ]]; then
	echo "refresh-omp-main: origin/HEAD is not configured" >&2
	exit 1
fi
default_branch="${default_ref#origin/}"
if ! git rev-parse --verify --quiet "refs/heads/$default_branch" >/dev/null; then
	echo "refresh-omp-main: local branch $default_branch does not exist" >&2
	exit 1
fi

git fetch upstream
git fetch origin
git switch "$default_branch"
git merge --ff-only upstream/main

sha="$(git rev-parse "$default_branch")"
subject="$(git log -1 --format=%s "$default_branch")"
printf 'main synced to %s (%s)\n' "$sha" "$subject"

git for-each-ref --format='%(refname:short)' refs/heads | while IFS= read -r b; do
	printf "%-40s " "$b"
	git rev-list --left-right --count "$default_branch...$b"
done
