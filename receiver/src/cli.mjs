#!/usr/bin/env node
/**
 * The receiver's own bin (issue #80). Before it, the only start command in the repo lived inside
 * deploy/receiver.service -- an operator without systemd had nothing documented to type.
 *
 * It is a separate bin rather than a `receiver` case in the worker CLI because the dependency points
 * the other way: the receiver depends on `@pi-dispatch/worker` (queue, config, the shared triggers
 * schema), so teaching the worker CLI to start the receiver would invert that into a circular
 * workspace dependency. And the receiver is the always-on public trigger surface that lives OUTSIDE
 * pi (DES-TRIGGER-OUTSIDE-PI) -- the edge deserves its own entry point, not a mode of the thing it
 * feeds.
 *
 * Thin by design, mirroring worker/src/cli.mjs: recognise the command, lazy-import the real work.
 */

import { EXIT_POLICY } from "@pi-dispatch/worker/exit-code";

const USAGE = `pi-dispatch-receiver — the always-on webhook edge: verifies deliveries, enqueues jobs

  pi-dispatch-receiver serve   start the receiver (the default when no command is given)

Config comes from the environment (see .env.example): WEBHOOK_SECRET is required,
PI_TRIGGERS_FILE overrides the ./triggers.json default, VALKEY_URL names the queue,
RECEIVER_PORT/RECEIVER_BIND choose where to listen. Serve is the only command today;
the command form exists so future modes have somewhere to land.`;

/**
 * `start` is an injection seam defaulting to the lazy import of ./start.mjs, so tests can run the
 * command dispatch without resolving identity, opening a socket, or touching Valkey -- and the
 * help/unknown paths stay runnable even where the queue deps are not installed.
 */
export async function main(argv = process.argv.slice(2), env = process.env, { start } = {}) {
	const cmd = argv[0];

	if (cmd === undefined || cmd === "serve") {
		const startReceiver = start ?? (await import("./start.mjs")).startReceiver;
		await startReceiver(env);
		return 0; // the server keeps the process alive until SIGTERM
	}

	process.stdout.write(`${USAGE}\n`);
	return cmd === "--help" || cmd === "-h" ? 0 : 1; // asked-for help is success; a typo is not
}

/**
 * Exit code for an error that escaped main() as a rejection. A tagged config error
 * (`piDispatchConfig`, from loadReceiverConfig or the HARD-FAIL identity boot gate) is a determinate
 * refusal -> EXIT_POLICY (2, never retried); anything else is infra -> 1 (retryable). The same
 * mapping as the worker CLI's entryExitCode, for the same reason: a supervisor restarting on exit 2
 * would loop on a config that can never parse.
 */
export function entryExitCode(err) {
	return err?.piDispatchConfig ? EXIT_POLICY : 1;
}

// Entry point when run as a bin. Kept out of the exported main so tests can call main() directly.
// The error line mirrors start.mjs's own entry guard: `err.message` only -- never a secret or PII.
// (start.mjs's guard keys on argv[1] ending in start.mjs, so importing it from here never double-boots.)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.mjs")) {
	main()
		.then((code) => {
			if (code) process.exitCode = code;
		})
		.catch((err) => {
			process.stderr.write(`${JSON.stringify({ event: "receiver_start_failed", reason: err?.message })}\n`);
			process.exitCode = entryExitCode(err);
		});
}
