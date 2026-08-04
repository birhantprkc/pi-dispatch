/**
 * `pi-dispatch service` — render and install the deploy/ daemon templates for THIS host (issue #80).
 *
 * Durable running used to mean hand-editing the per-OS examples in deploy/. This module reads those
 * SAME files from the package and substitutes a documented table of their known literals —
 * `/usr/bin/node` → `process.execPath`, `/opt/pi-dispatch` → the real repo root — rather than
 * introducing a `{{placeholder}}` dialect. That keeps the deploy/ files byte-usable examples (and
 * deploy-lint keeps parsing exactly what ships); TEMPLATE_PINS below is the table's enforcement — the
 * test suite asserts every literal is still present in every template, so template drift breaks the
 * build loudly instead of breaking the render silently.
 *
 * Scope doctrine:
 *   - User-level by default, everywhere. macOS REFUSES root outright (a LaunchAgent is per-user, and a
 *     root agent could not see the login session's Docker Desktop anyway — the svc.sh precedent).
 *     Linux `--system` never executes a privileged write: it stages the render and PRINTS the exact
 *     sudo commands (the pm2-startup pattern), so root actions only ever happen in the operator's own
 *     shell.
 *   - ONE worker per docker daemon (DES-CONCURRENCY-3): install refuses a worker unit when one exists
 *     in the OTHER scope, because the worker's boot reaper kills every pi-job container it did not
 *     start — a second worker would reap the first's live jobs on every restart. Receivers are exempt
 *     from the cross-scope check (a second receiver is pointless, not destructive) but still refuse
 *     same-scope duplicates.
 *
 * `restart --drain` composes the README's manual ritual (pause → poll active → restart → resume) with
 * the same VALKEY_URL-only queue connection as cli.mjs's pause/resume: the drain must work even when
 * the rest of the config is broken.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Deploy templates resolved relative to this module (the init.mjs pattern): worker/deploy is SHIPPED
// in the npm tarball and kept byte-identical to the repo-root deploy/ (the documented source) by
// worker/test/publish.test.mjs — so `service` renders the same templates from a checkout and from an
// npm install, no matter where the CLI is invoked from.
const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The whole substitution surface, template by template. The render replaces ONLY these literals (plus
 * the scope-dependent `User=` / `WantedBy=` rewrites called out below); the pin test in
 * worker/test/service.test.mjs asserts each one is still present in the real deploy/ file, so an edit
 * to a template that would break the render fails the build instead of shipping a broken `service`.
 */
