/**
 * `pi-dispatch import-pi` — stage a CREDENTIAL-FREE copy of the host's `pi` setup into a global overlay
 * dir, so every job can reuse it (REQ-GLOBAL-PI-OVERLAY). Point `PI_GLOBAL_PI_DIR` at the result and the
 * worker mounts it `:ro` into each container, layered UNDER each repo's own `.pi/`.
 *
 * The overlay must never carry a secret (CONST-TOKEN-SCOPED-PER-JOB): the provider key stays in the host's
 * `auth.json` / env and reaches the container through the env allowlist, never a mounted file. So this
 * command copies only the safe subset and REFUSES a `models.json` that embeds a literal key.
 *
 * Copied:   models.json (definitions only, sanitized), skills/, APPEND_SYSTEM.md, and — only under
 *           --with-extensions — extensions/ (verbatim; the admin extension is hard-blocked).
 * Staged:   packages/ — only under --with-packages — pinned third-party pi packages, installed here on the
 *           host so a job container can load them from the overlay with NO network access (issue #58).
 * Never:    auth.json, settings.json, sessions/, themes/, prompts/, tools/.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PACKAGES_SUBDIR, STAGE_MANIFEST, parsePackagesFile } from "./packages.mjs";

/** A valid skill/extension entry name: lowercase kebab/underscore, no dots (no "..") and no slashes. */
export const ENTRY_NAME_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9])?$/i;
/** The admin extension — never duplicated into a job overlay (it can enqueue paid jobs: a recursion vector). */
export const ADMIN_RE = /pi-dispatch|dispatch-admin/i;

/** The pi resource kinds a package may contribute by convention dir, when it carries no `pi` manifest. */
const RESOURCE_DIRS = ["extensions", "skills", "prompts", "themes"];

const execFileAsync = promisify(execFile);

/**
 * The default package-stager runner. ARRAY argv, never a shell string -- a package name from a config file
 * must never be able to become shell syntax on the operator's host. See `npmExecOptions` for the one
 * platform on which `shell: true` is nonetheless unavoidable, and why it is safe there.
 */
function defaultExec(file, args, options) {
	return execFileAsync(file, args, options);
}

