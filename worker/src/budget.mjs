/**
 * CONST-BUDGET-BEFORE-TOKENS. The ordering IS the mechanism.
 *
 * Reserve a slot against the daily cap BEFORE a container starts. Check-after-spend means fifty
 * junk triggers cost fifty jobs of real money before the cap engages -- the exact scenario the cap
 * exists for. So: atomically INCR the day's counter, and only start the container if the reserved
 * number is within the cap.
 *
 * INCR is atomic -- verified against a real Valkey under 20 parallel increments yielding exactly
 * 20, no lost updates -- so this needs no lock even at concurrency 3. Three jobs racing at count 9
 * with cap 10 reserve 10, 11, 12; exactly one proceeds, the others are refused, and no container
 * starts over budget.
 *
 * `redis` is any ioredis-compatible client (BullMQ bundles ioredis). Injected so the logic is
 * testable without a running server.
 */

/** UTC date key. The worker is ordinary node, so Date is available (unlike the workflow sandbox). */
export function dayKey(now = new Date(), prefix = "budget") {
	const d = now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
	return `${prefix}:${d}`;
}

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

/**
 * Atomically reserve one slot against today's cap. Returns { allowed, reserved, cap }.
 *
 * A refused reservation still counts -- the counter bounds container STARTS per day, and a refused
 * job spends nothing (no container) and reports on its issue. We deliberately do NOT decrement on
 * refusal: the cap is a hard daily ceiling on attempts, and letting refused attempts "give back"
 * their slot would let a burst probe the cap for free.
 *
 * A cap of 0 or negative disables running entirely (every job refused) rather than meaning
 * "unlimited" -- fail closed, since this guards money.
 */
export async function reserveBudget(redis, { cap, now = new Date(), keyPrefix = "budget" } = {}) {
	const key = dayKey(now, keyPrefix);
	const reserved = Number(await redis.incr(key));
	// Set the TTL only once, when the key is first created (reserved === 1), so a long-running
	// day cannot have its expiry pushed forward indefinitely.
	if (reserved === 1) await redis.expire(key, TWO_DAYS_SECONDS);
	return { allowed: reserved <= cap, reserved, cap };
}

/**
 * Give a reservation back. Used ONLY when the container never started because of an INFRA fault
 * AFTER reserving (e.g. the docker daemon was unreachable) -- an infra failure that spent nothing
 * should not permanently consume a cap slot. NOT used for a completed run (0/2), which really did
 * consume its slot, nor for an exit-1 infra retry (the container ran and spent), nor for a refusal
 * (which never incremented past the cap deliberately).
 */
export async function releaseBudget(redis, { now = new Date(), keyPrefix = "budget" } = {}) {
	await redis.decr(dayKey(now, keyPrefix));
}
