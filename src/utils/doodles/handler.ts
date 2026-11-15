/*
 * Request router for every doodle route. Framework-free (Request in,
 * Response out) so the Vercel Function, the `astro dev` middleware and the
 * unit tests all run exactly this code.
 *
 *   GET  /api/doodles                       public wall (CDN-cached briefly)
 *   GET  /api/doodles?image=<id>            approved PNG (CDN-cached)
 *   POST /api/doodles                       submit a doodle (JSON body)
 *   GET  /api/doodles?admin=list            pending + approved      [Bearer]
 *   GET  /api/doodles?admin=image&id&status any PNG                 [Bearer]
 *   POST /api/doodles?admin=approve&id=     approve a pending doodle [Bearer]
 *   POST /api/doodles?admin=reject&id=      delete a pending doodle  [Bearer]
 *   POST /api/doodles?admin=remove&id=      take one off the wall    [Bearer]
 */
import type { ApprovedDoodle, DoodleMeta, DoodleRepo } from "./repo.js";
import { isDoodleId } from "./repo.js";
import {
	bearerToken,
	clientKey,
	type RateLimiter,
	tokensMatch,
} from "./security.js";
import {
	type AdminDoodle,
	type AdminDoodleList,
	type DoodleStatus,
	type PublicDoodleList,
	publicImageUrl,
} from "./shared.js";
import { MAX_BASE64_LENGTH, parseSubmission } from "./validate.js";

export interface DoodleHandlerOptions {
	/** null when no storage is configured (e.g. on Vercel without a Blob store). */
	repo: DoodleRepo | null;
	/** null when DOODLE_ADMIN_TOKEN is unset or too short: moderation is off. */
	adminToken: string | null;
	submissionsOpen: boolean;
	maxPending: number;
	submitLimiter: RateLimiter;
	adminFailureLimiter: RateLimiter;
	pendingCounter: PendingCounter;
	log?: (message: string, error?: unknown) => void;
}

/** Newest approved doodles returned to the public wall. */
export const PUBLIC_LIST_LIMIT = 120;

/** Request body cap: the largest allowed image plus room for the text fields. */
const MAX_BODY_BYTES: number = MAX_BASE64_LENGTH + 8 * 1024;

const PUBLIC_LIST_CACHE =
	"public, max-age=30, s-maxage=60, stale-while-revalidate=600";
const PUBLIC_IMAGE_CACHE = "public, max-age=86400, s-maxage=86400";
const NO_STORE = "private, no-store";

const BASE_HEADERS: Record<string, string> = {
	"X-Robots-Tag": "noindex",
	"X-Content-Type-Options": "nosniff",
};

class HttpError extends Error {
	readonly status: number;
	readonly headers: Record<string, string>;
	constructor(
		status: number,
		message: string,
		headers: Record<string, string> = {},
	) {
		super(message);
		this.status = status;
		this.headers = headers;
	}
}

function json(
	body: unknown,
	status = 200,
	cache = NO_STORE,
	extra: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...BASE_HEADERS,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": cache,
			...extra,
		},
	});
}

function png(body: Uint8Array, cache: string): Response {
	return new Response(body as BodyInit, {
		status: 200,
		headers: {
			...BASE_HEADERS,
			"Content-Type": "image/png",
			"Content-Length": String(body.byteLength),
			"Cache-Control": cache,
			"Content-Security-Policy": "default-src 'none'",
		},
	});
}

/**
 * Pending count with a short per-instance cache, so enforcing the pending cap
 * costs at most one store listing per instance every few minutes.
 */
export class PendingCounter {
	private readonly ttlMs: number;
	private value: number | null = null;
	private fetchedAt = 0;

	constructor(ttlMs: number = 10 * 60 * 1000) {
		this.ttlMs = ttlMs;
	}

	async get(repo: DoodleRepo, now: number = Date.now()): Promise<number> {
		if (this.value === null || now - this.fetchedAt > this.ttlMs) {
			this.value = await repo.countPending();
			this.fetchedAt = now;
		}
		return this.value;
	}

	increment(): void {
		if (this.value !== null) this.value += 1;
	}

	invalidate(): void {
		this.value = null;
	}
}

async function readBodyCapped(
	request: Request,
	maxBytes: number,
): Promise<string> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > maxBytes)
		throw new HttpError(413, "That doodle is too big to send.");
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new HttpError(413, "That doodle is too big to send.");
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function isSameOrigin(request: Request, url: URL): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === url.host;
	} catch {
		return false;
	}
}

function toAdmin(
	item: DoodleMeta | ApprovedDoodle,
	status: DoodleStatus,
): AdminDoodle {
	return {
		id: item.id,
		status,
		name: item.name,
		note: item.note,
		createdAt: item.createdAt,
		...("approvedAt" in item ? { approvedAt: item.approvedAt } : {}),
	};
}

