import { describe, expect, test } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";

/**
 * A tool whose `parameters` survived a serialization round-trip: the live
 * ArkType Type is gone and only a plain JSON Schema object remains, its keys
 * still carrying ArkType's `?` optional marker.
 *
 * `toolWireSchema` short-circuits a live ArkType Type through `toJsonSchema()`,
 * which drops the marker, so this shape is the one that reached the wire intact
 * and made Anthropic reject the whole request:
 *
 *   400 tools.4.custom.input_schema.properties:
 *       Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'
 */
const ANTHROPIC_PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

function wire(parameters: unknown): Record<string, unknown> {
	return toolWireSchema({ name: "_bash", description: "run a command", parameters } as unknown as Tool);
}

function propertyKeys(schema: Record<string, unknown>): string[] {
	return Object.keys((schema.properties ?? {}) as Record<string, unknown>);
}

describe("toolWireSchema: ArkType optional markers in plain JSON Schema keys", () => {
	test("strips the marker so every key satisfies Anthropic's property-key pattern", () => {
		const schema = wire({
			type: "object",
			properties: {
				command: { type: "string", description: "command to execute" },
				"env?": { type: "object" },
				"timeout?": { type: "number" },
				"cwd?": { type: "string", description: "working directory" },
				"pty?": { type: "boolean" },
			},
			required: ["command"],
		});

		expect(propertyKeys(schema)).toEqual(["command", "env", "timeout", "cwd", "pty"]);
		for (const key of propertyKeys(schema)) expect(key).toMatch(ANTHROPIC_PROPERTY_KEY);
		expect(schema.required).toEqual(["command"]);
	});

	test("an optional key listed in required is not promoted to required", () => {
		// Dropping the marker off the name without this would turn `cwd?` into a
		// required `cwd`, quietly changing the tool's contract.
		const schema = wire({
			type: "object",
			properties: { "cwd?": { type: "string" } },
			required: ["cwd?"],
		});

		expect(propertyKeys(schema)).toEqual(["cwd"]);
		expect(schema.required).toBeUndefined();
	});

	test("normalizes nested objects and $defs, not just the root", () => {
		const schema = wire({
			type: "object",
			properties: { outer: { type: "object", properties: { "inner?": { type: "string" } } } },
			$defs: { A: { type: "object", properties: { "x?": { type: "string" } } } },
		});

		const outer = (schema.properties as Record<string, Record<string, unknown>>).outer;
		expect(Object.keys((outer.properties ?? {}) as Record<string, unknown>)).toEqual(["inner"]);
		const defs = (schema.$defs ?? {}) as Record<string, Record<string, unknown>>;
		expect(Object.keys((defs.A.properties ?? {}) as Record<string, unknown>)).toEqual(["x"]);
	});

	test("a key that is only a question mark is left alone", () => {
		// Not an ArkType optional - there is no name in front of the marker, so
		// stripping it would invent an empty property name.
		const schema = wire({ type: "object", properties: { "?": { type: "string" } } });
		expect(propertyKeys(schema)).toEqual(["?"]);
	});

	test("a schema with nothing to normalize is unchanged", () => {
		const schema = wire({
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
		expect(propertyKeys(schema)).toEqual(["command"]);
		expect(schema.required).toEqual(["command"]);
	});
});