export const TEMPLATE_PINS = {
	"worker.service": [
		"ExecStart=/usr/bin/node worker/src/cli.mjs worker", // /usr/bin/node → process.execPath
		"WorkingDirectory=/opt/pi-dispatch", // /opt/pi-dispatch → the real repo root
		"EnvironmentFile=/opt/pi-dispatch/.env",
		"\nUser=pi\n", // the DIRECTIVE line (the header comment also says User=pi mid-line, hence the \n anchors): stripped for --user scope; rewritten to the invoking user for --system
		"WantedBy=multi-user.target", // → default.target in user scope (multi-user.target never runs there)
		// Byte-for-byte survivors — semantics the render must not lose:
		"RestartPreventExitStatus=2", // EXIT_POLICY is never restarted (a retry loop is a bill)
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	"receiver.service": [
		"ExecStart=/usr/bin/node receiver/src/start.mjs",
		"WorkingDirectory=/opt/pi-dispatch",
		"EnvironmentFile=/opt/pi-dispatch/.env",
		"\nUser=pi\n",
		"WantedBy=multi-user.target",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	"com.pi-dispatch.worker.plist": [
		"<string>com.pi-dispatch.worker</string>", // → com.pi-dispatch.receiver for --receiver
		"<string>/opt/pi-dispatch/deploy/worker-env-wrapper.sh</string>", // gains a `receiver` argument for --receiver
		"<key>WorkingDirectory</key>\n\t<string>/opt/pi-dispatch</string>", // anchor for the PATH injection below
		"<string>/opt/pi-dispatch/logs/worker.out.log</string>",
		"<string>/opt/pi-dispatch/logs/worker.err.log</string>",
		"<key>SuccessfulExit</key>", // the KeepAlive shape the wrapper's exit-2 conversion pairs with
		"<integer>30</integer>", // ExitTimeOut — room for the SIGTERM drain
	],
	// Windows is command-driven, not file-rendered: install SPAWNS nssmSequence() below instead of
	// copying the .cmd. These pins hold the worked example to the same values the sequence uses, so
	// the two cannot drift apart — especially the AppExit pair, which is the EXIT_POLICY never-retry.
	"nssm-install.cmd": [
		"pi-dispatch-worker",
		"C:\\pi-dispatch", // the REPO placeholder → the real repo root
		"deploy\\worker-env-wrapper.cmd",
		"AppStopMethodConsole 15000",
		"AppThrottle 5000",
		"AppExit Default Restart",
		"AppExit 2 Exit",
	],
};

const SUBCOMMANDS = new Set(["render", "install", "uninstall", "status", "start", "stop", "restart"]);

const SERVICE_USAGE = `pi-dispatch service — run the worker (or --receiver) as an OS service, rendered for THIS host

  pi-dispatch service render                the unit(s) with this host's real node + repo paths
  pi-dispatch service install [--force]     write + enable the user-level unit
                                            (linux --system: prints the exact sudo commands, runs nothing)
  pi-dispatch service uninstall             stop, disable and remove the installed unit
  pi-dispatch service status                which unit exists in which scope, and whether it is active
  pi-dispatch service start|stop            thin launchctl / systemctl --user / nssm wrappers
  pi-dispatch service restart [--drain]     restart; --drain pauses the queue, waits for active jobs
                                            to finish, restarts, resumes  [--drain-timeout <s>, default 600]

  flags: --receiver          the webhook receiver instead of the worker
         --user | --system   linux scope (default --user; --system never executes root commands)
         --force             replace an existing unit in the same scope
         --print             also print the rendered unit before installing
`;

export async function runService(argv = [], deps = {}) {
	const {
		env = process.env,
		platform = process.platform,
		euid = typeof process.geteuid === "function" ? process.geteuid() : null,
		execPath = process.execPath,
		repoRoot = REPO_ROOT,
		home = homedir(),
		user = env.USER || userInfo().username,
		tmp = tmpdir(),
		fs = { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync },
		spawn = nodeSpawn,
		out = (s) => process.stdout.write(s),
		err = (s) => process.stderr.write(s),
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		now = () => Date.now(),
		queue = null, // test seam; production builds one lazily in doRestart from VALKEY_URL
	} = deps;

	let values, positionals;
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				receiver: { type: "boolean", default: false },
				user: { type: "boolean", default: false },
				system: { type: "boolean", default: false },
				force: { type: "boolean", default: false },
				print: { type: "boolean", default: false },
				drain: { type: "boolean", default: false },
				"drain-timeout": { type: "string" },
			},
		}));
	} catch (error) {
		return fail(err, error.message);
	}

	const cmd = positionals[0];
	if (!cmd || !SUBCOMMANDS.has(cmd)) {
		out(SERVICE_USAGE);
		return cmd ? 1 : 0; // bare `service` is a usage view, an unknown subcommand is an error
	}
	if (values.user && values.system) return fail(err, "--user and --system are mutually exclusive");
	if (platform === "darwin" && values.system) {
		return fail(err, "macOS is user-scope only (a LaunchAgent): Docker Desktop lives in the login session, so a system daemon would wait on a docker socket that only exists once you log in. Drop --system.");
	}
	if (platform === "win32" && (values.user || values.system)) {
		return fail(err, "Windows services via nssm are machine-scoped; --user/--system do not apply here");
	}
	if (!["darwin", "linux", "win32"].includes(platform)) return fail(err, `unsupported platform: ${platform}`);

	const ctx = {
		env,
		platform,
		euid,
		execPath,
		repoRoot,
		home,
		user,
		tmp,
		fs,
		spawn,
		out,
		err,
		sleep,
		now,
		queue,
		which: values.receiver ? "receiver" : "worker",
		scope: platform === "linux" && values.system ? "system" : "user",
		force: values.force,
	};

	switch (cmd) {
		case "render":
			return doRender(ctx);
		case "install":
			// --print is implied for render and opt-in here: see what will be written, then write it.
			if (values.print) doRender(ctx);
			return doInstall(ctx);
		case "uninstall":
			return doUninstall(ctx);
		case "status":
			return doStatus(ctx);
		case "start":
			return doStart(ctx);
		case "stop":
			return doStop(ctx);
		case "restart":
			return doRestart(ctx, values);
	}
}

