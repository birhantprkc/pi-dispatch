/**
 * INT-CONTAINER-RUNTIME-CONTRACT. Construct the `docker run` argv for one job container.
 *
 * Every flag here is the enforcement surface of CONST-ISOLATION-CONTAINER-PER-JOB -- pi has no
 * permission system, so the container is the only real control. The argv is built as an explicit
 * array (never a shell string): no interpolation, no injection, and the env allowlist is passed
 * with explicit `-e NAME` where the value is read from the argv env map, never `--env-file` and
 * never a host pass-through.
 */

/**
 * Where the operator's global pi overlay lands INSIDE the container (REQ-GLOBAL-PI-OVERLAY). Exported
 * because packages.mjs derives the staged-packages root from it: the mount and that root are ONE fact on
 * one side of the boundary, and two literals in two modules could drift apart with both test suites still
 * green. A Linux container path, so it is always built with "/" -- never `path.join`, which yields
 * backslashes when the worker itself runs on Windows.
 */
export const CONTAINER_GLOBAL_PI_DIR = "/opt/pi-global";

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
 * @param jobDir     host path to the /job inputs dir (contains prompt.md and pi/); mounted /job:ro
 * @param workspace  host path to the fresh clone / local folder (mounted /workspace:rw)
 * @param outboxDir  host path to the /outbox chain-request dir (local jobs only); mounted /outbox:rw
 * @param globalPiDir host path to the operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY); mounted /opt/pi-global:ro
 * @param name       container name (for `docker stop` at the timeout)
 * @param memory     e.g. "4g"; cpus e.g. "2"
 * @param extraFlags escape hatch for a Linux-only --user uid:gid on a bind-mounted local folder
 */
export function buildDockerRunArgs({
	image,
	env,
	jobDir,
	workspace,
	outboxDir,
	globalPiDir,
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

	// The WHOLE /job dir is read-only (INT-CONTAINER-JOB-INPUTS): it holds prompt.md and pi/, and
	// the agent cannot rewrite any of it. /workspace is the only writable mount.
	if (jobDir) args.push("-v", `${jobDir}:/job:ro`);
	args.push("-v", `${workspace}:/workspace`);
	// Local jobs get a writable /outbox host bind, the same host-bind mechanism as /workspace
	// (DES-WORKER-ON-HOST). github jobs pass no outboxDir, so the request channel does not exist for
	// them -- an untrusted issue author cannot chain (INT-OUTBOX-CONTRACT).
	if (outboxDir) args.push("-v", `${outboxDir}:/outbox`);

	// The operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY): custom models, global skills, a global
	// persona, layered UNDER each repo's own .pi/. Read-only -- it is operator-authored deploy-time config,
	// the same trust class as the baked floor, but the agent still must not rewrite it. Both job kinds.
	if (globalPiDir) args.push("-v", `${globalPiDir}:${CONTAINER_GLOBAL_PI_DIR}:ro`);

	args.push(image);
	return args;
}
