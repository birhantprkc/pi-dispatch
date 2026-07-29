import { spawn } from "node:child_process";

/**
 * Which image a job runs in, and whether it is on this host.
 *
 * Two facts, one module, because they must never disagree: the tag the preflight checked has to be the tag
 * `docker run` is handed. Both sides resolve through `resolveJobImage`, so there is one answer by
 * construction rather than by two call sites happening to match.
 *
 * This module imports nothing but `node:child_process` -- deliberately. `run-container.mjs` pulls in
 * `env-allowlist.mjs` and therefore `@earendil-works/pi-ai`, which is why its tests sit behind a
 * node-version skip guard. This is a money gate: it decides whether a budget slot is spent, so its tests
 * must run everywhere, unconditionally.
 */

/**
 * The image this job runs in: the job's own `image` when it carries one, otherwise the deployment default
 * (`PI_JOB_IMAGE`). Today nothing sets the per-job field, so every job resolves the default; the seam exists
 * because the preflight and the argv builder must never disagree about which tag they mean, and one function
 * is how that is guaranteed rather than hoped for.
 */
export function resolveJobImage(job, defaultImage) {
	return job?.image ?? defaultImage;
}

/**
 * Build the pre-spend image check. `image` is the deployment default; each call resolves the per-job value
 * against it.
 *
 * Resolves one of:
 *   { ok: true, image }   -- present on this host
 *   { missing: image }    -- the daemon answered and does not have it  => POLICY, refuse, do not retry
 *   { unavailable: image} -- docker itself did not answer              => INFRA, retry
 *
 * A non-zero `docker image inspect` is AMBIGUOUS -- an absent image and an unreachable daemon both exit 1 --
 * so the failure path disambiguates POSITIVELY with `docker info` rather than by matching docker's stderr.
 * Matching text would be the cheaper option and is the wrong one: the wording differs across CLI versions
 * and platforms, and a mismatch would turn a transient daemon blip into a permanent, un-retried refusal of
 * a job whose image is fine. The extra probe runs ONLY on the failure path, so the happy path still costs
 * exactly one spawn.
 *
 * Racy in both directions, and correct in both: if the daemon dies between the two probes we report
 * `unavailable` and retry; if it comes up between them we report `missing` on an image that is genuinely
 * absent. Nothing is cached, deliberately -- see the note at the call site in start.mjs.
 */
export function makeImagePreflight({ image, spawnFn = spawn }) {
	return async function imagePreflight(job) {
		const wanted = resolveJobImage(job, image);
		// --format keeps docker from serialising the whole image manifest to a pipe we ignore.
		if ((await runDocker(spawnFn, ["image", "inspect", "--format={{.Id}}", wanted])) === 0) {
			return { ok: true, image: wanted };
		}
		if ((await runDocker(spawnFn, ["info"])) === 0) return { missing: wanted };
		return { unavailable: wanted };
	};
}

/**
 * A spawned docker command's exit code; `null` when it could not be launched at all. `null !== 0` falls
 * through to the same branch a non-zero exit does, which is what we want: no docker binary is no answer.
 * Same shape as doctor.mjs's own runCmd -- the two probes below are literally the two doctor already runs,
 * so doctor and the worker agree on what "present" means.
 */
function runDocker(spawnFn, args) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn("docker", args, { stdio: "ignore" });
		} catch {
			resolve(null);
			return;
		}
		child.on("error", () => resolve(null)); // ENOENT etc. -- docker is not on PATH
		child.on("close", (code) => resolve(code));
	});
}
