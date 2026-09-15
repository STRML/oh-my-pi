import { describe, expect, it } from "bun:test";
import { isReadTruncationNotice } from "@oh-my-pi/pi-coding-agent/tools/hashline-format";

/**
 * `isReadTruncationNotice` is a TS port of
 * `crates/pi-edit/src/modes/hashline/prefixes.rs::is_read_truncation_notice`,
 * which the hashline parser still uses on the Rust side. The corpus below
 * mirrors `read_truncation_notice_covers_emitted_shapes` in
 * `crates/pi-edit/tests/hashline_parse.rs`; keep the two in step when either
 * implementation changes.
 */
const EMITTED_NOTICES = [
	"[Showing lines 1-20 of 60 (50.0KB limit). Use :21 to continue]",
	"[Showing last 50.0KB across lines 4-8 of 8; line 4 is partial]",
	"[40 more lines in notebook. Use :21 to continue]",
	"[More lines in file (1.2MB total; not scanned to EOF). Use :21 to continue]",
	"[...30ln elided; re-read needed ranges, e.g. a.ts:5-16,40-80]",
	"[Line 1 is 60.0KB, exceeds 50.0KB limit. Hashline output requires full lines; cannot emit an editable numbered preview for a truncated line.]",
];

describe("isReadTruncationNotice", () => {
	it.each(EMITTED_NOTICES)("recognizes the notice %p that read emits", notice => {
		expect(isReadTruncationNotice(notice)).toBe(true);
	});

	it("leaves a paginated listing alone", () => {
		expect(isReadTruncationNotice("[Showing files 1-20 of 60. Use skip=20 for the next page]")).toBe(false);
	});

	// The count in a `N more lines` notice is read with `parse::<usize>()` in
	// Rust. These two cases are where a bare `/^\d+$/` disagrees with it, and
	// getting them wrong silently rejects a user's write as an incomplete read
	// projection.
	it("rejects a count that overflows usize, as parse::<usize>() does", () => {
		expect(isReadTruncationNotice("[18446744073709551616 more lines in file. Use :21 to continue]")).toBe(false);
		expect(isReadTruncationNotice("[18446744073709551615 more lines in file. Use :21 to continue]")).toBe(true);
	});

	it("accepts a leading plus on the count, as parse::<usize>() does", () => {
		expect(isReadTruncationNotice("[+40 more lines in file. Use :21 to continue]")).toBe(true);
	});

	it("rejects a non-numeric count", () => {
		expect(isReadTruncationNotice("[some more lines in file. Use :21 to continue]")).toBe(false);
		expect(isReadTruncationNotice("[ 40 more lines in file. Use :21 to continue]")).toBe(false);
	});
});
