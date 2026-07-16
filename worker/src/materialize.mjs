import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

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
// Exactly the two shapes we accept. Anything else in .pi/ is ignored, not materialised.
const APPEND_SYSTEM = `${PI_DIR}/APPEND_SYSTEM.md`;
const SKILL_RE = /^\.pi\/skills\/[A-Za-z0-9._-]+\/SKILL\.md$/;

/** A git tree path we are willing to materialise. Rejects traversal and unexpected shapes. */
export function isAllowedPiPath(path) {
	if (path === APPEND_SYSTEM) return true;
	return SKILL_RE.test(path);
}

/**
 * Parse `git ls-tree -r -z` output into entries, keeping ONLY regular blobs (100644) at allowed
 * paths. Symlinks (120000), submodules (160000), executables (100755), and anything outside the
 * allowlist are dropped here -- the single choke point for the reject-by-mode rule.
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
		if (!isAllowedPiPath(path)) continue;
		entries.push({ oid, path });
	}
	return entries;
}

/**
 * Assert a resolved output path stays under root. Defence in depth behind the path allowlist.
 * Uses path.relative rather than string-prefix so it is correct on Windows too -- the worker is
 * cross-platform and destDir may be a Windows path with backslash separators.
 */
function safeJoin(root, relPath) {
	const resolved = join(root, relPath);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path escapes destination: ${relPath}`);
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
	for (const { oid, path } of entries) {
		const content = await git(gitDir, ["cat-file", "blob", oid], { raw: true });
		// path is ".pi/skills/x/SKILL.md" (git always uses forward slashes); strip the leading
		// ".pi/" so it lands under destDir/pi.
		const relPosix = `pi/${path.slice(PI_DIR.length + 1)}`;
		const out = safeJoin(destDir, relPosix);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, content);
		// Report posix-style: this names a CONTAINER path (/job/pi/...), stable across host OSes.
		written.push(relPosix);
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