export function createDoodleHandler(
	options: DoodleHandlerOptions,
): (request: Request) => Promise<Response> {
	const log =
		options.log ??
		((message, error) => console.error(`[doodles] ${message}`, error ?? ""));

	function requireRepo(): DoodleRepo {
		if (!options.repo) {
			throw new HttpError(503, "The doodle wall isn't set up yet.");
		}
		return options.repo;
	}

	function requireAdmin(request: Request): DoodleRepo {
		if (!options.adminToken) {
			throw new HttpError(
				503,
				"Moderation is off: DOODLE_ADMIN_TOKEN is not set (or shorter than 24 characters).",
			);
		}
		const key = clientKey(request);
		const wait = options.adminFailureLimiter.retryAfter(key);
		if (wait > 0) {
			throw new HttpError(
				429,
				"Too many wrong tokens. Wait a bit and try again.",
				{
					"Retry-After": String(wait),
				},
			);
		}
		const token = bearerToken(request);
		if (!token || !tokensMatch(token, options.adminToken)) {
			options.adminFailureLimiter.hit(key);
			throw new HttpError(401, "Wrong or missing admin token.");
		}
		return requireRepo();
	}

	async function listPublic(): Promise<Response> {
		const repo = requireRepo();
		let items: ApprovedDoodle[];
		try {
			items = await repo.listApproved();
		} catch (error) {
			log("could not read the wall index", error);
			throw new HttpError(500, "Couldn't load the doodle wall.");
		}
		const body: PublicDoodleList = {
			items: items.slice(0, PUBLIC_LIST_LIMIT).map((item) => ({
				id: item.id,
				name: item.name,
				note: item.note,
				createdAt: item.createdAt,
				approvedAt: item.approvedAt,
				image: publicImageUrl(item.id),
			})),
		};
		return json(body, 200, PUBLIC_LIST_CACHE);
	}

	async function servePublicImage(id: string): Promise<Response> {
		if (!isDoodleId(id)) throw new HttpError(400, "Bad doodle id.");
		const image = await requireRepo().getImage(id, "approved");
		if (!image) throw new HttpError(404, "No such doodle.");
		return png(image, PUBLIC_IMAGE_CACHE);
	}

	async function submit(request: Request, url: URL): Promise<Response> {
		if (!options.submissionsOpen) {
			throw new HttpError(
				503,
				"The doodle wall isn't taking new drawings right now.",
			);
		}
		const repo = requireRepo();
		if (!isSameOrigin(request, url))
			throw new HttpError(403, "Cross-site submissions are not allowed.");
		if (
			!(request.headers.get("content-type") ?? "")
				.toLowerCase()
				.includes("application/json")
		) {
			throw new HttpError(415, "Send the doodle as JSON.");
		}

		const key = clientKey(request);
		const wait = options.submitLimiter.retryAfter(key);
		if (wait > 0) {
			throw new HttpError(
				429,
				"You're doodling fast! Please wait a few minutes before sending another.",
				{
					"Retry-After": String(wait),
				},
			);
		}
		options.submitLimiter.hit(key);

		let body: unknown;
		try {
			body = JSON.parse(await readBodyCapped(request, MAX_BODY_BYTES));
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(400, "Malformed request.");
		}

		const parsed = parseSubmission(body);
		// Same answer as a real submission, so a bot can't tell it was caught.
		if (parsed.kind === "bot")
			return json({ ok: true, status: "pending" }, 201);
		if (parsed.kind === "invalid")
			throw new HttpError(parsed.status, parsed.error);

		let pending: number;
		try {
			pending = await options.pendingCounter.get(repo);
		} catch (error) {
			log("could not count pending doodles", error);
			throw new HttpError(
				500,
				"Couldn't save your doodle. Please try again later.",
			);
		}
		if (pending >= options.maxPending) {
			throw new HttpError(
				503,
				"The doodle inbox is full right now. Please try again in a day or two.",
			);
		}

		try {
			await repo.createPending(parsed.value);
		} catch (error) {
			log("could not store a doodle", error);
			throw new HttpError(
				500,
				"Couldn't save your doodle. Please try again later.",
			);
		}
		options.pendingCounter.increment();
		return json({ ok: true, status: "pending" }, 201);
	}

	async function admin(
		request: Request,
		url: URL,
		op: string,
	): Promise<Response> {
		const repo = requireAdmin(request);
		const id = url.searchParams.get("id") ?? "";

		if (request.method === "GET" && op === "list") {
			const [pending, approved] = await Promise.all([
				repo.listPending(),
				repo.listApproved(true),
			]);
			const body: AdminDoodleList = {
				storage: repo.storageKind,
				pending: pending.map((item) => toAdmin(item, "pending")),
				approved: approved.map((item) => toAdmin(item, "approved")),
			};
			return json(body);
		}

		if (request.method === "GET" && op === "image") {
			const status =
				url.searchParams.get("status") === "approved" ? "approved" : "pending";
			if (!isDoodleId(id)) throw new HttpError(400, "Bad doodle id.");
			const image = await repo.getImage(id, status);
			if (!image) throw new HttpError(404, "No such doodle.");
			return png(image, NO_STORE);
		}

		if (
			request.method === "POST" &&
			(op === "approve" || op === "reject" || op === "remove")
		) {
			if (!isDoodleId(id)) throw new HttpError(400, "Bad doodle id.");
			options.pendingCounter.invalidate();
			if (op === "approve") {
				const item = await repo.approve(id);
				if (!item) throw new HttpError(404, "No such pending doodle.");
				return json({ ok: true, item: toAdmin(item, "approved") });
			}
			const done =
				op === "reject" ? await repo.reject(id) : await repo.removeApproved(id);
			if (!done) throw new HttpError(404, "No such doodle.");
			return json({ ok: true });
		}

		throw new HttpError(400, "Unknown admin action.");
	}

	return async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			const op = url.searchParams.get("admin");
			if (op !== null) return await admin(request, url, op);
			if (request.method === "GET" || request.method === "HEAD") {
				const image = url.searchParams.get("image");
				return image !== null
					? await servePublicImage(image)
					: await listPublic();
			}
			if (request.method === "POST") return await submit(request, url);
			throw new HttpError(405, "Method not allowed.", {
				Allow: "GET, HEAD, POST",
			});
		} catch (error) {
			if (error instanceof HttpError) {
				return json(
					{ error: error.message },
					error.status,
					NO_STORE,
					error.headers,
				);
			}
			log(
				`unexpected error on ${request.method} ${url.pathname}${url.search}`,
				error,
			);
			return json(
				{ error: "Something went wrong. Please try again later." },
				500,
			);
		}
	};
}
