import { execFileSync } from "node:child_process";

/**
 * Report a folder's git working-tree state: `true` = dirty, `false` = clean, `null` = not a usable
 * git repository. Reads the WORKING TREE via `git status --porcelain` — distinct from
 * flow-gate.mjs's object-store read, which reads committed content at a pinned SHA; the two are kept
 * separate on purpose. `exec` is injectable for tests.
 */
export function gitDirty(folder, { exec = execFileSync } = {}) {
	try {
		const out = exec("git", ["-C", folder, "status", "--porcelain"], { encoding: "utf8" });
		return out.trim().length > 0;
	} catch {
		return null;
	}
}
