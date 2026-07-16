import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { materializePiDir } from "./materialize.mjs";

const exec = promisify(execFile);

/**
 * Prepare a LOCAL-FOLDER job. This is the zero-GitHub path: no token, no clone, no PR. The folder
 * on the operator's own machine becomes /workspace (bind-mounted read-write), edited in place.
 *
 * For v1 the folder must be a git repository, which buys two things for free: a stable ref (HEAD)
 * to read instructions from, and git's object model, so `.pi/` materialises through the same
 * symlink/submodule-safe path as GitHub jobs (materializePiDir). Instructions come from HEAD
 * (committed, reviewed); work happens on the working tree in /workspace. A non-git folder is a
 * documented v1 limitation -- `git init` it first.
 *
 * The task text is DATA (CONST-ISSUE-TEXT-IS-DATA): it goes into /job/prompt.md, never the
 * instructions. The operator supplies it from the panel.
 */
export async function prepareLocalWorkspace({ folder, task, jobDir, git = defaultGit }) {
	if (!existsSync(folder)) {
		const error = new Error(`local folder does not exist: ${folder}`);
		error.piDispatchConfig = true;
		throw error;
	}
	if (!existsSync(join(folder, ".git"))) {
		const error = new Error(`local folder is not a git repository (v1 requires one): ${folder}`);
		error.piDispatchConfig = true;
		throw error;
	}

	const sha = (await git(folder, ["rev-parse", "HEAD"])).trim();

	mkdirSync(jobDir, { recursive: true });
	// Instructions from HEAD, via the symlink-safe git materialiser, into /job/pi (mounted :ro).
	const written = await materializePiDir({ gitDir: folder, sha, destDir: jobDir });

	// The task the operator asked for. Plain data below the instructions.
	writeFileSync(join(jobDir, "prompt.md"), String(task ?? ""), { mode: 0o444 });

	// The folder itself is /workspace (rw). No clone: local jobs edit in place.
	return { workspace: folder, jobDir, sha, materialised: written };
}

async function defaultGit(gitDir, args) {
	const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "--no-pager", "-C", gitDir, ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}
