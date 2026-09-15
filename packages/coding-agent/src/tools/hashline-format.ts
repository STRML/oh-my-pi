import {
	hashlineFileHash,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
	hashlineStripPrefixes,
} from "@oh-my-pi/pi-natives";

export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";
export const HL_FILE_HASH_SEP = "#";
export const HL_FILE_HASH_LENGTH = 4;
export const HL_MOVE_KEYWORD = "MV";
export const HL_REM_KEYWORD = "REM";
export const HL_LINE_BODY_SEP = ":";

export function formatHashlineHeader(path: string, tag: string): string {
	return hashlineFormatHeader(path, tag);
}

export function formatNumberedLines(text: string, startLine?: number): string {
	return hashlineFormatNumberedLines(text, startLine);
}

export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function stripHashlinePrefixes(lines: string[]): string[] {
	return hashlineStripPrefixes(lines);
}

/**
 * Whether a row is a truncation notice emitted by `read`.
 *
 * Pure TS port of `crates/pi-edit/src/modes/hashline/prefixes.rs::is_read_truncation_notice`.
 * Kept in TS rather than round-tripping through a native export: PR CI tests
 * against the latest published `@oh-my-pi/pi-natives` release rather than a
 * source build (native changes are validated post-merge on main and at
 * release), so a brand-new napi export used the same PR it lands in breaks
 * every PR's tests until the next release is cut. This check is cheap,
 * allocation-free string matching with no native-only capability, so it
 * doesn't need the native boundary at all.
 */
export function isReadTruncationNotice(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
	const body = trimmed.slice(1, -1);
	const showingNotice =
		body.startsWith("Showing ") &&
		(body.includes(" line") || body.includes("lines ") || body.includes("bytes ")) &&
		(body.includes(" of ") || body.includes(" elided"));
	const moreLineSplitIndex = body.indexOf(" more line");
	const moreLineCount = moreLineSplitIndex === -1 ? null : body.slice(0, moreLineSplitIndex);
	const moreNotice =
		(body.startsWith("More lines in ") || (moreLineCount !== null && /^\d+$/.test(moreLineCount))) &&
		body.includes(" in ") &&
		body.includes(". Use ") &&
		body.endsWith(" to continue");
	const elidedNotice =
		(body.startsWith("…") || body.startsWith("...")) &&
		body.includes("ln elided;") &&
		body.includes("re-read needed ranges");
	const oversizedLineNotice = body.startsWith("Line ") && body.includes(" exceeds ") && body.includes(" limit.");
	return showingNotice || moreNotice || elidedNotice || oversizedLineNotice;
}

export function computeFileHash(text: string): string {
	return hashlineFileHash(text);
}