/**
 * Where each unit lives (or is looked for) per platform. `otherScopeWorkerPaths` exists only to
 * enforce DES-CONCURRENCY-3 at install time — those locations are READ, never written. On Linux the
 * system-scope check covers both our canonical name and `worker.service`, the name the README's
 * manual `sudo cp` instructions produce: a hand-installed worker is still a second worker.
 */
function unitPaths(ctx) {
	if (ctx.platform === "darwin") {
		const label = `com.pi-dispatch.${ctx.which}`;
		return {
			name: label,
			installPath: join(ctx.home, "Library", "LaunchAgents", `${label}.plist`),
			systemPath: join("/Library/LaunchDaemons", `${label}.plist`),
			otherScopeWorkerPaths: ["/Library/LaunchDaemons/com.pi-dispatch.worker.plist"],
		};
	}
	if (ctx.platform === "linux") {
		const unit = `pi-dispatch-${ctx.which}.service`;
		const userPath = join(ctx.home, ".config", "systemd", "user", unit);
		const systemPath = join("/etc/systemd/system", unit);
		return {
			name: unit,
			userPath,
			systemPath,
			installPath: ctx.scope === "system" ? systemPath : userPath,
			otherScopeWorkerPaths:
				ctx.scope === "system"
					? [join(ctx.home, ".config", "systemd", "user", "pi-dispatch-worker.service")]
					: ["/etc/systemd/system/pi-dispatch-worker.service", "/etc/systemd/system/worker.service"],
		};
	}
	// win32: the unit is an nssm-registered service, not a file this tool addresses. Same-scope
	// detection happens via `nssm status`, and there is no second scope to cross-check.
	return { name: `pi-dispatch-${ctx.which}` };
}

function readTemplate(ctx, name) {
	return ctx.fs.readFileSync(join(DEPLOY_DIR, name), "utf8");
}

/**
 * Render worker.service / receiver.service for this host. Targeted substitution of the templates'
 * known literals (see TEMPLATE_PINS); everything else — RestartPreventExitStatus=2, the StartLimit
 * crash-loop bound, KillSignal, TimeoutStopSec — passes through byte-for-byte.
 */
function renderLinuxUnit(ctx) {
	const template = ctx.which === "receiver" ? "receiver.service" : "worker.service";
	// The banner outranks the template's own "TEMPLATE/UNTESTED EXAMPLE — set the PLACEHOLDERs" header,
	// which renders through below (the no-markers design keeps templates byte-usable, so their prose
	// survives): a reader of the rendered unit should know the placeholders are already substituted.
	let unit = `# rendered by \`pi-dispatch service\` — paths computed for this host from deploy/${template};\n# the template's PLACEHOLDER prose below is already substituted.\n` +
		readTemplate(ctx, template)
		.replaceAll("/opt/pi-dispatch", ctx.repoRoot)
		.replaceAll("/usr/bin/node", ctx.execPath);
	if (ctx.scope === "user") {
		// A systemd --user unit always runs as the invoking user, and systemd REJECTS a User= line in
		// user scope ("Unknown lvalue"); the line must not survive the render. The replacement is a
		// comment so the rendered unit explains its own difference from the shipped template. Anchored
		// to the whole line (^…$) because the template's header comment ALSO says "User=pi" mid-line —
		// a bare replace would rewrite the prose and leave the directive standing.
		unit = unit.replace(
			/^User=pi$/m,
			"# User= stripped by `pi-dispatch service`: a --user unit always runs as the invoking user,\n# and systemd rejects User= in user scope.",
		);
		// multi-user.target exists only in the SYSTEM instance. A user unit enabled into it would
		// symlink into a .wants/ directory no user-instance boot ever walks — enabled but never
		// started. default.target is the user manager's boot target.
		unit = unit.replace("WantedBy=multi-user.target", "WantedBy=default.target");
	} else {
		unit = unit.replace(/^User=pi$/m, `User=${ctx.user}`);
	}
	return unit;
}

