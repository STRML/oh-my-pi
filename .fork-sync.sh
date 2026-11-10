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
	# TypeScript only: upstream's own crates can fail clippy on this toolchain (pi-shell's
	# many_single_char_names, 2026-11-04) while compiling fine. No layer touches crates/, and
	# fork_install's native build still stops on a real Rust error.
	bun run check:ts
}

# The native addon is the sync's only rustc work: about four minutes of every-core heat. Its Latch
# queue runs that on the Studio instead, when a slot is free right now. Otherwise this Mac builds.
NATIVE_MEMORY_MIB=12288
NATIVE_CPU_CORES=8

# Latch is the Studio's job queue (v0.18 on studio1). `latch schedule` is foreground: it admits the
# job when the machine and the reservations allow it, runs the command, and exits with its status.
# It is submitted in batch mode, because builds may overlap ordinary work; isolated waits for a
# quiet window the sync does not need. Never pass --gpu there: the Studios idle at 2-6% with the
# live server loaded, and Latch admits a GPU job only under 2%.
#
# Returns 1 without doing anything when no slot is free now (a queued job, an isolated task, or too
# little memory headroom) or when the build fails, leaving the caller to build locally.

# The ssh config for `studio1` probes the LAN and then dials the tailnet, and that probe fails
# intermittently (mDNS), so address the first name that answers directly.
studio_host() {
	if [[ -n "${STUDIO_SSH_HOST:-}" ]]; then printf '%s\n' "$STUDIO_SSH_HOST"; return 0; fi
	local h
	for h in studio1.local studio studio1; do
		# -n: a probe must not eat the heredoc its caller is about to send.
		if ssh -n -o ConnectTimeout=5 -o BatchMode=yes "$h" true >/dev/null 2>&1; then
			STUDIO_SSH_HOST="$h"
			printf '%s\n' "$h"
			return 0
		fi
	done
	return 1
}

# Copies stdin to a file on the Studio: the only payload path, because a remote `bash -s` has
# already spent stdin on the script and a command pipeline hands its last stage the pipe.
studio_put() {
	local h
	h="$(studio_host)" || return 1
	ssh -o ConnectTimeout=10 -o BatchMode=yes "$h" 'mkdir -p "$HOME/.cache" && cat > "$HOME/.cache/fork-sync-payload"'
}

