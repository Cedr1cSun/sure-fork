import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SureHookRunner } from "../../src/core/sure/hooks.ts";
import type { SureSkillPackage } from "../../src/core/sure/types.ts";

function packageWithHook(dir: string, source: string, handler = "preFinish"): SureSkillPackage {
	writeFileSync(join(dir, "hook.ts"), source);
	return {
		manifest: {
			name: "test-skill",
			hooks: { pre_finish: [{ module: "hook.ts", handler }] },
		} as unknown as SureSkillPackage["manifest"],
		manifestPath: join(dir, "sure.skill.json"),
		packageDir: dir,
		promptPath: join(dir, "SKILL.md"),
		prompt: "",
		source: "project",
		sourceRoot: dir,
	};
}

describe("SureHookRunner deadline", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sure-hooks-"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	// A hanging pre_tool_call used to block the run with no way out. The deadline turns it
	// into an ordinary gate failure; it does not kill the handler (issue #172).
	test("a hook that never returns fails the gate instead of blocking the run", async () => {
		vi.stubEnv("SURE_HOOK_TIMEOUT_MS", "50");
		const runner = new SureHookRunner(
			packageWithHook(
				dir,
				`export async function preFinish() {
					await new Promise((resolve) => setTimeout(resolve, 300));
					return { ok: true };
				}`,
			),
		);

		const result = await runner.run("pre_finish", {} as never);

		expect(result.ok).toBe(false);
		expect(result.message).toContain("did not return within 50ms");
		expect(result.repair).toContain("SURE_HOOK_TIMEOUT_MS");
	});

	test("a fast hook still passes", async () => {
		vi.stubEnv("SURE_HOOK_TIMEOUT_MS", "5000");
		const runner = new SureHookRunner(packageWithHook(dir, `export function preFinish() { return { ok: true }; }`));

		const result = await runner.run("pre_finish", {} as never);

		expect(result.ok).toBe(true);
	});

	test("a hook that rejects still reports its own message", async () => {
		vi.stubEnv("SURE_HOOK_TIMEOUT_MS", "5000");
		const runner = new SureHookRunner(
			packageWithHook(dir, `export async function preFinish() { throw new Error("artifact missing"); }`),
		);

		const result = await runner.run("pre_finish", {} as never);

		expect(result.ok).toBe(false);
		expect(result.message).toContain("artifact missing");
		expect(result.message).not.toContain("did not return within");
	});
});