// Resolve the host's pi agent dir the way pi's getAgentDir() does (env override, else ~/.pi/agent).
// Custom: the worker CLI depends on @earendil-works/pi-ai/compat, not the whole pi-coding-agent SDK;
// importing the SDK just to read one well-known path is not worth the weight.
function defaultFrom(env) {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** A config value that defers to the environment/a command rather than embedding a literal secret. */
function isIndirection(v) {
	return typeof v === "string" && (v.startsWith("$") || v.startsWith("!"));
}

/**
 * Find a literal secret in a parsed models.json. Returns a human-readable location, or null if clean.
 * A provider `apiKey`, or an auth-ish header, that is a plain string (not `$ENV` / `!cmd`) is a literal.
 */
export function findLiteralSecret(models) {
	const providers = models?.providers;
	if (!providers || typeof providers !== "object") return null;
	for (const [name, cfg] of Object.entries(providers)) {
		if (typeof cfg?.apiKey === "string" && !isIndirection(cfg.apiKey)) return `providers.${name}.apiKey`;
		const headers = cfg?.headers;
		if (headers && typeof headers === "object") {
			for (const [h, val] of Object.entries(headers)) {
				if (/auth|api[-_]?key|token|secret|bearer/i.test(h) && typeof val === "string" && !isIndirection(val)) {
					return `providers.${name}.headers.${h}`;
				}
			}
		}
	}
	return null;
}

export async function runImportPi(argv = [], deps = {}) {
	const {
		env = process.env,
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		fs = { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync, rmSync },
		exec = defaultExec,
		// Injected like `fs`/`exec`/`out` so the win32 npm branch below is reachable from a test on any host;
		// it is the branch that was dead on arrival precisely because nothing could exercise it here.
		platform = process.platform,
	} = deps;

	const withExtensions = argv.includes("--with-extensions");
	const withPackages = argv.includes("--with-packages");
	const from = flagValue(argv, "--from") ?? defaultFrom(env);
	const to = flagValue(argv, "--to") ?? join(cwd, "pi-global");
	const packagesFile = flagValue(argv, "--packages-file") ?? env.PI_PACKAGES_FILE ?? join(cwd, "pi-packages.json");

	if (!fs.existsSync(from)) {
		out(`error: no pi setup found at ${from}\n  Is pi installed and configured? Set PI_CODING_AGENT_DIR or pass --from <dir>.\n`);
		return 1;
	}

	// Pre-flight the one hard security gate BEFORE writing anything: a literal key in models.json aborts the
	// whole import so no half-overlay is produced and no secret is ever written to the overlay.
	const modelsSrc = join(from, "models.json");
	let modelsText;
	if (fs.existsSync(modelsSrc)) {
		modelsText = fs.readFileSync(modelsSrc, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(modelsText);
		} catch {
			modelsText = null; // malformed: skip it with a warning rather than abort the whole import
		}
		if (parsed) {
			const leak = findLiteralSecret(parsed);
			if (leak) {
				out(
					`error: ${modelsSrc} embeds a literal secret at ${leak}.\n` +
						`  The overlay is mounted into an adversarial-input container, so it must be credential-free.\n` +
						`  Move the key to auth.json (\`pi\` login) or reference the environment (e.g. "$MY_KEY"), then re-run.\n`,
				);
				return 1;
			}
		}
	}

	const results = [];
	fs.mkdirSync(to, { recursive: true });

	// models.json — definitions only, already proven literal-secret-free above.
	if (modelsText) {
		fs.writeFileSync(join(to, "models.json"), modelsText);
		results.push(["models.json", "custom model/provider definitions (credential-free)"]);
	} else if (fs.existsSync(modelsSrc)) {
		results.push(["models.json", "SKIPPED — not valid JSON"]);
	}

	// skills/ — copy each named skill dir (SKILL.md + its files), skipping symlinks and odd names.
	const skillsCount = copyNamedDirs(fs, join(from, "skills"), join(to, "skills"), out);
	if (skillsCount > 0) results.push(["skills/", `${skillsCount} skill${skillsCount === 1 ? "" : "s"}`]);

	// APPEND_SYSTEM.md — the operator's global persona.
	if (fs.existsSync(join(from, "APPEND_SYSTEM.md"))) {
		fs.copyFileSync(join(from, "APPEND_SYSTEM.md"), join(to, "APPEND_SYSTEM.md"));
		results.push(["APPEND_SYSTEM.md", "global persona (layers under each repo's persona)"]);
	}

	// extensions/ — the sharp edge. Off unless --with-extensions; the admin extension is always blocked.
	const extSrc = join(from, "extensions");
	if (withExtensions && fs.existsSync(extSrc)) {
		const { copied, blocked } = copyExtensions(fs, extSrc, join(to, "extensions"), out);
		if (copied > 0) results.push(["extensions/", `${copied} extension${copied === 1 ? "" : "s"} — VET THESE`]);
		for (const name of blocked) out(`  blocked extension "${name}" — the admin extension must never run inside a job.\n`);
		out(
			"\n⚠ Extensions run code against adversarial input with open network egress and are NOT scanned for\n" +
				"  secrets. Review every one, then arm them with PI_GLOBAL_ALLOW_EXTENSIONS=1 (they stay dormant otherwise).\n",
		);
	} else if (fs.existsSync(extSrc)) {
		results.push(["extensions/", "skipped — re-run with --with-extensions to include (the risky part)"]);
	}

	// packages/ — pinned third-party pi packages, staged from npm on THIS host so the job container never
	// needs the network (issue #58). All-or-nothing: a failure leaves no half-staged set to load.
	if (withPackages) {
		const staged = await stagePackages({ fs, exec, out, packagesFile, to, platform });
		if (staged.error) {
			out(`error: ${staged.error}\n`);
			return 1;
		}
		const n = staged.packages.length;
		results.push(["packages/", `${n} package${n === 1 ? "" : "s"} -- third-party code, VET THESE`]);
		for (const warn of staged.warnings) results.push([`packages/${warn.dir}`, `WARN: ${warn.reason}`]);
	} else if (fs.existsSync(join(to, PACKAGES_SUBDIR))) {
		results.push(["packages/", "kept -- re-run with --with-packages to refresh"]);
	}

	out(`Imported the credential-free subset of ${from} → ${to}\n\n`);
	for (const [name, note] of results) out(`  ${name.padEnd(18)} ${note}\n`);
	out(`\n  (auth.json, settings.json, sessions/ are never copied — your credential stays in env/auth.json.)\n`);
	out(nextSteps(to, withExtensions, withPackages));
	return 0;
}

/** Copy `<src>/<name>/**` for each valid, non-symlink child dir. Returns the count copied. */
function copyNamedDirs(fs, src, dst, out) {
	if (!fs.existsSync(src)) return 0;
	let n = 0;
	for (const name of fs.readdirSync(src)) {
		if (!ENTRY_NAME_RE.test(name)) {
			out(`  skipped "${name}" — unexpected name\n`);
			continue;
		}
		const childSrc = join(src, name);
		if (fs.statSync(childSrc).isSymbolicLink?.() || !fs.statSync(childSrc).isDirectory()) continue;
		copyTree(fs, childSrc, join(dst, name));
		n++;
	}
	return n;
}

/** Like copyNamedDirs but reports the admin extension it refuses to copy. */
function copyExtensions(fs, src, dst, out) {
	let copied = 0;
	const blocked = [];
	for (const name of fs.readdirSync(src)) {
		if (ADMIN_RE.test(name)) {
			blocked.push(name);
			continue;
		}
		if (!ENTRY_NAME_RE.test(name)) {
			out(`  skipped "${name}" — unexpected name\n`);
			continue;
		}
		const childSrc = join(src, name);
		const st = fs.statSync(childSrc);
		if (st.isSymbolicLink?.()) continue;
		if (st.isDirectory()) copyTree(fs, childSrc, join(dst, name));
		else fs.copyFileSync(childSrc, join(dst, name));
		copied++;
	}
	return { copied, blocked };
}

/** Recursively copy a directory tree, skipping symlinks (a symlink could point outside the source). */
function copyTree(fs, src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src)) {
		const s = join(src, entry);
		const st = fs.statSync(s);
		if (st.isSymbolicLink?.()) continue;
		if (st.isDirectory()) copyTree(fs, s, join(dst, entry));
		else fs.copyFileSync(s, join(dst, entry));
	}
}

