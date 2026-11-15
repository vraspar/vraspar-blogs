/*
 * Wires the doodle handler to its environment. Used by the Vercel Function
 * (`api/doodles.ts`) and by the `astro dev` middleware.
 *
 * Storage selection:
 *   - Vercel Blob when BLOB_STORE_ID (OIDC, set when a store is connected to
 *     the project) or BLOB_READ_WRITE_TOKEN is present.
 *   - Otherwise, on Vercel: none. Routes answer 503 instead of pretending to
 *     save into memory that disappears with the instance.
 *   - Otherwise, locally: files under `.doodles-dev/` (gitignored).
 */
import { VercelBlobStore } from "./blob-store.js";
import { createDoodleHandler, PendingCounter } from "./handler.js";
import { DoodleRepo } from "./repo.js";
import { MIN_ADMIN_TOKEN_LENGTH, RateLimiter } from "./security.js";
import { FsObjectStore, type ObjectStore } from "./store.js";

export type DoodleEnv = Record<string, string | undefined>;

export const LOCAL_STORE_DIR = ".doodles-dev";

const MINUTE = 60 * 1000;

function pickStore(env: DoodleEnv, localRoot: string): ObjectStore | null {
	if (env.BLOB_STORE_ID || env.BLOB_READ_WRITE_TOKEN)
		return new VercelBlobStore();
	if (env.VERCEL) return null;
	return new FsObjectStore(localRoot);
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createDoodleRuntime(
	env: DoodleEnv,
	localRoot: string = LOCAL_STORE_DIR,
): (request: Request) => Promise<Response> {
	const token = env.DOODLE_ADMIN_TOKEN?.trim() ?? "";
	if (token && token.length < MIN_ADMIN_TOKEN_LENGTH) {
		console.warn(
			`[doodles] DOODLE_ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters; moderation stays off.`,
		);
	}
	const store = pickStore(env, localRoot);
	return createDoodleHandler({
		repo: store ? new DoodleRepo(store) : null,
		adminToken: token.length >= MIN_ADMIN_TOKEN_LENGTH ? token : null,
		submissionsOpen:
			(env.DOODLE_SUBMISSIONS ?? "open").trim().toLowerCase() !== "closed",
		maxPending: positiveInt(env.DOODLE_MAX_PENDING, 100),
		submitLimiter: new RateLimiter([
			{ limit: 3, windowMs: 10 * MINUTE },
			{ limit: 12, windowMs: 24 * 60 * MINUTE },
		]),
		adminFailureLimiter: new RateLimiter([
			{ limit: 10, windowMs: 15 * MINUTE },
		]),
		pendingCounter: new PendingCounter(),
	});
}
