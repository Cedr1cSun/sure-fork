#!/usr/bin/env node
/**
 * The evaluation lock is a compiled file: requirements.in lists the direct pins and the
 * lock is what the runtime installs. A package added to requirements.in without
 * recompiling the lock stays invisible until the runtime starts and imports it — that is
 * how librosa went missing (#163).
 *
 * This compares the two sets instead of recompiling. A full `uv pip compile` diff would
 * also flag version bumps nobody asked for, and its output moves with the uv release and
 * the platform: on this checkout it differed by 893 lines, none of them a missing pin.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pairs = [
	["sure/runtime/evaluation/requirements.in", "sure/runtime/evaluation/requirements.lock.txt"],
	["sure/runtime/harness/requirements.in", "sure/runtime/harness/requirements.lock.txt"],
];

/** PEP 503 normalisation: `pydantic-settings` and `pydantic_settings` are one package. */
function normalize(name) {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function requirementNames(text) {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/(^|\s)#.*$/, "").trim())
		.filter(Boolean)
		.map((line) => normalize(line.split(/[<>=!~[;\s]/)[0].trim()))
		.filter(Boolean);
}

function lockedNames(text) {
	const names = new Set();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==/.exec(line.trim());
		if (match) names.add(normalize(match[1]));
	}
	return names;
}

let failed = false;
for (const [inPath, lockPath] of pairs) {
	const absIn = join(root, inPath);
	const absLock = join(root, lockPath);
	if (!existsSync(absIn) || !existsSync(absLock)) {
		console.error(`${inPath} or ${lockPath} is missing`);
		failed = true;
		continue;
	}
	const locked = lockedNames(readFileSync(absLock, "utf-8"));
	const missing = requirementNames(readFileSync(absIn, "utf-8")).filter((name) => !locked.has(name));
	if (missing.length > 0) {
		console.error(`${lockPath} does not lock: ${missing.join(", ")}`);
		console.error("  Recompile it with the command recorded on its first line.");
		failed = true;
	}
}

if (failed) {
	process.exit(1);
}
console.log("ok   evaluation and harness locks cover every requirement");
