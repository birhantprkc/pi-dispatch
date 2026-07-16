import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDockerRunArgs, ISOLATION_FLAGS } from "../src/docker-run.mjs";

const base = {
	image: "pi-job:pinned",
	env: { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-real" },
	jobPiDir: "/srv/jobs/abc/pi",
	workspace: "/srv/jobs/abc/workspace",
	name: "pi-job-abc",
};

test("carries every isolation flag -- these ARE the boundary", () => {
	const args = buildDockerRunArgs(base);
	const s = args.join(" ");
	for (const flag of ["--rm", "--init", "--cap-drop=ALL", "no-new-privileges", "--pids-limit=512", "--shm-size=1g"]) {
		assert.ok(args.includes(flag) || s.includes(flag), `missing isolation flag: ${flag}`);
	}
	// The dangerous one we must NEVER add.
	assert.ok(!s.includes("--ipc=host"), "--ipc=host shares the host IPC namespace with adversarial code");
	assert.ok(!s.includes("--privileged"), "--privileged");
});

test("/job is read-only, /workspace is writable", () => {
	const args = buildDockerRunArgs(base);
	assert.ok(args.includes("/srv/jobs/abc/pi:/job/pi:ro"), "/job/pi must be :ro");
	assert.ok(args.includes("/srv/jobs/abc/workspace:/workspace"), "/workspace must be writable");
	assert.ok(!args.some((a) => a.includes("/workspace:ro")), "/workspace must not be read-only");
});

test("env is an explicit -e NAME=VALUE allowlist, never a pass-through or --env-file", () => {
	const args = buildDockerRunArgs(base);
	assert.ok(args.includes("-e") && args.includes("ANTHROPIC_API_KEY=sk-real"));
	assert.ok(!args.includes("--env-file"), "must never use --env-file");
	// No bare `-e NAME` (which would inherit the host value) -- every -e is followed by NAME=VALUE.
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e") assert.match(args[i + 1], /=/, `bare -e ${args[i + 1]} would inherit from host`);
	}
});

test("an undefined env value is skipped, not passed as empty", () => {
	const args = buildDockerRunArgs({ ...base, env: { PI_MODEL: "m", GITHUB_TOKEN: undefined } });
	assert.ok(!args.some((a) => a.startsWith("GITHUB_TOKEN")), "absent token must not appear at all");
});

test("a local-folder job can add a Linux-only --user via extraFlags", () => {
	const args = buildDockerRunArgs({ ...base, extraFlags: ["--user", "1000:1000"] });
	assert.ok(args.includes("--user") && args.includes("1000:1000"));
});

test("refuses to build without image / name / workspace", () => {
	assert.throws(() => buildDockerRunArgs({ ...base, image: undefined }), /image/);
	assert.throws(() => buildDockerRunArgs({ ...base, name: undefined }), /name/);
	assert.throws(() => buildDockerRunArgs({ ...base, workspace: undefined }), /workspace/);
});

test("ISOLATION_FLAGS is frozen intent -- the exact set the spec pins", () => {
	// A change here is a change to the security boundary and must be deliberate.
	assert.deepEqual(ISOLATION_FLAGS, [
		"--rm",
		"--init",
		"--cap-drop=ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit=512",
		"--shm-size=1g",
	]);
});
