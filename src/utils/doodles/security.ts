/*
 * Auth and abuse helpers for the doodle Function.
 *
 * Rate limiting here is best effort: counters live in the memory of one
 * Function instance, so they reset on cold starts and are not shared between
 * concurrent instances or regions. IPs are never stored; each is hashed with
 * a random per-instance salt before it is used as a key.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Shortest DOODLE_ADMIN_TOKEN the Function will accept. */
export const MIN_ADMIN_TOKEN_LENGTH = 24;

/** Constant-time comparison (hashing first makes both sides the same length). */
export function tokensMatch(provided: string, expected: string): boolean {
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string | null {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

/** The client IP as Vercel reports it, or "unknown". */
export function clientIp(request: Request): string {
	const real = request.headers.get("x-real-ip")?.trim();
	if (real) return real;
	const forwarded = request.headers
		.get("x-forwarded-for")
		?.split(",")[0]
		?.trim();
	return forwarded || "unknown";
}

const SALT = randomBytes(16);

/** Opaque, per-instance key for an IP; the IP itself is not kept. */
export function clientKey(request: Request): string {
	return createHash("sha256")
		.update(SALT)
		.update(clientIp(request))
		.digest("hex")
		.slice(0, 32);
}

export interface RateLimitRule {
	limit: number;
	windowMs: number;
}

/** Sliding-window counter per key, bounded in memory. */
export class RateLimiter {
	private readonly rules: RateLimitRule[];
	private readonly maxKeys: number;
	private readonly hits = new Map<string, number[]>();
	private readonly longestWindow: number;

	constructor(rules: RateLimitRule[], maxKeys = 10_000) {
		this.rules = rules;
		this.maxKeys = maxKeys;
		this.longestWindow = Math.max(...rules.map((rule) => rule.windowMs));
	}

	/** Seconds until `key` may act again, or 0 if it may act now. Does not count. */
	retryAfter(key: string, now: number = Date.now()): number {
		const times = this.recent(key, now);
		let wait = 0;
		for (const rule of this.rules) {
			const inWindow = times.filter((t) => t > now - rule.windowMs);
			if (inWindow.length >= rule.limit) {
				const oldest = inWindow[inWindow.length - rule.limit];
				wait = Math.max(wait, oldest + rule.windowMs - now);
			}
		}
		return Math.ceil(wait / 1000);
	}

	/** Records one action for `key`. */
	hit(key: string, now: number = Date.now()): void {
		const times = this.recent(key, now);
		times.push(now);
		this.hits.delete(key);
		this.hits.set(key, times);
		while (this.hits.size > this.maxKeys) {
			const oldestKey = this.hits.keys().next().value;
			if (oldestKey === undefined) break;
			this.hits.delete(oldestKey);
		}
	}

	private recent(key: string, now: number): number[] {
		return (this.hits.get(key) ?? []).filter(
			(t) => t > now - this.longestWindow,
		);
	}
}
