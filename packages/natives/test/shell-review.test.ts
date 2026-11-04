import { expect, it } from "bun:test";
import { Shell } from "../native/index.js";

it("rejects malformed state or file hashes before running a shell command", async () => {
	for (const expectState of [
		{ state: "bad", files: [] },
		{ state: "0".repeat(64), files: [{ path: "/tmp/missing", sha256: "bad" }] },
	]) {
		const shell = new Shell();
		expect(() => shell.run({ command: ":", expect: expectState })).toThrow("64 hexadecimal");
	}
});

it("does not create a native core during inspection", async () => {
	expect(await new Shell().inspect(["echo"])).toBeNull();
});
