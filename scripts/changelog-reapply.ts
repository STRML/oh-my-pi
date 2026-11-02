#!/usr/bin/env bun
/**
 * Resolves a rebase stop whose only conflicts are `## [Unreleased]` entries in CHANGELOG.md files.
 *
 * Every PR adds its entry at the top of an Unreleased section, so two PRs touching the same section
 * always conflict, though neither changes the other's lines. This takes the upstream side of each
 * conflicted changelog (HEAD during a rebase) and re-inserts the lines the replayed commit added
 * (REBASE_HEAD) at the top of the same `###` section, creating the section if upstream lacks it.
 *
 *   bun scripts/changelog-reapply.ts <conflicted CHANGELOG.md>...
 *
 * Exits 1 without touching anything when a commit changed a changelog line outside Unreleased or
 * removed one: those are not mechanical, so the caller stops for a human.
 */
import * as fs from "node:fs";

const UNRELEASED = "## [Unreleased]";

export interface AddedEntry {
	section: string;
	line: string;
}

/** Lines `after` adds to the Unreleased block of `before`, each with its `###` section; null if it does more. */
export function unreleasedAdditions(before: string, after: string): AddedEntry[] | null {
	const oldLines = new Set(unreleasedBlock(before));
	const newBlock = unreleasedBlock(after);
	const newLines = new Set(newBlock);
	for (const line of oldLines) if (!newLines.has(line)) return null;
	if (outsideUnreleased(before) !== outsideUnreleased(after)) return null;
	const added: AddedEntry[] = [];
	let section = "";
	for (const line of newBlock) {
		if (line.startsWith("### ")) section = line;
		else if (!oldLines.has(line) && line.trim() !== "") added.push({ section, line });
	}
	return added;
}

/** `text` with each entry placed first in its Unreleased section (entries keep their order). */
export function insertEntries(text: string, entries: AddedEntry[]): string {
	const lines = text.split("\n");
	const start = lines.indexOf(UNRELEASED);
	if (start < 0) throw new Error("no ## [Unreleased] section");
	for (const { section, line } of [...entries].reverse()) {
		if (lines.includes(line)) continue;
		const end = blockEnd(lines, start);
		let at = lines.indexOf(section, start);
		if (at < 0 || at >= end) {
			// Upstream has no such section yet: add it at the end of the Unreleased block.
			lines.splice(end, 0, section, "", line, "");
			continue;
		}
		// First entry line of the section (skip the blank line after the heading).
		at += 1;
		while (at < end && lines[at].trim() === "") at++;
		lines.splice(at, 0, line);
	}
	return lines.join("\n");
}

function blockEnd(lines: string[], start: number): number {
	for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith("## ")) return i;
	return lines.length;
}

function unreleasedBlock(text: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(UNRELEASED);
	if (start < 0) return [];
	return lines.slice(start + 1, blockEnd(lines, start));
}

function outsideUnreleased(text: string): string {
	const lines = text.split("\n");
	const start = lines.indexOf(UNRELEASED);
	if (start < 0) return text;
	return [...lines.slice(0, start), ...lines.slice(blockEnd(lines, start))].join("\n");
}

function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function main(files: string[]): number {
	const resolved: Array<[string, string]> = [];
	for (const file of files) {
		const added = unreleasedAdditions(git("show", `REBASE_HEAD~1:${file}`), git("show", `REBASE_HEAD:${file}`));
		if (added === null) {
			console.error(`${file}: the commit changes more than Unreleased additions; resolve it by hand`);
			return 1;
		}
		resolved.push([file, insertEntries(git("show", `HEAD:${file}`), added)]);
	}
	for (const [file, text] of resolved) {
		fs.writeFileSync(file, text);
		git("add", file);
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
