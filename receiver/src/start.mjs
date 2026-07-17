/**
 * The receiver entry point: an always-on, public webhook producer that resolves the harness's own
 * identity, then serves `makeReceiver` over `node:http` and enqueues onto the shared queue.
 *
 * DES-TRIGGER-OUTSIDE-PI: the trigger is a separate always-on process, outside the container and the
 * agent. It only produces jobs; it never runs pi.
 *
 * CONST-TRIGGER-AUTHOR-GATE: `selfId` is the bot-loop guard's sole input -- the filter drops any event
 * whose `sender.id` is our own. Resolving it is therefore a HARD-FAIL boot invariant: if identity does
 * not resolve, the rejection propagates and the server is NEVER created. A receiver that listened
 * without `selfId` would run the guard disarmed, and its own completion comments would re-trigger jobs
 * -- an unbounded paid recursion. The worker's auth is best-effort because it can fail a github job
 * per-job; the receiver has no such per-job fallback, so identity resolution is a boot gate.
 *
 * The receiver resolves identity ONLY. It holds no per-repo tokens: minting a scoped token is the
 * worker's job, per container, per job (CONST-TOKEN-SCOPED-PER-JOB).
 *
 * DES-PANEL-SEPARATE-FROM-RECEIVER: this process exposes exactly one surface, the webhook handler.
 * There is no admin, dashboard, or panel route here -- the panel is a separate service on a separate
 * bind.
 */

import http from "node:http";
import { loadReceiverConfig } from "./config.mjs";
import { makeReceiver } from "./receiver.mjs";
import { makeGitHubAuth } from "@pi-dispatch/worker/get-token";
import { makeQueue } from "@pi-dispatch/worker/queue";
import { parseConnection } from "@pi-dispatch/worker/connection";

/**
 * Boot the receiver. Collaborators are injected (defaulting to the real ones) so the whole wiring is
 * testable offline with no GitHub, no Valkey, and no socket. Returns the listening server.
 */
export async function startReceiver(
	env = process.env,
	{ makeAuth = makeGitHubAuth, makeQueueFn = makeQueue, createServer = http.createServer } = {},
) {
	// Single-object log line: `makeReceiver` calls `log?.({ event, ... })`, so the sink takes ONE object.
	const log = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

	const cfg = loadReceiverConfig(env);

	// HARD-FAIL identity resolution -- NO try/catch. A throw here (absent/bad github auth, unresolvable
	// id) propagates and the server below is never created: without selfId the bot-loop guard cannot
	// run, so refusing to boot is the only safe outcome.
	const { selfId } = await makeAuth(cfg.github);
	log({ event: "self_identity", id: selfId, source: cfg.github.source });

	// Ride-out connection (no failFast): the receiver is long-running and should survive a Valkey
	// restart, not give up on a transient disconnect.
	const queue = makeQueueFn(parseConnection(cfg.valkeyUrl));

	const handler = makeReceiver({ queue, selfId, cfg, log });
	const server = createServer(handler);
	server.listen(cfg.port, cfg.bind, () =>
		log({ event: "receiver_started", port: cfg.port, bind: cfg.bind, valkey: cfg.valkeyUrl }),
	);

	// Graceful shutdown only on the real entry (default createServer). Under test injection the fakes
	// are per-test, so registering process-wide signal handlers would leak listeners across tests.
	if (createServer === http.createServer) {
		const shutdown = async (signal) => {
			log({ event: "receiver_stopping", signal });
			await new Promise((resolve) => server.close(resolve));
			await queue.close();
			process.exit(0);
		};
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
		process.once("SIGINT", () => void shutdown("SIGINT"));
	}

	return server;
}

// Entry point when run directly (main: src/start.mjs, no bin). Kept out of startReceiver so tests call
// it directly. The error line carries only `err.message` -- never a secret or PII.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("start.mjs")) {
	startReceiver(process.env).catch((err) => {
		process.stderr.write(`${JSON.stringify({ event: "receiver_start_failed", reason: err?.message })}\n`);
		process.exitCode = 1;
	});
}