/**
 * Render the launchd plist for this host. For --receiver the worker plist is DERIVED, not a second
 * template: same KeepAlive/ExitTimeOut shape, label and log names swapped, and the shared wrapper told
 * (via its one argument) to run the receiver. The wrapper's exit-2 conversion is a no-op for the
 * receiver — it has no EXIT_POLICY — and harmless.
 */
function renderPlist(ctx) {
	let plist = readTemplate(ctx, "com.pi-dispatch.worker.plist");
	if (ctx.which === "receiver") {
		plist = plist
			.replace("<string>com.pi-dispatch.worker</string>", "<string>com.pi-dispatch.receiver</string>")
			.replace(
				"<string>/opt/pi-dispatch/deploy/worker-env-wrapper.sh</string>",
				"<string>/opt/pi-dispatch/deploy/worker-env-wrapper.sh</string>\n\t\t<!-- the argument that makes the shared .env wrapper run the receiver instead of the worker -->\n\t\t<string>receiver</string>",
			)
			.replaceAll("worker.out.log", "receiver.out.log")
			.replaceAll("worker.err.log", "receiver.err.log");
	}
	// launchd's default PATH is /usr/bin:/bin — an nvm or Homebrew node is invisible to it, and the
	// wrapper invokes bare `node`. Prepend the directory of the node that ran this render so the
	// service runs the SAME binary, no guessing. PATH is configuration, not a secret: the template's
	// deliberate no-EnvironmentVariables stance is about credentials, which still live only in .env.
	plist = plist.replace(
		"<key>WorkingDirectory</key>\n\t<string>/opt/pi-dispatch</string>",
		"<key>WorkingDirectory</key>\n\t<string>/opt/pi-dispatch</string>\n\n\t<!-- Injected by `pi-dispatch service`: launchd's default PATH cannot see an nvm/Homebrew node,\n\t     and the wrapper calls bare `node`. Not a secrets dict - credentials still live only in .env\n\t     (see the header comment). -->\n\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>" +
			`${dirname(ctx.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin</string>\n\t</dict>`,
	);
	return plist.replaceAll("/opt/pi-dispatch", ctx.repoRoot);
}

/**
 * The nssm command sequence — deploy/nssm-install.cmd's exact steps with computed paths. Values that
 * carry semantics (AppStopMethodConsole 15000, AppThrottle 5000, AppExit Default Restart, AppExit 2
 * Exit) mirror the template byte-for-byte and are pinned. Backslashes on purpose: this argv reaches
 * nssm on a real Windows host, where repoRoot is already a Windows path.
 */
function nssmSequence(ctx) {
	const service = `pi-dispatch-${ctx.which}`;
	const logDir = `${ctx.repoRoot}\\logs`;
	return {
		service,
		commands: [
			["install", service, `${ctx.repoRoot}\\deploy\\worker-env-wrapper.cmd`, ...(ctx.which === "receiver" ? ["receiver"] : [])],
			["set", service, "AppDirectory", ctx.repoRoot],
			["set", service, "AppStdout", `${logDir}\\${ctx.which}.out.log`],
			["set", service, "AppStderr", `${logDir}\\${ctx.which}.err.log`],
			["set", service, "AppStopMethodConsole", "15000"],
			["set", service, "AppThrottle", "5000"],
			["set", service, "AppExit", "Default", "Restart"],
			["set", service, "AppExit", "2", "Exit"],
		],
	};
}

function doRender(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "darwin") {
		ctx.out(`# → ${paths.installPath}\n`);
		ctx.out(renderPlist(ctx));
		ctx.out(
			"\n# note: ProgramArguments runs deploy/worker-env-wrapper.sh — launchd has no EnvironmentFile,\n# so the wrapper loads .env at runtime. The wrapper also converts a policy refusal (exit 2,\n# EXIT_POLICY) into a clean exit, so KeepAlive never relaunch-loops a refusal into a provider bill.\n",
		);
		return 0;
	}
	if (ctx.platform === "linux") {
		ctx.out(`# → ${paths.installPath}\n`);
		ctx.out(renderLinuxUnit(ctx));
		return 0;
	}
	const { service, commands } = nssmSequence(ctx);
	ctx.out("The nssm sequence for this host (nssm.exe: https://nssm.cc, or `winget install nssm`):\n\n");
	for (const args of commands) ctx.out(`  nssm ${quoteArgs(args)}\n`);
	ctx.out(`  nssm start ${service}\n`);
	return 0;
}

