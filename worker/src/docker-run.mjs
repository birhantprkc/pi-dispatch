/**
 * INT-CONTAINER-RUNTIME-CONTRACT. Construct the `docker run` argv for one job container.
 *
 * Every flag here is the enforcement surface of CONST-ISOLATION-CONTAINER-PER-JOB -- pi has no
 * permission system, so the container is the only real control. The argv is built as an explicit
 * array (never a shell string): no interpolation, no injection, and the env allowlist is passed
 * with explicit `-e NAME` where the value is read from the argv env map, never `--env-file` and
 * never a host pass-through.
 */

/** The fixed isolation flags. Not configurable -- these ARE the boundary. */
export const ISOLATION_FLAGS = [
	"--rm", // ephemeral: gone after the run
	"--init", // reap zombies (Chromium spawns many); node is PID 1 and does not reap
	"--cap-drop=ALL", // pi would otherwise inherit the launching user's capabilities
	"--security-opt",
	"no-new-privileges",
	"--pids-limit=512", // bound a fork bomb (UNVERIFIED figure; measured headroom ~4.5x, see spec)
	"--shm-size=1g", // Chromium OOMs on the default 64MB /dev/shm; NOT --ipc=host (shares host ns)
];

/**
 * Build the full `docker run` argv (excluding the leading "docker").
 *
 * @param image      pinned job image tag/digest
 * @param env        the closed env map from buildContainerEnv -- passed as explicit -e NAME=VALUE
 * @param jobPiDir   host path to the materialised .pi/ (mounted /job/pi:ro)
 * @param workspace  host path to the fresh clone / local folder (mounted /workspace:rw)
 * @param name       container name (for `docker stop` at the timeout)
 * @param memory     e.g. "4g"; cpus e.g. "2"
 * @param extraFlags escape hatch for a Linux-only --user uid:gid on a bind-mounted local folder
 */
export function buildDockerRunArgs({
	image,
	env,
	jobPiDir,
	workspace,
	name,
	memory = "4g",
	cpus = "2",
	extraFlags = [],
}) {
	if (!image) throw new Error("docker run: image is required");
	if (!name) throw new Error("docker run: container name is required");
	if (!workspace) throw new Error("docker run: workspace mount is required");

	const args = ["run", `--name=${name}`, ...ISOLATION_FLAGS, `--memory=${memory}`, `--cpus=${cpus}`, ...extraFlags];

	// Explicit env allowlist. Each entry is `-e NAME=VALUE`, built from the closed map -- so a
	// stray host variable cannot ride along (no bare `-e NAME` inheriting from the host, no
	// --env-file). Undefined values are skipped, never passed as an empty string.
	for (const [k, v] of Object.entries(env ?? {})) {
		if (v === undefined || v === null) continue;
		args.push("-e", `${k}=${v}`);
	}

	// /job is read-only (INT-CONTAINER-JOB-INPUTS): the agent cannot rewrite its own instructions.
	// /workspace is the only writable mount.
	if (jobPiDir) args.push("-v", `${jobPiDir}:/job/pi:ro`);
	args.push("-v", `${workspace}:/workspace`);

	args.push(image);
	return args;
}
