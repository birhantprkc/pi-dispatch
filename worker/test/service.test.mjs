import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runService, TEMPLATE_PINS } from "../src/service.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The deploy/ copy the render actually reads: worker/deploy, shipped in the npm tarball and kept
// byte-identical to the repo-root deploy/ by the sync test in publish.test.mjs.
const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");

// ---------------------------------------------------------------------------------------------------
// The pin test: render is a targeted substitution of the templates' KNOWN literals, so a template
// edit that renames one must fail HERE (build time), not at render time on an operator's host. Reads
// the REAL worker/deploy files — the ones readTemplate resolves — on purpose; a fake would pin nothing.
// ---------------------------------------------------------------------------------------------------

test("pin: every literal the render substitutes or preserves is present in its real deploy/ template", () => {
	for (const [name, literals] of Object.entries(TEMPLATE_PINS)) {
		const text = readFileSync(join(DEPLOY_DIR, name), "utf8");
		for (const literal of literals) {
			assert.ok(
				text.includes(literal),
				`deploy/${name} no longer contains ${JSON.stringify(literal)} — update TEMPLATE_PINS and the render together`,
			);
		}
	}
});

// ---------------------------------------------------------------------------------------------------
// Harness: everything injected, everything recorded. The fake fs serves writes from a Map but lets
// reads FALL THROUGH to the real filesystem, so renders exercise the actual deploy/ templates.
// ---------------------------------------------------------------------------------------------------

// The up.test.mjs fake spawn: plan keys are command-line prefixes mapped to an exit code, a
// {code, output} pair, or "enoent" for a launch failure. First matching key wins, so put longer
// prefixes ("nssm status") before shorter ones ("nssm").
function fakeSpawn(plan, calls, events) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		calls.push({ cmd, args, opts });
		events?.push(`spawn ${line}`);
		const stream = () => ({
			handlers: {},
			on(ev, cb) {
				this.handlers[ev] = cb;
				return this;
			},
		});
		const handlers = {};
		const child = {
			stdout: stream(),
			stderr: stream(),
			kill() {},
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			if (outcome === "enoent") {
				handlers.error?.(new Error(`spawn ${cmd} ENOENT`));
				return;
			}
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

function harness({ platform = "linux", argv = [], files = {}, euid = 501, plan = {}, queue = null, events = null } = {}) {
	const calls = [];
	const buf = [];
	const errBuf = [];
	const store = new Map(Object.entries(files));
	let clock = 0;
	const deps = {
		env: {},
		platform,
		euid,
		execPath: "/fake/node/bin/node",
		repoRoot: REPO_ROOT,
		home: "/home/tester",
		user: "tester",
		tmp: "/faketmp",
		spawn: fakeSpawn(plan, calls, events),
		out: (s) => buf.push(s),
		err: (s) => errBuf.push(s),
		// Virtual time: sleep advances the clock instantly so drain-timeout tests need no real waiting.
		sleep: async (ms) => {
			clock += ms;
			events?.push("sleep");
		},
		now: () => clock,
		queue,
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p, encoding) => (store.has(p) ? store.get(p) : readFileSync(p, encoding)),
			writeFileSync: (p, data) => store.set(p, data),
			mkdirSync: () => {},
			unlinkSync: (p) => store.delete(p),
		},
	};
	return { run: () => runService(argv, deps), calls, store, text: () => buf.join(""), errText: () => errBuf.join("") };
}

const USER_UNIT = "/home/tester/.config/systemd/user/pi-dispatch-worker.service";
const AGENT_PLIST = "/home/tester/Library/LaunchAgents/com.pi-dispatch.worker.plist";

// ---------------------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------------------