async function doInstall(ctx) {
	const paths = unitPaths(ctx);

	// THE refusal, worker only: one worker per docker daemon (DES-CONCURRENCY-3). The worker's boot
	// reaper treats every running pi-job container as an orphan of its OWN previous life and kills it,
	// so a second worker — even in the other scope — would reap the first worker's live jobs on every
	// restart. Receivers are exempt: a second receiver is pointless, not destructive.
	if (ctx.which === "worker") {
		const other = paths.otherScopeWorkerPaths?.find((p) => ctx.fs.existsSync(p));
		if (other) {
			return fail(
				ctx.err,
				`a worker unit already exists in the other scope: ${other}\n` +
					"one worker per docker daemon (DES-CONCURRENCY-3): the worker's boot reaper kills every pi-job container it did not start, so a second worker would kill the first's live jobs. Remove that unit first.",
			);
		}
	}

	if (ctx.platform === "darwin") return installDarwin(ctx, paths);
	if (ctx.platform === "linux") return ctx.scope === "system" ? installLinuxSystem(ctx, paths) : installLinuxUser(ctx, paths);
	return installWindows(ctx);
}

async function installDarwin(ctx, paths) {
	// Root refusal (the svc.sh darwin precedent): sudo would bootstrap into ROOT's gui domain and
	// write root's LaunchAgents — a unit the operator's own session neither sees nor controls, running
	// outside the login session that owns Docker Desktop.
	if (ctx.euid === 0) {
		return fail(
			ctx.err,
			"refusing to run as root on macOS: the unit belongs in YOUR ~/Library/LaunchAgents, bootstrapped into your gui domain — sudo would install it for root, outside the login session that owns Docker Desktop. Re-run without sudo.",
		);
	}
	const existed = ctx.fs.existsSync(paths.installPath);
	if (existed && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to replace and re-bootstrap it (same non-clobber contract as init)`);
	}
	if (existed) {
		// --force replaces a possibly-loaded unit: bootstrap refuses an already-loaded label, so boot
		// the old copy out first. "Not loaded" is a fine answer — the nonzero exit is ignored.
		await run(ctx, "launchctl", ["bootout", `gui/${ctx.euid}/${paths.name}`]);
	}
	ctx.fs.mkdirSync(dirname(paths.installPath), { recursive: true });
	ctx.fs.writeFileSync(paths.installPath, renderPlist(ctx));
	const bootstrap = await run(ctx, "launchctl", ["bootstrap", `gui/${ctx.euid}`, paths.installPath]);
	if (bootstrap !== 0) {
		return fail(ctx.err, `launchctl bootstrap failed (exit ${bootstrap}) — the plist is written; retry by hand: launchctl bootstrap gui/${ctx.euid} ${paths.installPath}`);
	}
	const enable = await run(ctx, "launchctl", ["enable", `gui/${ctx.euid}/${paths.name}`]);
	if (enable !== 0) return fail(ctx.err, `launchctl enable gui/${ctx.euid}/${paths.name} failed (exit ${enable})`);
	ctx.out(`installed ${paths.name} → ${paths.installPath} (bootstrapped into gui/${ctx.euid}; RunAtLoad starts it now and on login)\n`);
	// The honest note: no pretending a LaunchAgent is a boot daemon. It is the right fit anyway.
	ctx.out(
		"note: a LaunchAgent is LOGIN-scoped — it runs while you are logged in, not from boot. That is the honest fit here: Docker Desktop is itself login-scoped, so a boot-time daemon would only wait on a docker socket that appears at login anyway.\n",
	);
	return 0;
}

async function installLinuxUser(ctx, paths) {
	if (ctx.fs.existsSync(paths.installPath) && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to replace it (same non-clobber contract as init)`);
	}
	ctx.fs.mkdirSync(dirname(paths.installPath), { recursive: true });
	ctx.fs.writeFileSync(paths.installPath, renderLinuxUnit(ctx));
	const reload = await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	if (reload === null) return fail(ctx.err, `systemctl not found — is this a systemd host? The unit is written at ${paths.installPath}`);
	const enable = await run(ctx, "systemctl", ["--user", "enable", "--now", paths.name]);
	if (enable !== 0) {
		return fail(ctx.err, `systemctl --user enable --now ${paths.name} failed (exit ${enable}) — the unit is written at ${paths.installPath}; \`systemctl --user status ${paths.name}\` has the details`);
	}
	ctx.out(`installed ${paths.name} → ${paths.installPath} (enabled and started in your user manager)\n`);
	// Without linger a user manager only runs while a session exists — fine on a desktop, a silent
	// no-worker-after-reboot on a headless box. Say so instead of letting the operator find out.
	ctx.out(`note: user units run while you have a session. For a headless host that must start at boot:  sudo loginctl enable-linger ${ctx.user}\n`);
	return 0;
}

