#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";

const USAGE = `pi-dispatch — run pi coding-agent flows on your own folders

  pi-dispatch run <folder> --task "<what to do>" [--flow <name>]
                           [--provider <p>] [--model <m>] [--max-turns <n>] [--force]
  pi-dispatch worker       drain the queue (run this in another terminal, or as a service)

Config comes from the environment (see .env.example); flags override it per run.`;

export async function main(argv = process.argv.slice(2), env = process.env) {
	const cmd = argv[0];

	if (cmd === "worker") {
		const { startWorker } = await import("./start.mjs");
		startWorker(env);
		return 0; // the worker keeps the process alive until SIGTERM
	}

	if (cmd === "run") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: {
				task: { type: "string" },
				flow: { type: "string" },
				provider: { type: "string" },
				model: { type: "string" },
				"max-turns": { type: "string" },
				force: { type: "boolean", default: false },
			},
		});
		const folder = positionals[0] && resolve(positionals[0]);
		if (!folder || !existsSync(folder)) return fail(`folder not found: ${positionals[0] ?? "(none given)"}`);
		if (!values.task) return fail("a --task is required");

		// A local job edits the folder IN PLACE with no undo (SECURITY.md). Refuse a dirty working
		// tree unless --force, so a bad run cannot mix with uncommitted work the operator can't
		// cleanly separate. A non-git folder is caught later by prepare (v1 requires a git repo).
		if (existsSync(`${folder}/.git`) && !values.force) {
			const dirty = gitDirty(folder);
			if (dirty === null) return fail(`${folder} is not a usable git repository`);
			if (dirty) return fail(`${folder} has uncommitted changes. Commit or stash them, or pass --force.`);
		}

		const config = loadConfig(env);
		const { parseConnection } = await import("./connection.mjs");
		const { makeQueue, enqueueLocalJob } = await import("./queue.mjs");
		const queue = makeQueue(parseConnection(config.valkeyUrl));
		try {
			const jobId = await enqueueLocalJob(queue, {
				folder,
				task: values.task,
				flow: values.flow,
				provider: values.provider ?? config.provider,
				model: values.model ?? config.model,
				maxTurns: values["max-turns"] ? Number(values["max-turns"]) : config.maxTurns,
			});
			process.stdout.write(`queued ${jobId} — folder ${folder}\nrun \`pi-dispatch worker\` to process it.\n`);
		} finally {
			await queue.close();
		}
		return 0;
	}

	process.stdout.write(`${USAGE}\n`);
	return cmd ? 1 : 0;
}

function fail(message) {
	process.stderr.write(`error: ${message}\n`);
	return 1;
}

/** true = dirty, false = clean, null = not a working git repo. */
function gitDirty(folder) {
	try {
		const out = execFileSync("git", ["-C", folder, "status", "--porcelain"], { encoding: "utf8" });
		return out.trim().length > 0;
	} catch {
		return null;
	}
}

// Entry point when run as a bin. Kept out of the exported main so tests can call main() directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.mjs")) {
	main().then((code) => {
		if (code) process.exitCode = code;
	});
}