/**
 * Stage every package pinned in `packagesFile` into `<to>/packages/<dir>` and write the stage manifest.
 * Returns `{ packages, warnings }`, or `{ error }` -- ALL-OR-NOTHING, because a half-staged set is worse
 * than none: pi would load the packages that made it and silently skip the rest (issue #58).
 *
 * Each package is installed into a private `.staging-<i>` dir, asserted there, and only renamed into place
 * once EVERY package has passed. A staged dir must be SELF-CONTAINED (`package.json` + its own
 * `node_modules/`) because at job time it is resolved from a read-only mount with no network and no
 * install step -- so every assertion below is about that property.
 */
async function stagePackages({ fs, exec, out, packagesFile, to, platform = process.platform }) {
	if (!fs.existsSync(packagesFile)) {
		return { error: `--with-packages needs a packages file, none at ${packagesFile}\n  Run \`pi-dispatch init\` to scaffold one, or pass --packages-file <path>.` };
	}

	let entries;
	try {
		entries = parsePackagesFile(fs.readFileSync(packagesFile, "utf8"), packagesFile);
	} catch (error) {
		// Refused before a single directory is created, so a bad file stages nothing at all.
		return { error: error.message };
	}

	const packagesRoot = join(to, PACKAGES_SUBDIR);
	const rootExisted = fs.existsSync(packagesRoot);
	fs.mkdirSync(packagesRoot, { recursive: true });

	const npmBin = platform === "win32" ? "npm.cmd" : "npm";
	const stagingDirs = [];
	const prepared = [];
	const renamed = [];
	const warnings = [];

	try {
		for (const [index, entry] of entries.entries()) {
			const staging = join(packagesRoot, `.staging-${index}`);
			fs.rmSync(staging, { recursive: true, force: true }); // a crashed earlier run may have left one
			stagingDirs.push(staging);
			fs.mkdirSync(staging, { recursive: true });
			// A private root package.json pins npm's idea of "the project" to the staging dir, so it cannot
			// walk up and install into (or read config from) the operator's own checkout.
			fs.writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: "pi-dispatch-staging", private: true }, null, 2)}\n`);

			// ARRAY argv, never a shell string: the name and version come from a config file and must never be
			// able to become shell syntax on the operator's host. The install target is the exec's `cwd`, NOT a
			// `--prefix <staging>` pair -- npm installs into the cwd's node_modules by default, and dropping the
			// flag removes the only filesystem PATH from argv. What is left is nothing but literal flags and one
			// `name@version` token already validated against NPM_NAME_RE + EXACT_VERSION_RE; that is the property
			// npmExecOptions relies on below.
			//
			// --ignore-scripts is load-bearing: without it the lifecycle scripts of this package AND of every
			// transitive dependency would run as the operator, on the operator's host, at stage time.
			// --omit=peer because pi aliases its own packages for extensions at load time, so a staged peer
			// copy is ignored dead weight -- and a floating pi version at that (CONST-PI-VERSION-PINNED).
			// --install-strategy=nested asks npm to keep every dependency inside the package dir; step 4 below
			// ASSERTS the result rather than trusting the flag, whose name and default have moved across npm
			// versions.
			const args = [
				"install",
				`${entry.name}@${entry.version}`,
				"--omit=dev",
				"--omit=peer",
				"--omit=optional",
				"--ignore-scripts",
				"--install-strategy=nested",
				"--no-audit",
				"--no-fund",
				"--loglevel=error",
			];
			out(`  staging ${entry.name}@${entry.version} -> packages/${entry.dir}\n`);
			try {
				await exec(npmBin, args, npmExecOptions(platform, staging));
			} catch (error) {
				const detail = String(error?.stderr ?? error?.message ?? "").trim();
				throw new Error(`npm install failed for ${entry.name}@${entry.version}: ${detail}`);
			}

			const source = join(staging, "node_modules", entry.name);
			let pkg;
			try {
				pkg = JSON.parse(fs.readFileSync(join(source, "package.json"), "utf8"));
			} catch {
				throw new Error(`${entry.name}@${entry.version}: npm reported success but there is no readable package.json at ${join(source, "package.json")}`);
			}
			if (pkg.version !== entry.version) {
				throw new Error(`${entry.name}: npm staged version ${JSON.stringify(pkg.version)}, not the pinned ${JSON.stringify(entry.version)} (CONST-PI-VERSION-PINNED)`);
			}

			// Dependency completeness -- catches hoisting whatever npm's flag defaults do this month. A
			// hoisted dependency would only surface as an import failure inside a job, hours later.
			for (const dep of Object.keys(pkg.dependencies ?? {})) {
				if (!fs.existsSync(join(source, "node_modules", dep))) {
					throw new Error(`${entry.name}: dependency "${dep}" is not inside the package dir -- npm hoisted it out, so the staged copy could not import it at run time (no network, no install)`);
				}
			}

			// A package that contributes no pi resources loads as a silent no-op; staging exists to turn that
			// run-time nothing into a stage-time error the operator can act on.
			const manifest = pkg.pi !== null && typeof pkg.pi === "object" ? pkg.pi : null;
			const hasResourceDir = RESOURCE_DIRS.some((name) => fs.existsSync(join(source, name)));
			if (!manifest && !hasResourceDir) {
				throw new Error(`${entry.name} is not a pi package -- no "pi" manifest in package.json and none of ${RESOURCE_DIRS.join("/")}; it would load as a silent no-op`);
			}

			// Containment: manifest entries are resolved relative to the package dir at job time, so one that
			// climbs out of it would reach the rest of the read-only overlay.
			const escaping = manifest && findEscapingEntry(manifest);
			if (escaping) {
				throw new Error(`${entry.name}: pi manifest entry ${JSON.stringify(escaping)} leaves the package dir (no ".." segment, no leading "/")`);
			}

			// Warn, do not refuse: --ignore-scripts means a build/postinstall step did NOT run and an optional
			// dependency was NOT fetched, so such a package is staged INCOMPLETE and may fail at run time.
			const scriptKeys = ["install", "preinstall", "postinstall"].filter((key) => typeof pkg.scripts?.[key] === "string");
			const hasOptional = Object.keys(pkg.optionalDependencies ?? {}).length > 0;
			if (scriptKeys.length > 0 || hasOptional) {
				const declares = [...scriptKeys.map((key) => `scripts.${key}`), ...(hasOptional ? ["optionalDependencies"] : [])].join(", ");
				warnings.push({ dir: entry.dir, reason: `${entry.name} declares ${declares} -- staged with --ignore-scripts, so it is INCOMPLETE and may fail at run time` });
			}

			prepared.push({ entry, source });
		}

		// Renames happen only after EVERY package has passed, so a failure on the last one cannot leave the
		// earlier ones swapped in beside a stale manifest.
		for (const { entry, source } of prepared) {
			const dest = join(packagesRoot, entry.dir);
			fs.rmSync(dest, { recursive: true, force: true }); // replace a previous stage of the same package
			// renameSync, never copyTree: copyTree's symlink guard uses statSync, which FOLLOWS links, so it
			// would copy the target of every node_modules/.bin symlink instead of skipping it.
			fs.renameSync(source, dest);
			renamed.push(dest);
		}
	} catch (error) {
		for (const dest of renamed) fs.rmSync(dest, { recursive: true, force: true });
		for (const staging of stagingDirs) fs.rmSync(staging, { recursive: true, force: true });
		if (!rootExisted) fs.rmSync(packagesRoot, { recursive: true, force: true });
		return { error: `${error.message}\n  Nothing was staged -- fix ${packagesFile} (or the package) and re-run with --with-packages.` };
	}

	for (const staging of stagingDirs) fs.rmSync(staging, { recursive: true, force: true });

	const stageManifest = { stagedAt: new Date().toISOString(), packages: entries.map(({ name, version, dir }) => ({ name, version, dir })) };
	fs.writeFileSync(join(packagesRoot, STAGE_MANIFEST), `${JSON.stringify(stageManifest, null, 2)}\n`);
	return { packages: entries, warnings };
}

/**
 * The exec options for one `npm install`: always `cwd: <staging>` (that IS the install target now that
 * `--prefix` is gone), plus `shell: true` on win32 and nowhere else.
 *
 * WHY shell:true is REQUIRED on win32: npm ships there as `npm.cmd`, and since Node 18.20.2 / 20.12.2
 * (CVE-2024-27980) spawning a `.cmd`/`.bat` WITHOUT a shell throws EINVAL outright. This package floors at
 * Node >=22.19, so every Node it can run on has that behaviour -- without this, `--with-packages` fails on
 * every Windows host with a misleading "spawn npm.cmd EINVAL" and the branch above is dead on arrival.
 *
 * WHY shell:true is SAFE HERE SPECIFICALLY, which it would NOT be in general: with `--prefix` replaced by
 * `cwd`, argv holds no filesystem path at all -- only literal flags this file spells out, plus the single
 * `name@version` token, and BOTH halves of that token were validated before anything was created (packages.mjs
 * rejects any name failing NPM_NAME_RE and any version failing EXACT_VERSION_RE, neither of which admits a
 * space, quote, or cmd metacharacter). So no operator-supplied string that could survive as shell syntax ever
 * reaches the command line. Re-introducing a path -- or loosening either regex -- breaks that argument, so
 * this option must be revisited together with them.
 */
function npmExecOptions(platform, staging) {
	return platform === "win32" ? { cwd: staging, shell: true } : { cwd: staging };
}

/** The first string anywhere in a `pi` manifest that leaves the package dir, or null when all are contained. */
function findEscapingEntry(value) {
	if (typeof value === "string") {
		return /^[\\/]/.test(value) || value.split(/[\\/]/).includes("..") ? value : null;
	}
	if (Array.isArray(value) || (value !== null && typeof value === "object")) {
		for (const child of Object.values(value)) {
			const hit = findEscapingEntry(child);
			if (hit) return hit;
		}
	}
	return null;
}

function flagValue(argv, flag) {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function nextSteps(to, withExtensions, withPackages) {
	const steps = [`Set PI_GLOBAL_PI_DIR=${to} in .env`, "pi-dispatch doctor        # verifies the overlay is credential-free"];
	if (withExtensions) steps.push("After vetting, set PI_GLOBAL_ALLOW_EXTENSIONS=1 in .env to load the overlay's extensions");
	// Staged packages are inert until a trigger asks for them -- nothing loads them otherwise, which would
	// otherwise read as "staging silently did nothing".
	if (withPackages) steps.push('Set `run.packages: true` on each trigger in triggers.json that needs the staged packages -- nothing loads them otherwise');
	return `
Next:
${steps.map((step, i) => `  ${i + 1}. ${step}\n`).join("")}`;
}