test("render linux --user: execPath and repo root land; the exit-2 and crash-loop semantics survive; User= is stripped", async () => {
	const h = harness({ platform: "linux", argv: ["render"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.match(text, new RegExp(`ExecStart=/fake/node/bin/node worker/src/cli\\.mjs worker`));
	assert.ok(text.includes(`WorkingDirectory=${REPO_ROOT}`), "repo root landed in WorkingDirectory");
	assert.ok(text.includes(`EnvironmentFile=${REPO_ROOT}/.env`), "repo root landed in EnvironmentFile");
	assert.match(text, /RestartPreventExitStatus=2/, "the EXIT_POLICY never-restart must survive byte-for-byte");
	assert.match(text, /StartLimitBurst=5/, "the crash-loop bound must survive byte-for-byte");
	assert.match(text, /StartLimitIntervalSec=60/);
	assert.match(text, /KillSignal=SIGTERM/);
	assert.match(text, /TimeoutStopSec=30/);
	assert.doesNotMatch(text, /^User=/m, "a systemd --user unit must not carry User= (systemd rejects it)");
	assert.match(text, /WantedBy=default\.target/, "multi-user.target never runs in the user instance");
	assert.equal(h.calls.length, 0, "render spawns nothing");
});

test("render linux --system: User= is rewritten to the invoking user, WantedBy stays multi-user.target", async () => {
	const h = harness({ platform: "linux", argv: ["render", "--system"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /^User=tester$/m);
	assert.match(h.text(), /WantedBy=multi-user\.target/);
});

test("render linux --receiver: receiver.service rendered with the same table", async () => {
	const h = harness({ platform: "linux", argv: ["render", "--receiver"] });
	assert.equal(await h.run(), 0);
	assert.ok(h.text().includes("ExecStart=/fake/node/bin/node receiver/src/start.mjs"));
	assert.ok(h.text().includes(`WorkingDirectory=${REPO_ROOT}`));
	assert.doesNotMatch(h.text(), /^User=/m);
	assert.match(h.text(), /pi-dispatch-receiver\.service/, "the receiver unit gets its own name");
});

test("render darwin: plist paths computed, node dir injected into PATH, KeepAlive shape intact, wrapper note printed", async () => {
	const h = harness({ platform: "darwin", argv: ["render"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes("<string>com.pi-dispatch.worker</string>"));
	assert.ok(text.includes(`<string>${REPO_ROOT}/deploy/worker-env-wrapper.sh</string>`), "the wrapper path follows the repo root");
	assert.ok(text.includes(`<string>${REPO_ROOT}/logs/worker.out.log</string>`));
	// launchd's default PATH cannot see an nvm/Homebrew node; the render must pin the installing node's dir.
	assert.ok(text.includes("<string>/fake/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"), "node's directory is prepended to the service PATH");
	assert.ok(text.includes("<key>SuccessfulExit</key>"), "the KeepAlive crash-only-restart shape survives");
	assert.match(text, /converts a policy refusal \(exit 2/, "the wrapper note explains the exit-2 conversion");
});

test("render darwin --receiver: derived plist swaps label and logs and passes the receiver argument to the shared wrapper", async () => {
	const h = harness({ platform: "darwin", argv: ["render", "--receiver"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes("<string>com.pi-dispatch.receiver</string>"));
	assert.ok(!text.includes("<string>com.pi-dispatch.worker</string>"), "the worker label must not survive the derivation");
	assert.ok(text.includes("<string>receiver</string>"), "the wrapper argument that selects the receiver");
	assert.ok(text.includes("receiver.out.log") && text.includes("receiver.err.log"));
});

test("render win32: the nssm sequence carries computed paths and the AppExit pair byte-for-byte", async () => {
	const h = harness({ platform: "win32", argv: ["render"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes(`nssm install pi-dispatch-worker "${REPO_ROOT}\\deploy\\worker-env-wrapper.cmd"`));
	assert.ok(text.includes(`"${REPO_ROOT}\\logs\\worker.out.log"`));
	assert.match(text, /AppExit Default Restart/);
	assert.match(text, /AppExit 2 Exit/, "the EXIT_POLICY never-retry must survive");
	assert.match(text, /AppStopMethodConsole 15000/, "the console-stop grace must survive");
	assert.match(text, /AppThrottle 5000/, "the crash-loop throttle must survive");
});

// ---------------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------------

test("install darwin: refuses euid 0 outright — no writes, no spawns", async () => {
	const h = harness({ platform: "darwin", euid: 0, argv: ["install"] });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /root/);
	assert.match(h.errText(), /without sudo/);
	assert.equal(h.store.size, 0, "nothing written");
	assert.equal(h.calls.length, 0, "nothing spawned");
});

test("install darwin: writes the LaunchAgent, bootstraps and enables it, and prints the honest login-scope note", async () => {
	const h = harness({ platform: "darwin", argv: ["install"], plan: { launchctl: 0 } });
	assert.equal(await h.run(), 0);
	const plist = h.store.get(AGENT_PLIST);
	assert.ok(plist, "plist written into ~/Library/LaunchAgents");
	assert.ok(plist.includes(`<string>${REPO_ROOT}/deploy/worker-env-wrapper.sh</string>`));
	const argvs = h.calls.map((c) => [c.cmd, ...c.args].join(" "));
	assert.deepEqual(argvs, [`launchctl bootstrap gui/501 ${AGENT_PLIST}`, "launchctl enable gui/501/com.pi-dispatch.worker"]);
	assert.match(h.text(), /LOGIN-scoped/, "no pretending a LaunchAgent is a boot daemon");
	assert.match(h.text(), /Docker Desktop is itself login-scoped/);
});

test("install darwin: a worker unit in the system scope (LaunchDaemons) refuses, citing the boot-reaper invariant", async () => {
	const h = harness({
		platform: "darwin",
		argv: ["install"],
		files: { "/Library/LaunchDaemons/com.pi-dispatch.worker.plist": "<plist/>" },
	});
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /DES-CONCURRENCY-3/);
	assert.match(h.errText(), /boot reaper/);
	assert.equal(h.store.has(AGENT_PLIST), false, "nothing written after a refusal");
	assert.equal(h.calls.length, 0);
});

test("install linux --user: unit written without User=, daemon-reload then enable --now, linger hint printed", async () => {
	const h = harness({ platform: "linux", argv: ["install"], plan: { systemctl: 0 } });
	assert.equal(await h.run(), 0);
	const unit = h.store.get(USER_UNIT);
	assert.ok(unit, "unit written into ~/.config/systemd/user");
	assert.doesNotMatch(unit, /^User=/m);
	assert.match(unit, /RestartPreventExitStatus=2/);
	assert.match(unit, /WantedBy=default\.target/);
	const argvs = h.calls.map((c) => c.args);
	assert.deepEqual(argvs, [
		["--user", "daemon-reload"],
		["--user", "enable", "--now", "pi-dispatch-worker.service"],
	]);
	assert.match(h.text(), /loginctl enable-linger tester/, "the headless-boot hint is printed");
});

test("install linux --system: prints the exact sudo commands, stages the render, and spawns NOTHING", async () => {
	const h = harness({ platform: "linux", argv: ["install", "--system"] });
	assert.equal(await h.run(), 0);
	assert.equal(h.calls.length, 0, "the pm2 pattern: no command runs, root actions happen only in the operator's shell");
	const staged = h.store.get("/faketmp/pi-dispatch-worker.service");
	assert.ok(staged, "the render is staged for inspection");
	assert.match(staged, /^User=tester$/m, "system scope keeps a User= line, rewritten to the invoking user");
	assert.match(staged, /RestartPreventExitStatus=2/);
	assert.ok(h.text().includes("sudo install -m 644 /faketmp/pi-dispatch-worker.service /etc/systemd/system/pi-dispatch-worker.service"));
	assert.ok(h.text().includes("sudo systemctl daemon-reload"));
	assert.ok(h.text().includes("sudo systemctl enable --now pi-dispatch-worker.service"));
});

test("install linux --user: an existing unit in the SAME scope refuses without --force and touches nothing", async () => {
	const h = harness({ platform: "linux", argv: ["install"], files: { [USER_UNIT]: "operator edited this" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /--force/);
	assert.equal(h.store.get(USER_UNIT), "operator edited this", "the existing unit is untouched (init's non-clobber contract)");
	assert.equal(h.calls.length, 0);
});

test("install linux --user: --force replaces the same-scope unit and proceeds to enable", async () => {
	const h = harness({ platform: "linux", argv: ["install", "--force"], files: { [USER_UNIT]: "old" }, plan: { systemctl: 0 } });
	assert.equal(await h.run(), 0);
	assert.notEqual(h.store.get(USER_UNIT), "old", "--force overwrote the unit");
	assert.ok(h.calls.some((c) => c.args.includes("enable")), "enable --now still runs");
});

test("install linux --user: a worker unit in the OTHER scope refuses — one worker per docker daemon", async () => {
	// worker.service is the name the README's manual `sudo cp` produces; a hand-installed worker is
	// still a second worker.
	const h = harness({ platform: "linux", argv: ["install"], files: { "/etc/systemd/system/worker.service": "[Unit]" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /other scope/);
	assert.match(h.errText(), /DES-CONCURRENCY-3/);
	assert.match(h.errText(), /boot reaper kills every pi-job container/);
	assert.equal(h.store.has(USER_UNIT), false);
});

test("install linux --receiver: the cross-scope WORKER refusal does not apply to the receiver", async () => {
	// A second receiver is pointless, not destructive — only the worker owns the docker daemon.
	const h = harness({
		platform: "linux",
		argv: ["install", "--receiver"],
		files: { "/etc/systemd/system/worker.service": "[Unit]" },
		plan: { systemctl: 0 },
	});
	assert.equal(await h.run(), 0);
	assert.ok(h.store.has("/home/tester/.config/systemd/user/pi-dispatch-receiver.service"));
});

test("install win32: nssm absent → the download pointer, nothing else", async () => {
	const h = harness({ platform: "win32", argv: ["install"], plan: { nssm: "enoent" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /nssm\.cc/);
	assert.match(h.errText(), /winget install nssm/);
	assert.match(h.errText(), /Task Scheduler is not a substitute/);
});

test("install win32: drives the nssm-install.cmd sequence with computed paths, AppExit 2 Exit included", async () => {
	const h = harness({ platform: "win32", argv: ["install"], plan: { "nssm status": 3, nssm: 0 } });
	assert.equal(await h.run(), 0);
	const argvs = h.calls.map((c) => c.args);
	assert.deepEqual(argvs[0], ["status", "pi-dispatch-worker"], "the probe that answers both on-PATH and already-exists");
	assert.deepEqual(argvs.slice(1), [
		["install", "pi-dispatch-worker", `${REPO_ROOT}\\deploy\\worker-env-wrapper.cmd`],
		["set", "pi-dispatch-worker", "AppDirectory", REPO_ROOT],
		["set", "pi-dispatch-worker", "AppStdout", `${REPO_ROOT}\\logs\\worker.out.log`],
		["set", "pi-dispatch-worker", "AppStderr", `${REPO_ROOT}\\logs\\worker.err.log`],
		["set", "pi-dispatch-worker", "AppStopMethodConsole", "15000"],
		["set", "pi-dispatch-worker", "AppThrottle", "5000"],
		["set", "pi-dispatch-worker", "AppExit", "Default", "Restart"],
		["set", "pi-dispatch-worker", "AppExit", "2", "Exit"],
	]);
	assert.match(h.text(), /nssm start pi-dispatch-worker/);
});

test("install win32: an existing service refuses without --force", async () => {
	const h = harness({ platform: "win32", argv: ["install"], plan: { "nssm status": 0 } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /--force/);
	assert.equal(h.calls.length, 1, "only the status probe ran");
});

// ---------------------------------------------------------------------------------------------------
// uninstall / status
// ---------------------------------------------------------------------------------------------------

test("uninstall linux: not installed → refusal that names both looked-at paths", async () => {
	const h = harness({ platform: "linux", argv: ["uninstall"] });
	assert.equal(await h.run(), 1);
	assert.ok(h.errText().includes(USER_UNIT), "the user-scope path it looked at is named");
	assert.ok(h.errText().includes("/etc/systemd/system/pi-dispatch-worker.service"), "the system-scope path it looked at is named");
});

test("uninstall linux: disable --now, remove the unit, daemon-reload", async () => {
	const h = harness({ platform: "linux", argv: ["uninstall"], files: { [USER_UNIT]: "[Unit]" }, plan: { systemctl: 0 } });
	assert.equal(await h.run(), 0);
	assert.equal(h.store.has(USER_UNIT), false, "unit file removed");
	assert.deepEqual(h.calls.map((c) => c.args), [
		["--user", "disable", "--now", "pi-dispatch-worker.service"],
		["--user", "daemon-reload"],
	]);
});

test("uninstall linux: a system-scope unit is never touched — the sudo commands are printed instead", async () => {
	const h = harness({ platform: "linux", argv: ["uninstall"], files: { "/etc/systemd/system/pi-dispatch-worker.service": "[Unit]" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /never touches root scope/);
	assert.match(h.errText(), /sudo systemctl disable --now pi-dispatch-worker\.service/);
	assert.equal(h.calls.length, 0);
});

test("status is informational: exits 0 whether or not anything is installed", async () => {
	const empty = harness({ platform: "linux", argv: ["status"] });
	assert.equal(await empty.run(), 0);
	assert.match(empty.text(), /not installed/);
	const installed = harness({
		platform: "linux",
		argv: ["status"],
		files: { [USER_UNIT]: "[Unit]" },
		plan: { systemctl: { code: 0, output: "active\n" } },
	});
	assert.equal(await installed.run(), 0);
	assert.match(installed.text(), /active/);
});

// ---------------------------------------------------------------------------------------------------
// restart --drain
// ---------------------------------------------------------------------------------------------------

function fakeQueue(activeSeries, events) {
	return {
		pause: async () => events.push("pause"),
		resume: async () => events.push("resume"),
		getJobCounts: async () => {
			const active = activeSeries.length > 1 ? activeSeries.shift() : activeSeries[0];
			events.push(`counts:${active}`);
			return { active };
		},
		close: async () => events.push("close"),
	};
}

test("restart --drain: pause, poll until active hits 0, restart the unit, resume — in exactly that order", async () => {
	const events = [];
	const h = harness({
		platform: "linux",
		argv: ["restart", "--drain"],
		plan: { systemctl: 0 },
		queue: fakeQueue([3, 1, 0], events),
		events,
	});
	assert.equal(await h.run(), 0);
	assert.deepEqual(events, [
		"pause",
		"counts:3",
		"sleep",
		"counts:1",
		"sleep",
		"counts:0",
		"spawn systemctl --user stop pi-dispatch-worker.service",
		"spawn systemctl --user start pi-dispatch-worker.service",
		"resume",
		"close",
	]);
});

test("restart --drain timeout: stops WITHOUT restarting, and resume is NOT called — a timed-out drain must not un-pause a queue that still has an active job", async () => {
	const events = [];
	const h = harness({
		platform: "linux",
		argv: ["restart", "--drain", "--drain-timeout", "4"],
		plan: { systemctl: 0 },
		queue: fakeQueue([2], events),
		events,
	});
	assert.equal(await h.run(), 1);
	assert.ok(!events.includes("resume"), "resume would feed jobs toward a restart that is still owed");
	assert.ok(!events.some((e) => e.startsWith("spawn")), "no restart of a unit with a job still in flight");
	assert.ok(events.includes("close"), "the queue connection is still closed");
	assert.match(h.text(), /STAYS PAUSED/);
	assert.match(h.text(), /NOT restarting/);
});

// ---------------------------------------------------------------------------------------------------
// misc surface
// ---------------------------------------------------------------------------------------------------

test("an unknown subcommand prints the service usage and exits 1; bare `service` exits 0", async () => {
	const bad = harness({ argv: ["frobnicate"] });
	assert.equal(await bad.run(), 1);
	assert.match(bad.text(), /pi-dispatch service/);
	const bare = harness({ argv: [] });
	assert.equal(await bare.run(), 0);
});

test("--user and --system together refuse; --system refuses on macOS", async () => {
	const both = harness({ platform: "linux", argv: ["install", "--user", "--system"] });
	assert.equal(await both.run(), 1);
	assert.match(both.errText(), /mutually exclusive/);
	const mac = harness({ platform: "darwin", argv: ["install", "--system"] });
	assert.equal(await mac.run(), 1);
	assert.match(mac.errText(), /user-scope only/);
});

// ---------------------------------------------------------------------------------------------------
// The real wrapper under a real sh: the exit-2 conversion and the SIGTERM forwarding are behaviour of
// deploy/worker-env-wrapper.sh itself, so these tests execute the shipped file with a stub `node` on
// PATH. POSIX-only (win32 has no sh).
// ---------------------------------------------------------------------------------------------------

const POSIX = process.platform === "linux" || process.platform === "darwin";

function wrapperDir(nodeStub) {
	const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-wrapper-"));
	mkdirSync(join(dir, "deploy"));
	writeFileSync(join(dir, "deploy", "worker-env-wrapper.sh"), readFileSync(join(REPO_ROOT, "deploy", "worker-env-wrapper.sh")));
	writeFileSync(join(dir, ".env"), "PI_WRAPPER_TEST=1\n");
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "node"), nodeStub);
	chmodSync(join(dir, "bin", "node"), 0o755);
	return dir;
}

function runWrapper(dir, { onSpawn } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("sh", [join(dir, "deploy", "worker-env-wrapper.sh")], {
			env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, MARKER_DIR: dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stderr }));
		onSpawn?.(child);
	});
}

test("wrapper: a policy refusal (node exits 2) becomes a clean exit 0 with the refusal note — KeepAlive must not relaunch it", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 2\n");
	const { code, stderr } = await runWrapper(dir);
	assert.equal(code, 0, "exit 2 is converted so SuccessfulExit=false KeepAlive leaves it stopped");
	assert.match(stderr, /policy refusal \(exit 2\)/);
	assert.match(stderr, /not restarting/);
});

test("wrapper: every other nonzero exit passes through untouched (7 stays 7, so crashes still restart)", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 7\n");
	const { code } = await runWrapper(dir);
	assert.equal(code, 7);
});

test("wrapper: SIGTERM to the wrapper reaches node (trap + kill + double wait replaces the old exec)", { skip: !POSIX }, async () => {
	// The stub records that it started, then waits; on TERM it records the delivery and exits 0. If
	// the wrapper failed to forward, the stub would sit in sleep and the test would time out. The trap
	// must kill the sleep too: an orphaned sleep inherits the wrapper's stdio pipes and would hold the
	// spawn's `close` event (and this test) hostage for the full 30s.
	const dir = wrapperDir('#!/bin/sh\n: > "$MARKER_DIR/started"\ntrap \': > "$MARKER_DIR/got-term"; kill "$sp" 2>/dev/null; exit 0\' TERM\nsleep 30 &\nsp=$!\nwait\nexit 1\n');
	const { code } = await runWrapper(dir, {
		onSpawn: async (child) => {
			// Signal only after the stub is definitely running, so the wrapper's trap is in place.
			for (let i = 0; i < 200 && !existsSync(join(dir, "started")); i++) {
				await new Promise((r) => setTimeout(r, 25));
			}
			child.kill("SIGTERM");
		},
	});
	assert.ok(existsSync(join(dir, "got-term")), "the stub received the forwarded TERM");
	assert.equal(code, 0, "the wrapper reports node's post-drain exit code, not its own interrupted wait");
});
