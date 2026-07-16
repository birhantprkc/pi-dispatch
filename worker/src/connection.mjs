import { Redis } from "ioredis";

/**
 * Connection helpers for BullMQ and the budget's raw Redis client, both from one VALKEY_URL.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ for its blocking connections (the Worker
 * uses BRPOPLPUSH); without it BullMQ throws at construction. It is harmless on the Queue and the
 * budget client, so it is set consistently.
 */

/** BullMQ connection options parsed from a redis:// URL. */
export function parseConnection(url) {
	const u = new URL(url);
	return {
		host: u.hostname || "127.0.0.1",
		port: Number(u.port || 6379),
		...(u.password ? { password: u.password } : {}),
		...(u.username ? { username: u.username } : {}),
		...(u.pathname && u.pathname !== "/" ? { db: Number(u.pathname.slice(1)) } : {}),
		maxRetriesPerRequest: null,
	};
}

/** A raw ioredis client for the budget's INCR/EXPIRE. */
export function makeRedisClient(url) {
	return new Redis(url, { maxRetriesPerRequest: null });
}
