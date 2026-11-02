import { describe, expect, it } from "bun:test";
import { insertEntries, unreleasedAdditions } from "./changelog-reapply";

const base = `# Changelog

## [Unreleased]

### Fixed

- old fix

## [1.0.0] - 2026-11-01

### Added

- shipped
`;

describe("changelog-reapply", () => {
	it("re-inserts a PR's entry on top of upstream's newer entries in the same section", () => {
		const pr = base.replace("- old fix", "- my fix\n- old fix");
		const upstream = base.replace("- old fix", "- their fix\n- old fix");
		const added = unreleasedAdditions(base, pr);
		expect(added).toEqual([{ section: "### Fixed", line: "- my fix" }]);
		expect(insertEntries(upstream, added ?? [])).toBe(base.replace("- old fix", "- my fix\n- their fix\n- old fix"));
	});

	it("creates the section when upstream's Unreleased block lacks it", () => {
		const pr = base.replace("### Fixed", "### Added\n\n- my feature\n\n### Fixed");
		const upstream = base.replace("### Fixed\n\n- old fix\n\n", "");
		const out = insertEntries(upstream, unreleasedAdditions(base, pr) ?? []);
		expect(out).toContain("## [Unreleased]\n\n### Added\n\n- my feature\n\n## [1.0.0]");
	});

	it("does not duplicate an entry upstream already carries", () => {
		const pr = base.replace("- old fix", "- my fix\n- old fix");
		expect(insertEntries(pr, unreleasedAdditions(base, pr) ?? [])).toBe(pr);
	});

	it("refuses a commit that edits a released section or removes an Unreleased line", () => {
		expect(unreleasedAdditions(base, base.replace("- shipped", "- shipped, edited"))).toBeNull();
		expect(unreleasedAdditions(base, base.replace("- old fix\n", ""))).toBeNull();
	});
});
