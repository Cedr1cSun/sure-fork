import { createJiti } from "jiti/static";
import { resolveSurePackagePath } from "./manifest.ts";
import { getSureHookAliases } from "./module-loader.ts";
import type { SureHookContext, SureHookDeclaration, SureHookPoint, SureHookResult, SureSkillPackage } from "./types.ts";

type HookFunction = (context: SureHookContext) => SureHookResult | Promise<SureHookResult | undefined> | undefined;

/**
 * Soft deadline for one hook call. A handler that ignores it keeps running — this only
 * stops the run from waiting forever, which is how a hanging pre_tool_call used to block
 * a run with no way out. Killing the handler needs the worker isolation in the hook
 * execution boundary design (issue #172); this is the interim, and the repair text says so.
 */
const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

function hookTimeoutMs(): number {
	const raw = Number.parseInt(process.env.SURE_HOOK_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOOK_TIMEOUT_MS;
}

class HookDeadlineExceeded extends Error {}

async function withDeadline<T>(task: Promise<T> | T, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(task),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new HookDeadlineExceeded(`exceeded ${ms}ms`)), ms);
				(timer as unknown as { unref?: () => void }).unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface SureGateResult {
	ok: boolean;
	message?: string;
	repair?: string;
	diagnostics?: unknown;
	state_patch?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeHookResult(value: unknown): SureHookResult {
	if (!isRecord(value)) {
		return {};
	}
	return {
		ok: typeof value.ok === "boolean" ? value.ok : undefined,
		message: typeof value.message === "string" ? value.message : undefined,
		repair: typeof value.repair === "string" ? value.repair : undefined,
		patch: value.patch,
		artifacts: value.artifacts,
		diagnostics: value.diagnostics,
		state_patch: value.state_patch,
	};
}

function toGateFailure(result: SureHookResult, fallbackMessage: string): SureGateResult | undefined {
	if (result.ok !== false && !result.repair) {
		return undefined;
	}
	return {
		ok: false,
		message: result.message ?? fallbackMessage,
		repair: result.repair ?? result.message ?? fallbackMessage,
		diagnostics: result.diagnostics,
		state_patch: result.state_patch,
	};
}

export class SureHookRunner {
	private skillPackage: SureSkillPackage;
	private jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: getSureHookAliases(),
	});

	constructor(skillPackage: SureSkillPackage) {
		this.skillPackage = skillPackage;
	}

	async run(point: SureHookPoint, context: Omit<SureHookContext, "point">): Promise<SureGateResult> {
		const declarations = this.skillPackage.manifest.hooks?.[point] ?? [];
		let statePatch: unknown;
		for (const declaration of declarations) {
			const result = await this.runHook(point, declaration, context);
			if (result.state_patch !== undefined) {
				statePatch = result.state_patch;
			}
			const failure = toGateFailure(result, `Sure ${point} hook rejected the action.`);
			if (failure) {
				return { ...failure, state_patch: failure.state_patch ?? statePatch };
			}
		}
		return { ok: true, state_patch: statePatch };
	}

	private async runHook(
		point: SureHookPoint,
		declaration: SureHookDeclaration,
		context: Omit<SureHookContext, "point">,
	): Promise<SureHookResult> {
		const hookPath = resolveSurePackagePath(this.skillPackage.packageDir, declaration.module);
		if (!hookPath) {
			return {
				ok: false,
				message: `Hook module path escapes skill package: ${declaration.module}`,
				repair: "Fix sure.skill.json so hook module paths stay inside the skill package.",
			};
		}

		const timeoutMs = hookTimeoutMs();
		try {
			const loaded = await this.jiti.import(hookPath);
			const moduleValue = loaded as Record<string, unknown>;
			const handlerName = declaration.handler ?? point;
			const handler =
				(typeof moduleValue[handlerName] === "function" ? moduleValue[handlerName] : undefined) ??
				(typeof moduleValue.default === "function" ? moduleValue.default : undefined);
			if (!handler) {
				return {
					ok: false,
					message: `Hook handler not found: ${handlerName}`,
					repair: `Export a function named "${handlerName}" from ${declaration.module}, or provide a default export.`,
				};
			}

			const value = await withDeadline(
				(handler as HookFunction)({
					...context,
					point,
				}),
				timeoutMs,
			);
			return normalizeHookResult(value);
		} catch (error) {
			if (error instanceof HookDeadlineExceeded) {
				return {
					ok: false,
					message: `Sure ${point} hook ${declaration.module} did not return within ${timeoutMs}ms`,
					repair: `Make the ${point} hook return faster, or raise SURE_HOOK_TIMEOUT_MS. The handler is not killed and may still be running.`,
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				message: `Sure ${point} hook failed: ${message}`,
				repair: `Fix the hook failure in ${declaration.module} and retry the action.`,
			};
		}
	}
}