async function installLinuxSystem(ctx, paths) {
	if (ctx.fs.existsSync(paths.installPath) && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to re-stage the render (the printed sudo commands would overwrite it)`);
	}
	// The pm2-startup pattern: this tool NEVER writes or spawns as root. The render is staged where
	// the operator can read it, and the exact commands are printed — their shell is the consent gate.
	const staged = join(ctx.tmp, paths.name);
	ctx.fs.writeFileSync(staged, renderLinuxUnit(ctx));
	ctx.out(`--system never runs root commands from this tool. The rendered unit is staged at:\n  ${staged}\n\nInspect it, then run:\n  sudo install -m 644 ${staged} ${paths.installPath}\n  sudo systemctl daemon-reload\n  sudo systemctl enable --now ${paths.name}\n`);
	return 0;
}

async function installWindows(ctx) {
	const { service, commands } = nssmSequence(ctx);
	// One probe answers two questions: is nssm on PATH (ENOENT → no), and does the service already
	// exist (exit 0 → yes). Task Scheduler is deliberately never offered — it stops tasks with a hard
	// kill, so the worker could never drain (see deploy/nssm-install.cmd's rationale).
	const status = await runCapture(ctx, "nssm", ["status", service]);
	if (status.code === null) {
		return fail(ctx.err, "nssm.exe not found on PATH — download it from https://nssm.cc (or `winget install nssm`) and re-run. Task Scheduler is not a substitute: it kills instead of stopping, so the worker could never drain.");
	}
	if (status.code === 0 && !ctx.force) {
		return fail(ctx.err, `service ${service} already exists (nssm status reports it) — pass --force to remove and re-install it`);
	}
	if (status.code === 0) {
		await run(ctx, "nssm", ["stop", service]); // may already be stopped; nonzero is fine
		const removed = await run(ctx, "nssm", ["remove", service, "confirm"]);
		if (removed !== 0) return fail(ctx.err, `nssm remove ${service} confirm failed (exit ${removed})`);
	}
	for (const args of commands) {
		const code = await run(ctx, "nssm", args);
		if (code !== 0) return fail(ctx.err, `nssm ${args.join(" ")} failed (exit ${code})`);
	}
	// Mirrors the template's own last line: install registers, `nssm start` is the one visible step
	// left to the operator (the service auto-starts on the next boot either way).
	ctx.out(`installed service ${service}. Start it with:  nssm start ${service}\n`);
	return 0;
}

async function doUninstall(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "win32") {
		const status = await runCapture(ctx, "nssm", ["status", paths.name]);
		if (status.code === null) return fail(ctx.err, "nssm.exe not found on PATH — it is also how uninstall talks to the service manager (https://nssm.cc)");
		if (status.code !== 0) return fail(ctx.err, `service ${paths.name} is not installed (\`nssm status ${paths.name}\` reports none)`);
		await run(ctx, "nssm", ["stop", paths.name]); // already-stopped is fine
		const removed = await run(ctx, "nssm", ["remove", paths.name, "confirm"]);
		if (removed !== 0) return fail(ctx.err, `nssm remove ${paths.name} confirm failed (exit ${removed})`);
		ctx.out(`uninstalled service ${paths.name}\n`);
		return 0;
	}
	const userPath = ctx.platform === "darwin" ? paths.installPath : paths.userPath;
	if (!ctx.fs.existsSync(userPath)) {
		// Say where it looked — both scopes — and if the unit turns out to live in ROOT scope, print
		// the removal commands instead of touching them (the same never-root doctrine as install).
		if (ctx.fs.existsSync(paths.systemPath)) {
			const rootCmds =
				ctx.platform === "darwin"
					? `  sudo launchctl bootout system/${paths.name}\n  sudo rm ${paths.systemPath}`
					: `  sudo systemctl disable --now ${paths.name}\n  sudo rm ${paths.systemPath}\n  sudo systemctl daemon-reload`;
			return fail(ctx.err, `not installed in user scope (looked at ${userPath}); a SYSTEM-scope unit exists at ${paths.systemPath} — this tool never touches root scope. Remove it with:\n${rootCmds}`);
		}
		return fail(ctx.err, `${paths.name} is not installed — looked at ${userPath} (user scope) and ${paths.systemPath} (system scope)`);
	}
	if (ctx.platform === "darwin") {
		await run(ctx, "launchctl", ["bootout", `gui/${ctx.euid}/${paths.name}`]); // not-loaded is fine
		ctx.fs.unlinkSync(userPath);
		ctx.out(`uninstalled ${paths.name} (booted out of gui/${ctx.euid}, plist removed)\n`);
		return 0;
	}
	await run(ctx, "systemctl", ["--user", "disable", "--now", paths.name]); // not-enabled is fine
	ctx.fs.unlinkSync(userPath);
	await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	ctx.out(`uninstalled ${paths.name} (disabled, stopped, unit removed)\n`);
	return 0;
}