# Runs the script on stdin, or the command in "$@", on the Studio.
studio_run() {
	local h
	h="$(studio_host)" || return 1
	if [[ $# -gt 0 ]]; then
		printf '%s\n' "$*" | ssh -o ConnectTimeout=10 -o BatchMode=yes "$h" 'bash -s'
	else
		ssh -o ConnectTimeout=10 -o BatchMode=yes "$h" 'bash -s'
	fi
}

latch_studio_native_build() {
	local slot tree
	# The tree being installed (usually the sync worktree), never the primary checkout.
	tree="$(pwd)"
	slot="$(studio_run 'export PATH="$HOME/.local/bin:$PATH"; latch view --json' 2>/dev/null)" || return 1
	printf '%s' "$slot" | python3 -c '
import json, sys
view = json.load(sys.stdin)
capacity = view.get("capacity", {})
ok = not view.get("jobs") and not view.get("isolatedTaskRunning")
ok = ok and capacity.get("memoryHeadroomMiB", 0) >= '"$NATIVE_MEMORY_MIB"'
sys.exit(0 if ok else 1)' || {
		echo "no Latch slot free on the Studio right now: building the native addon here"
		return 1
	}
	echo "== build the native addon on the Studio through Latch =="
	if ! studio_run <<-EOF
		set -euo pipefail
		export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:\$HOME/.cargo/bin:/opt/homebrew/bin:\$PATH"
		dir="\$HOME/git/forks/omp"
		[[ -d "\$dir/.git" ]] || git clone -q "$(git -C "$tree" remote get-url origin)" "\$dir"
		# A worktree of its own: the install worktree may hold a build's generated declarations.
		wt="\$dir/.claude/worktrees/latch-native-build"
		git -C "\$dir" fetch -q origin main
		[[ -d "\$wt" ]] || git -C "\$dir" worktree add -q --detach "\$wt" origin/main
		cd "\$wt"
		git checkout -q -f --detach origin/main
		if ! bun install --frozen-lockfile >/dev/null 2>&1; then bun install >/dev/null; git checkout -- bun.lock; fi
		latch schedule --name omp-native-build --mode batch --cpu $NATIVE_CPU_CORES --memory-mib $NATIVE_MEMORY_MIB \
			--timeout 1800 -- /bin/bash -c 'exec bun run build:native'
	EOF
	then
		echo "STUDIO NATIVE BUILD FAILED: building the native addon here"
		return 1
	fi
	# The addon and its napi declarations are this commit's; gen-enums here rewrites the ESM
	# loader from them, so no rustc runs on this Mac.
	studio_run 'cd "$HOME/git/forks/omp/.claude/worktrees/latch-native-build" && tar -cf - packages/natives/native/pi_natives.darwin-arm64.node packages/natives/native/index.d.ts' \
		| tar -xf - -C "$tree" || return 1
	bun "$tree/packages/natives/scripts/gen-enums.ts" >/dev/null || return 1
	# Same source, same napi: the tracked declarations and loader must come out identical.
	if ! git -C "$tree" diff --quiet -- packages/natives/native/index.d.ts packages/natives/native/index.js; then
		echo "STUDIO NATIVE BUILD generated different declarations: restoring them and building here"
		git -C "$tree" checkout -- packages/natives/native/index.d.ts packages/natives/native/index.js
		return 1
	fi
	echo "native addon built on the Studio"
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
	# Same fallback as fork_check: upstream's bun.lock can trail its catalog.
	if ! bun install --frozen-lockfile >/dev/null 2>&1; then
		bun install >/dev/null
		git checkout -- bun.lock
	fi
	if [[ "${OMP_NATIVE_FROM_STUDIO:-0}" != 1 ]]; then
		bun run build:native
	fi
	bun --cwd=packages/coding-agent run build
	dest="$(command -v omp || printf '%s' "$HOME/.local/bin/omp")"
	if [[ -L "$dest" ]]; then echo "ERROR: $dest is a symlink (dev link?); install packages/coding-agent/dist/omp by hand" >&2; return 1; fi
	cp packages/coding-agent/dist/omp "$dest.new"
	mv -f "$dest.new" "$dest"
	want="omp/$(sed -n 's/^\t"version": "\(.*\)",$/\1/p' packages/coding-agent/package.json)"
	if [[ "$("$dest" --version)" != "$want" ]]; then echo "ERROR: $dest reports $("$dest" --version), expected $want" >&2; return 1; fi
	echo "installed $dest = $want"
}

# Rebuilds here, then on the Studio over ssh (LAN, else tailnet), whose success is its
# "installed" line. Returns 3 if either side failed.
fork_install() {
	local native_from_studio=0
	# The native addon is built on the Studio through its Latch queue when a slot is free now;
	# this Mac's own rustc then stays cold. --no-studio means no Studio at all.
	if ! has_arg --no-studio && latch_studio_native_build; then
		native_from_studio=1
	fi
	OMP_NATIVE_FROM_STUDIO=$native_from_studio omp_build_install || return 3
	has_arg --no-studio && return 0
	echo "== rebuild and install omp on the Studio =="
	local log url shipped=0
	url="$(git remote get-url origin)"
	log="$(mktemp)"
	studio_run <<-EOF 2>&1 | tee "$log" || true
		set -euo pipefail
		export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:\$HOME/.cargo/bin:/opt/homebrew/bin:\$PATH"
		dir="\$HOME/git/forks/omp"
		[[ -d "\$dir/.git" ]] || git clone -q "$url" "\$dir"
		cd "\$dir"
		git fetch -q origin main
		wt="\$dir/.claude/worktrees/sync-fork-main"
		[[ -d "\$wt" ]] || git worktree add -q --detach "\$wt" origin/main
		cd "\$wt"
		git checkout -q -f --detach origin/main
		if ! bun install --frozen-lockfile >/dev/null 2>&1; then bun install >/dev/null; git checkout -- bun.lock; fi
	EOF
	# Same commit, same darwin-arm64 target: the Studio installs this Mac's addon instead of
	# running an unscheduled rustc build that could land inside another session's window.
	if tar -cf - packages/natives/native | studio_put \
		&& studio_run 'cd "$HOME/git/forks/omp/.claude/worktrees/sync-fork-main" && tar -xf "$HOME/.cache/fork-sync-payload" && ls packages/natives/native/pi_natives.darwin-arm64.node >/dev/null'; then
		shipped=1
	else
		echo "could not ship this Mac's addon to the Studio: building one there"
	fi
	studio_run <<-EOF 2>&1 | tee -a "$log" || true
		set -euo pipefail
		export PATH="\$HOME/.local/bin:\$HOME/.bun/bin:\$HOME/.cargo/bin:/opt/homebrew/bin:\$PATH"
		cd "\$HOME/git/forks/omp/.claude/worktrees/sync-fork-main"
		$(declare -f omp_build_install)
		OMP_NATIVE_FROM_STUDIO=$shipped omp_build_install </dev/null
	EOF
	if ! grep -q '^installed .* = omp/' "$log"; then
		echo "STUDIO NOT UPDATED (see output above); rerun: fork-sync.sh --install-only"
		return 3
	fi
}
