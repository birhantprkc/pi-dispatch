import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { SKILL_NAME_RE } from "./flow-gate.mjs";

const exec = promisify(execFile);

/**
 * Materialise a serviced repo's `.pi/` (its persona and skills) from a pinned commit into a
 * read-only `/job/pi/` directory the container mounts.
 *
 * This is security-critical: the content becomes the agent's SYSTEM PROMPT, and the repo is only
 * trusted at maintainer level. Three properties, each PROVEN with a hostile fixture in the tests:
 *
 *   1. NO SYMLINK FOLLOWING. A `.pi/APPEND_SYSTEM.md` symlinked to the worker's `.env` or
 *      `/etc/passwd` must never pull a host file into the prompt. We enumerate with `git ls-tree`
 *      and REJECT any entry that is not a regular blob (mode 100644): symlinks are 120000,
 *      submodules 160000. We never touch the working tree, so there is no link to follow.
 *   2. NO PATH TRAVERSAL. Every output path is re-derived from the git tree path and asserted to
 *      stay under the destination root; a crafted entry cannot escape `/job/pi/`.
 *   3. NO EXECUTION. `git cat-file blob <oid>` dumps raw bytes by object id -- no working-tree
 *      checkout, no smudge/clean filters, no hooks, no diff drivers. Nothing in the repo runs.
 *
 * The SHA is an input, resolved by the caller from a fresh default-branch API call -- NEVER a
 * webhook field, and NEVER the triggering (possibly fork) branch.
 */

const PI_DIR = ".pi";
const APPEND_SYSTEM = `${PI_DIR}/APPEND_SYSTEM.md`;
// A skill directory name: lowercase kebab/underscore, 1-64 chars, no dots (so no "..") and no
// slashes. This is what makes a traversal name impossible at the source. Matched against the
// CAPTURED segment only, never the whole path. The name charset itself is imported from
// flow-gate.mjs (the exported single source of truth, issue #92); the path form stays local
// because only the materialiser walks whole tree paths.
const SKILL_PATH_RE = /^\.pi\/skills\/([a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)\/SKILL\.md$/;

/**
 * Classify a git tree path into the destination we will WRITE, or null to reject.
 *
 * Critically, the returned `outRel` is built from a FIXED TEMPLATE using the validated skill name,
 * never from the raw git path. gitshow-research proved `git ls-tree` can emit path strings
 * containing literal `../` segments (git does not sanitise tree-entry names), so deriving the
 * output path from git's string is unsafe even behind a containment check. The name is the only
 * attacker-influenced input, and it is validated to a charset that cannot express traversal.
 */
export function classifyPiPath(path) {
	if (path === APPEND_SYSTEM) return { outRel: "pi/APPEND_SYSTEM.md" };
	const m = SKILL_PATH_RE.exec(path);
	if (!m) return null;
	const name = m[1];
	if (!SKILL_NAME_RE.test(name)) return null; // redundant with the capture group; belt and braces
	return { outRel: `pi/skills/${name}/SKILL.md` };
}

/** Back-compat predicate used by callers/tests that only care whether a path is accepted. */
export function isAllowedPiPath(path) {
	return classifyPiPath(path) !== null;
}

/**
 * Parse `git ls-tree -r -z` output into entries, keeping ONLY regular blobs (100644) at allowed
 * paths, each carrying its template-derived output path. Symlinks (120000), submodules (160000),
 * executables (100755), and anything outside the allowlist are dropped here -- the single choke
 * point for the reject-by-mode rule.
 */
export function selectEntries(lsTreeZ) {
	const entries = [];
	for (const record of lsTreeZ.split("\0")) {
		if (!record) continue;
		// "<mode> <type> <oid>\t<path>"
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const [mode, type, oid] = record.slice(0, tab).split(/\s+/);
		const path = record.slice(tab + 1);
		if (mode !== "100644" || type !== "blob") continue; // rejects symlink/submodule/exec
		const classified = classifyPiPath(path);
		if (!classified) continue;
		entries.push({ oid, path, outRel: classified.outRel });
	}
	return entries;
}

/**
 * Assert a resolved output path stays under root. Defence in depth behind the path allowlist.
 * Uses path.relative rather than string-prefix so it is correct on Windows too -- the worker is
 * cross-platform and destDir may be a Windows path with backslash separators.
 */
function safeJoin(root, ...segments) {
	const resolved = join(root, ...segments);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path escapes destination: ${segments.join("/")}`);
	}
	return resolved;
}

/**
 * Materialise `.pi/` at `sha` from the clone at `gitDir` into `destDir` (which becomes /job/pi).
 * Returns the list of relative paths written (under `pi/`), for logging.
 *
 * `git` is injected for tests; defaults to a thin wrapper over the real binary.
 */
export async function materializePiDir({ gitDir, sha, destDir, git = defaultGit }) {
	const lsTreeZ = await git(gitDir, ["ls-tree", "-r", "-z", sha, `${PI_DIR}/`]);
	const entries = selectEntries(lsTreeZ);

	const written = [];
	for (const { oid, outRel } of entries) {
		const content = await git(gitDir, ["cat-file", "blob", oid], { raw: true });
		// outRel is TEMPLATE-derived from a validated name, never the raw git path -- so it cannot
		// contain traversal. safeJoin re-checks containment as defence in depth, and splits the posix
		// outRel into host path segments so it is correct on Windows too.
		const out = safeJoin(destDir, ...outRel.split("/"));
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, content, { mode: 0o444 });
		// Report posix-style: this names a CONTAINER path (/job/pi/...), stable across host OSes.
		written.push(outRel);
	}
	return written;
}

async function defaultGit(gitDir, args, { raw = false } = {}) {
	// -c protecting against a hostile repo config: no hooks, no external filters, no pager.
	const hardened = [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"--no-pager",
		"-C",
		gitDir,
		...args,
	];
	const { stdout } = await exec("git", hardened, {
		encoding: raw ? "buffer" : "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}