/** Informational only — reports every scope it knows about and always exits 0. */
async function doStatus(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "win32") {
		const status = await runCapture(ctx, "nssm", ["status", paths.name]);
		if (status.code === null) ctx.out(`${paths.name}: cannot query — nssm.exe not on PATH (https://nssm.cc)\n`);
		else if (status.code !== 0) ctx.out(`${paths.name}: not installed\n`);
		else ctx.out(`${paths.name}: ${status.output.trim()}\n`);
		return 0;
	}
	if (ctx.platform === "darwin") {
		if (ctx.fs.existsSync(paths.installPath)) {
			const print = await runCapture(ctx, "launchctl", ["print", `gui/${ctx.euid}/${paths.name}`]);
			ctx.out(`user scope: ${paths.installPath} — ${print.code === 0 ? "loaded" : "installed but NOT loaded (launchctl bootstrap it, or `pi-dispatch service start`)"}\n`);
		} else {
			ctx.out(`user scope: not installed (${paths.installPath})\n`);
		}
		ctx.out(ctx.fs.existsSync(paths.systemPath) ? `system scope: ${paths.systemPath} EXISTS — not managed by this tool\n` : "system scope: none\n");
		return 0;
	}
	if (ctx.fs.existsSync(paths.userPath)) {
		const active = await runCapture(ctx, "systemctl", ["--user", "is-active", paths.name]);
		ctx.out(`user scope: ${paths.userPath} — ${active.code === null ? "systemctl not found" : active.output.trim() || "unknown"}\n`);
	} else {
		ctx.out(`user scope: not installed (${paths.userPath})\n`);
	}
	const systemHits = [paths.systemPath, ...(ctx.which === "worker" ? ["/etc/systemd/system/worker.service"] : [])].filter((p) => ctx.fs.existsSync(p));
	ctx.out(systemHits.length ? `system scope: ${systemHits.join(", ")} EXISTS — not managed by this tool\n` : "system scope: none\n");
	return 0;
}

async function doStart(ctx) {
	return startStop(ctx, "start");
}

async function doStop(ctx) {
	return startStop(ctx, "stop");
}

/**
 * Thin per-OS start/stop. macOS stop is `launchctl kill SIGTERM`, NOT bootout: bootout unloads the
 * unit entirely, while kill delivers the same graceful SIGTERM systemd's stop does — the worker
 * drains, exits 0, and KeepAlive's SuccessfulExit=false leaves a clean exit stopped.
 */
