#!/usr/bin/env bash
set -euo pipefail

step_label="startup"; allow_main=0; no_build=0
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

die() {
	printf 'ERROR [%s]: %s\n' "$step_label" "$*" >&2
	return 1
}
package_version() {
	local path="$1"
	[[ -f "$path" ]] || { printf '(not present)'; return; }
	node -p "require('./$path').version ?? '(not present)'" 2>/dev/null || printf '(unavailable)'
}
guard_count() {
	local count
	count="$(grep -c 'parsedRetryAfterMs !== undefined && !retryBudgetExhausted' packages/coding-agent/src/session/turn-recovery.ts 2>/dev/null || true)"
	[[ "$count" =~ ^[0-9]+$ ]] || count=0
	printf '%s' "$count"
}
diagnostics() {
	local branch head_sha subject origin_ref upstream_ref origin_relation upstream_relation
	branch="$(git branch --show-current 2>/dev/null || printf '(detached/unknown)')"
	head_sha="$(git rev-parse --short HEAD 2>/dev/null || printf '(unknown)')"
	subject="$(git log -1 --format=%s 2>/dev/null || printf '(unknown)')"
	origin_ref="$(git rev-parse --short origin/main 2>/dev/null || printf '(missing)')"
	upstream_ref="$(git rev-parse --short upstream/main 2>/dev/null || printf '(no upstream)')"
	origin_relation="$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || printf '(unavailable)')"
	upstream_relation="(no upstream)"
	if git rev-parse --verify --quiet upstream/main >/dev/null; then
		upstream_relation="$(git rev-list --left-right --count upstream/main...HEAD 2>/dev/null || printf '(unavailable)')"
	fi
	printf 'STEP=%s\nBRANCH=%s\nHEAD=%s (%s)\nORIGIN_MAIN=%s\nUPSTREAM_MAIN=%s\nORIGIN_MAIN...HEAD=%s\nUPSTREAM_MAIN...HEAD=%s\nGUARD=%s\nVERSION_ROOT=%s\nVERSION_UTILS=%s\n' \
		"$step_label" "$branch" "$head_sha" "$subject" "$origin_ref" "$upstream_ref" \
		"$origin_relation" "$upstream_relation" "$(guard_count)" \
		"$(package_version package.json)" "$(package_version packages/utils/package.json)"
}
failure_handler() {
	local status=$?
	(( status == 0 )) && return
	set +e
	printf '\n=== DIAGNOSTIC BLOCK ===\n'
	diagnostics
	printf 'EXIT_STATUS=%s\n' "$status"
}
trap failure_handler EXIT
for arg in "$@"; do
	case "$arg" in
		--allow-main) allow_main=1;;
		--no-build) no_build=1;;
		*) step_label="parse arguments"; die "unknown option: $arg";;
	esac
done
step_label="determine default branch"
default_ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD)" || die "origin/HEAD is not configured"
default_branch="${default_ref##*/}"
current_branch="$(git branch --show-current)"
if [[ "$current_branch" == "$default_branch" && "$allow_main" -eq 0 ]]; then
	printf 'ERROR: refusing to build from %s: main has NO guard.\n' "$default_branch" >&2
	die "pass --allow-main for a deliberate upstream build"
fi
step_label="fetch origin"; git fetch origin
upstream_exists=0
if git remote get-url upstream >/dev/null 2>&1; then
	upstream_exists=1; step_label="fetch upstream"; git fetch upstream
fi
step_label="check main refs"
git rev-parse --verify --quiet origin/main >/dev/null || die "origin/main is unavailable"
if (( upstream_exists )) && git rev-parse --verify --quiet upstream/main >/dev/null \
	&& git merge-base --is-ancestor origin/main upstream/main \
	&& [[ "$(git rev-parse origin/main)" != "$(git rev-parse upstream/main)" ]]; then
	lag_count="$(git rev-list --count origin/main..upstream/main)"
	printf 'WARNING: origin/main lags upstream/main by %s commit(s); building the fork main as requested.\n' "$lag_count"
fi
step_label="rebase onto origin/main"
if ! git rebase origin/main; then
	printf 'Rebase failed. Resolve the rebase in place, then rerun rebuild.sh.\n' >&2
	exit 1
fi
if (( no_build )); then
	printf '\n=== DRY RUN ===\n'
	diagnostics
	printf 'dry run — build skipped\n'
	exit 0
fi
step_label="clean stale native"
native_version="$(package_version packages/natives/package.json)"
release_version="$(package_version packages/coding-agent/package.json)"
[[ "$native_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$native_version" == "$release_version" ]] ||
	die "native/coding-agent versions disagree (native=$native_version coding-agent=$release_version)"
native_addon="packages/natives/native/pi_natives.darwin-arm64.node"
binary_output="packages/coding-agent/binaries/omp-darwin-arm64"
printf 'clean stale native (%s): %s %s\n' "$native_version" "$native_addon" "$binary_output"
rm -f -- "$native_addon" "$binary_output"
step_label="bun install"; bun install
step_label="build darwin-arm64 native"; bun --cwd=packages/natives run build
step_label="build darwin-arm64 binary"; bun run ci:release:build-binaries --targets=darwin-arm64
step_label="install binary"; mkdir -p "$HOME/.local/bin"
install -m 755 packages/coding-agent/binaries/omp-darwin-arm64 "$HOME/.local/bin/omp"
step_label="report success"; binary_path="$HOME/.local/bin/omp"
printf '\n=== SUCCESS ===\nHEAD=%s\nGUARD=%s\nBINARY=%s\n' "$(git rev-parse HEAD)" "$(guard_count)" "$binary_path"
if version="$("$binary_path" --version 2>/dev/null)"; then
	printf 'OMP_VERSION=%s\n' "$version"
else
	printf 'OMP_VERSION=(failed to run)\n'
fi
