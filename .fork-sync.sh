# Config for ~/.claude/scripts/fork-sync.sh (the fork-sync skill). Sourced by bash.
# Fork main = can1357/oh-my-pi main + one layer per open STRML PR + the fork-local commits.
UPSTREAM_REPO="can1357/oh-my-pi"
AUTHOR="STRML"
# Other people's open PRs we also layer onto fork main. Drop a number once it merges.
EXTRA_PRS=(16726)
PR_UPDATE="rebase"

# Two PRs adding entries to one Unreleased section always conflict; re-add ours on top of upstream's.
fork_rebase_fixup() {
	local f
	for f in "$@"; do [[ "$f" == *CHANGELOG.md ]] || return 0; done
	bun "$ROOT/scripts/changelog-reapply.ts" "$@"
}

fork_check() {
	# Upstream's bun.lock can trail its package catalog for a while (2026-11-04), and a frozen
	# install refuses then. Fall back to a normal install and put the lockfile back, so the tree
	# the sync pushes is exactly the layered one.
	if ! bun install --frozen-lockfile >/dev/null 2>&1; then
		bun install >/dev/null
		git checkout -- bun.lock
	fi
	bun check
}

# Builds the native addon and the binary in the current checkout and swaps it onto PATH through a
# new file: copying over the old inode leaves macOS holding its cached signature (Killed: 9).
# Self-contained, because it is also shipped to the Studio with `declare -f`.
omp_build_install() {
	local need have dest want
	need="$(sed -n 's/.*"bun": ">=\([0-9.]*\)".*/\1/p' packages/coding-agent/package.json)"
	have="$(bun --version)"
	if [[ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]]; then
		echo "bun $have < $need: upgrading"
		bun upgrade >/dev/null
	fi
	bun install --frozen-lockfile >/dev/null
	bun run build:native
	bun --cwd=packages/coding-agent run build
	dest="$(command -v omp || printf '%s' "$HOME/.local/bin/omp")"
	if [[ -L "$dest" ]]; then echo "ERROR: $dest is a symlink (dev link?); install packages/coding-agent/dist/omp by hand" >&2; return 1; fi
	cp packages/coding-agent/dist/omp "$dest.new"
	mv -f "$dest.new" "$dest"
	want="omp/$(sed -n 's/^\t"version": "\(.*\)",$/\1/p' packages/coding-agent/package.json)"
	if [[ "$("$dest" --version)" != "$want" ]]; then echo "ERROR: $dest reports $("$dest" --version), expected $want" >&2; return 1; fi
	echo "installed $dest = $want"
}

# Rebuilds here, then on the Studio through studio-sh (LAN or tailnet). Tailscale SSH always
# exits 0, so the Studio's success is its "installed" line. Returns 3 if either side failed.
fork_install() {
	omp_build_install || return 3
	has_arg --no-studio && return 0
	echo "== rebuild and install omp on the Studio =="
	local log url
	url="$(git -C "$ROOT" remote get-url origin)"
	log="$(mktemp)"
	studio-sh <<-EOF 2>&1 | tee "$log" || true
		set -euo pipefail
		export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:\$HOME/.cargo/bin:/opt/homebrew/bin:\$PATH"
		dir="\$HOME/git/forks/omp"
		[[ -d "\$dir/.git" ]] || git clone -q "$url" "\$dir"
		cd "\$dir"
		git fetch -q origin main
		wt="\$dir/.claude/worktrees/sync-fork-main"
		[[ -d "\$wt" ]] || git worktree add -q --detach "\$wt" origin/main
		cd "\$wt"
		git checkout -q --detach origin/main
		$(declare -f omp_build_install)
		omp_build_install </dev/null
	EOF
	if ! grep -q '^installed .* = omp/' "$log"; then
		echo "STUDIO NOT UPDATED (see output above); rerun: fork-sync.sh --install-only"
		return 3
	fi
}