async function startStop(ctx, verb) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "linux" && ctx.scope === "system") {
		return fail(ctx.err, `--system is print-only (this tool never runs root commands). Run:\n  sudo systemctl ${verb} ${paths.name}`);
	}
	let code;
	if (ctx.platform === "darwin") {
		code =
			verb === "start"
				? await run(ctx, "launchctl", ["kickstart", `gui/${ctx.euid}/${paths.name}`])
				: await run(ctx, "launchctl", ["kill", "SIGTERM", `gui/${ctx.euid}/${paths.name}`]);
	} else if (ctx.platform === "linux") {
		code = await run(ctx, "systemctl", ["--user", verb, paths.name]);
	} else {
		code = await run(ctx, "nssm", [verb, paths.name]);
	}
	if (code !== 0) return fail(ctx.err, `${verb} ${paths.name} failed (${code === null ? "service tool not found" : `exit ${code}`}) — is it installed? (pi-dispatch service status)`);
	ctx.out(`${verb === "start" ? "started" : "stopped"} ${paths.name}\n`);
	return 0;
}

async function doRestart(ctx, values) {
	if (!values.drain) {
		const stopped = await doStop(ctx);
		if (stopped !== 0) return stopped;
		return doStart(ctx);
	}

	const timeoutS = Number(values["drain-timeout"] ?? "600");
	if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
		return fail(ctx.err, `--drain-timeout must be a positive number of seconds, got: ${values["drain-timeout"]}`);
	}
	let queue = ctx.queue;
	if (!queue) {
		// VALKEY_URL only, exactly like cli.mjs's pause/resume: the drain must work even when the rest
		// of the config (forge auth …) is broken, and failFast keeps a down Valkey an error in seconds
		// instead of a hung restart. Lazy imports for the same reason cli.mjs uses them: `service`
		// subcommands that never touch the queue must not load bullmq/ioredis.
		const url = ctx.env.VALKEY_URL ?? "redis://127.0.0.1:6379";
		const { parseConnection } = await import("./connection.mjs");
		const { makeQueue } = await import("./queue.mjs");
		queue = makeQueue(parseConnection(url, { failFast: true }));
	}
	try {
		await queue.pause();
		ctx.out("paused — no new jobs will start; waiting for active jobs to finish\n");
		const deadline = ctx.now() + timeoutS * 1000;
		let { active = 0 } = await queue.getJobCounts("active");
		while (active > 0) {
			if (ctx.now() >= deadline) {
				// Deliberately NO resume and NO restart: a job is still running. Restarting would abort
				// it; resuming would feed new jobs toward a restart that is still owed. Paused is the
				// safe durable state (it survives the restart the operator will now do by hand).
				ctx.out(
					`drain timed out after ${timeoutS}s with ${active} job(s) still active — NOT restarting.\nThe queue STAYS PAUSED so the running job can finish undisturbed. Investigate (pi-dispatch status), then restart and \`pi-dispatch resume\` yourself.\n`,
				);
				return 1;
			}
			ctx.out(`  ${active} active — waiting\n`);
			await ctx.sleep(2000);
			({ active = 0 } = await queue.getJobCounts("active"));
		}
		const stopped = await doStop(ctx);
		if (stopped !== 0) {
			ctx.out("restart did not happen — the queue STAYS PAUSED; fix the service, then `pi-dispatch resume`.\n");
			return 1;
		}
		const started = await doStart(ctx);
		if (started !== 0) {
			ctx.out("the service did not come back — the queue STAYS PAUSED; fix the service, then `pi-dispatch resume`.\n");
			return 1;
		}
		await queue.resume();
		ctx.out("resumed — drained restart complete\n");
		return 0;
	} catch (error) {
		return fail(ctx.err, `could not reach Valkey — is it running? (docker compose up)\n  ${error.message}`);
	} finally {
		await queue.close().catch(() => {});
	}
}

function fail(err, message) {
	err(`error: ${message}\n`);
	return 1;
}

/** Re-join an argv for display; quote what cmd.exe would split (spaces) or what is a path (backslashes). */
function quoteArgs(args) {
	return args.map((a) => (a.includes(" ") || a.includes("\\") ? `"${a}"` : a)).join(" ");
}

/** Exit code of a spawned command; null when it could not launch (not on PATH) — the up.mjs pattern. */
function run(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolvePromise(null);
			return;
		}
		child.on("error", () => resolvePromise(null));
		child.on("close", (code) => resolvePromise(code));
	});
}

/** Like run() but with stdout+stderr captured, for read-only lookups (nssm status, is-active …). */
function runCapture(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolvePromise({ code: null, output: "" });
			return;
		}
		let output = "";
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("error", () => resolvePromise({ code: null, output }));
		child.on("close", (code) => resolvePromise({ code, output }));
	});
}
