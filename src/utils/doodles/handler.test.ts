import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	createDoodleHandler,
	type DoodleHandlerOptions,
	PendingCounter,
} from "./handler.js";
import { DoodleRepo } from "./repo.js";
import { RateLimiter } from "./security.js";
import type { AdminDoodleList, PublicDoodleList } from "./shared.js";
import { DOODLE_PNG_HEIGHT, DOODLE_PNG_WIDTH } from "./shared.js";
import {
	MemoryObjectStore,
	type PutOptions,
	StoreConflictError,
} from "./store.js";
import { makePng, toDataUrl } from "./test-utils.js";

const ORIGIN = "https://vraspar.example";
const TOKEN = "test-admin-token-0123456789abcdef";
const image = toDataUrl(
	makePng({ width: DOODLE_PNG_WIDTH, height: DOODLE_PNG_HEIGHT }),
);

type Handle = (request: Request) => Promise<Response>;

function setup(overrides: Partial<DoodleHandlerOptions> = {}) {
	const store = new MemoryObjectStore();
	const repo = new DoodleRepo(store);
	const handle = createDoodleHandler({
		repo,
		adminToken: TOKEN,
		submissionsOpen: true,
		maxPending: 100,
		submitLimiter: new RateLimiter([{ limit: 3, windowMs: 60_000 }]),
		adminFailureLimiter: new RateLimiter([{ limit: 3, windowMs: 60_000 }]),
		pendingCounter: new PendingCounter(),
		log: () => {},
		...overrides,
	});
	return { store, repo, handle };
}

function submit(
	handle: Handle,
	body: unknown,
	init: { ip?: string; headers?: Record<string, string> } = {},
) {
	return handle(
		new Request(`${ORIGIN}/api/doodles`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				"x-real-ip": init.ip ?? "203.0.113.1",
				...init.headers,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

function admin(
	handle: Handle,
	query: string,
	method = "GET",
	token = TOKEN,
	ip = "198.51.100.7",
) {
	return handle(
		new Request(`${ORIGIN}/api/doodles?${query}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "x-real-ip": ip },
		}),
	);
}

async function wall(handle: Handle): Promise<PublicDoodleList> {
	const response = await handle(new Request(`${ORIGIN}/api/doodles`));
	assert.equal(response.status, 200);
	return (await response.json()) as PublicDoodleList;
}

async function adminList(handle: Handle): Promise<AdminDoodleList> {
	const response = await admin(handle, "admin=list");
	assert.equal(response.status, 200);
	return (await response.json()) as AdminDoodleList;
}

describe("doodle handler: submit, moderate, publish", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("keeps a new doodle off the wall until it is approved", async () => {
		const response = await submit(ctx.handle, {
			image,
			name: "Ada",
			note: "hello!",
		});
		assert.equal(response.status, 201);
		assert.deepEqual(await response.json(), { ok: true, status: "pending" });

		assert.deepEqual((await wall(ctx.handle)).items, []);
		const { pending, approved } = await adminList(ctx.handle);
		assert.equal(pending.length, 1);
		assert.equal(approved.length, 0);
		assert.equal(pending[0].name, "Ada");

		// A pending image is never public.
		const id = pending[0].id;
		const leaked = await ctx.handle(
			new Request(`${ORIGIN}/api/doodles?image=${id}`),
		);
		assert.equal(leaked.status, 404);
		const anon = await ctx.handle(
			new Request(`${ORIGIN}/api/doodles?admin=image&status=pending&id=${id}`),
		);
		assert.equal(anon.status, 401);
		const preview = await admin(
			ctx.handle,
			`admin=image&status=pending&id=${id}`,
		);
		assert.equal(preview.status, 200);
		assert.equal(preview.headers.get("content-type"), "image/png");
		assert.equal(preview.headers.get("cache-control"), "private, no-store");
	});

	it("publishes an approved doodle, newest approval first", async () => {
		await submit(ctx.handle, { image, name: "First" }, { ip: "203.0.113.1" });
		await submit(
			ctx.handle,
			{ image, name: "Second", note: "hi" },
			{ ip: "203.0.113.2" },
		);
		const { pending } = await adminList(ctx.handle);
		const first = pending.find((item) => item.name === "First");
		const second = pending.find((item) => item.name === "Second");
		assert.ok(first && second);

		assert.equal(
			(await admin(ctx.handle, `admin=approve&id=${second.id}`, "POST")).status,
			200,
		);
		assert.equal(
			(await admin(ctx.handle, `admin=approve&id=${first.id}`, "POST")).status,
			200,
		);

		const list = await wall(ctx.handle);
		assert.deepEqual(
			list.items.map((item) => item.name),
			["First", "Second"],
		);
		assert.equal(list.items[1].note, "hi");
		assert.equal(list.items[0].image, `/api/doodles?image=${first.id}`);

		const listResponse = await ctx.handle(new Request(`${ORIGIN}/api/doodles`));
		assert.match(
			listResponse.headers.get("cache-control") ?? "",
			/s-maxage=60/,
		);

		const img = await ctx.handle(
			new Request(`${ORIGIN}${list.items[0].image}`),
		);
		assert.equal(img.status, 200);
		assert.equal(img.headers.get("content-type"), "image/png");
		assert.match(img.headers.get("cache-control") ?? "", /^public/);
		assert.equal(Buffer.from(await img.arrayBuffer())[0], 0x89);

		// Approved items moved out of pending storage.
		assert.equal((await adminList(ctx.handle)).pending.length, 0);
		assert.deepEqual((await ctx.store.list("doodles/pending/")).length, 0);
	});

	it("approving twice is harmless", async () => {
		await submit(ctx.handle, { image });
		const [item] = (await adminList(ctx.handle)).pending;
		assert.equal(
			(await admin(ctx.handle, `admin=approve&id=${item.id}`, "POST")).status,
			200,
		);
		assert.equal(
			(await admin(ctx.handle, `admin=approve&id=${item.id}`, "POST")).status,
			200,
		);
		assert.equal((await wall(ctx.handle)).items.length, 1);
	});

	it("rejects (deletes) a pending doodle", async () => {
		await submit(ctx.handle, { image });
		const [item] = (await adminList(ctx.handle)).pending;
		assert.equal(
			(await admin(ctx.handle, `admin=reject&id=${item.id}`, "POST")).status,
			200,
		);
		assert.equal((await adminList(ctx.handle)).pending.length, 0);
		assert.equal((await ctx.store.list("doodles/")).length, 0);
		assert.equal(
			(await admin(ctx.handle, `admin=reject&id=${item.id}`, "POST")).status,
			404,
		);
	});

	it("removes an approved doodle from the wall", async () => {
		await submit(ctx.handle, { image });
		const [item] = (await adminList(ctx.handle)).pending;
		await admin(ctx.handle, `admin=approve&id=${item.id}`, "POST");
		assert.equal(
			(await admin(ctx.handle, `admin=remove&id=${item.id}`, "POST")).status,
			200,
		);
		assert.deepEqual((await wall(ctx.handle)).items, []);
		const img = await ctx.handle(
			new Request(`${ORIGIN}/api/doodles?image=${item.id}`),
		);
		assert.equal(img.status, 404);
	});

	it("answers a filled honeypot like a success but stores nothing", async () => {
		const response = await submit(ctx.handle, {
			image,
			website: "http://spam.example",
		});
		assert.equal(response.status, 201);
		assert.equal((await ctx.store.list("doodles/")).length, 0);
	});
});

describe("doodle handler: input and abuse checks", () => {
	it("rejects invalid images and text with a clear error", async () => {
		const { handle } = setup();
		const small = toDataUrl(makePng({ width: 10, height: 10 }));
		const response = await submit(handle, { image: small });
		assert.equal(response.status, 400);
		assert.match(
			((await response.json()) as { error: string }).error,
			/960x640/,
		);
		assert.equal(
			(await submit(handle, { image, name: "x".repeat(41) }, { ip: "1.1.1.2" }))
				.status,
			400,
		);
		assert.equal(
			(await submit(handle, "{not json", { ip: "1.1.1.3" })).status,
			400,
		);
	});

	it("caps the request body", async () => {
		const { handle } = setup();
		const response = await submit(handle, {
			image: `data:image/png;base64,${"A".repeat(400_000)}`,
		});
		assert.equal(response.status, 413);
	});

	it("requires JSON and a same-origin request", async () => {
		const { handle } = setup();
		const form = await submit(handle, "x", {
			headers: { "content-type": "text/plain" },
		});
		assert.equal(form.status, 415);
		const cross = await submit(
			handle,
			{ image },
			{ headers: { origin: "https://evil.example" } },
		);
		assert.equal(cross.status, 403);
	});

	it("rate-limits submissions per client", async () => {
		const { handle } = setup();
		for (let i = 0; i < 3; i++) {
			assert.equal((await submit(handle, { image })).status, 201);
		}
		const limited = await submit(handle, { image });
		assert.equal(limited.status, 429);
		assert.ok(Number(limited.headers.get("retry-after")) > 0);
		assert.equal(
			(await submit(handle, { image }, { ip: "203.0.113.99" })).status,
			201,
		);
	});

	it("stops taking doodles when the pending inbox is full", async () => {
		const { handle } = setup({ maxPending: 1 });
		assert.equal(
			(await submit(handle, { image }, { ip: "10.0.0.1" })).status,
			201,
		);
		assert.equal(
			(await submit(handle, { image }, { ip: "10.0.0.2" })).status,
			503,
		);
	});

	it("can be closed to new doodles", async () => {
		const { handle } = setup({ submissionsOpen: false });
		assert.equal((await submit(handle, { image })).status, 503);
	});

	it("answers 503 when no storage is configured", async () => {
		const { handle } = setup({ repo: null });
		assert.equal((await submit(handle, { image })).status, 503);
		assert.equal(
			(await handle(new Request(`${ORIGIN}/api/doodles`))).status,
			503,
		);
	});

	it("rejects bad ids", async () => {
		const { handle } = setup();
		assert.equal(
			(await handle(new Request(`${ORIGIN}/api/doodles?image=../../x`))).status,
			400,
		);
		assert.equal(
			(await admin(handle, "admin=approve&id=nope", "POST")).status,
			400,
		);
	});

	it("only allows GET, HEAD and POST", async () => {
		const { handle } = setup();
		const response = await handle(
			new Request(`${ORIGIN}/api/doodles`, { method: "DELETE" }),
		);
		assert.equal(response.status, 405);
	});
});

describe("doodle handler: moderation auth", () => {
	it("is off without a configured token", async () => {
		const { handle } = setup({ adminToken: null });
		assert.equal((await admin(handle, "admin=list")).status, 503);
	});

	it("rejects a wrong token, then locks the client out for a while", async () => {
		const { handle } = setup();
		for (let i = 0; i < 3; i++) {
			assert.equal(
				(await admin(handle, "admin=list", "GET", "wrong-token")).status,
				401,
			);
		}
		const locked = await admin(handle, "admin=list");
		assert.equal(locked.status, 429);
		assert.equal(
			(await admin(handle, "admin=list", "GET", TOKEN, "198.51.100.8")).status,
			200,
		);
	});

	it("requires the token for every admin action", async () => {
		const { handle } = setup();
		const response = await handle(
			new Request(`${ORIGIN}/api/doodles?admin=approve&id=abc`, {
				method: "POST",
			}),
		);
		assert.equal(response.status, 401);
	});
});

describe("DoodleRepo index writes", () => {
	it("retries when another writer changes the index first", async () => {
		class RacyStore extends MemoryObjectStore {
			raced = false;
			async put(
				key: string,
				body: Uint8Array | string,
				options: PutOptions,
			): Promise<void> {
				if (key === "doodles/approved.json" && !this.raced) {
					this.raced = true;
					// Another tab sneaks an entry in between our read and write.
					await super.put(
						key,
						JSON.stringify({
							version: 1,
							items: [
								{
									id: "zzzzzzzz-000000000000",
									name: "other",
									note: "",
									createdAt: "2026-01-01T00:00:00.000Z",
									approvedAt: "2000-01-01T00:00:00.000Z",
								},
							],
						}),
						{ contentType: "application/json", overwrite: true },
					);
					throw new StoreConflictError(key);
				}
				return super.put(key, body, options);
			}
		}
		const store = new RacyStore();
		const repo = new DoodleRepo(store);
		const meta = await repo.createPending({
			png: new Uint8Array([1]),
			name: "a",
			note: "",
		});
		assert.ok(await repo.approve(meta.id));
		const approved = await repo.listApproved(true);
		assert.deepEqual(
			approved.map((item) => item.id),
			[meta.id, "zzzzzzzz-000000000000"],
		);
	});

	it("refuses to overwrite a corrupt index", async () => {
		const store = new MemoryObjectStore();
		await store.put("doodles/approved.json", "{oops", {
			contentType: "application/json",
		});
		const repo = new DoodleRepo(store);
		const meta = await repo.createPending({
			png: new Uint8Array([1]),
			name: "",
			note: "",
		});
		await assert.rejects(repo.approve(meta.id));
		const raw = await store.get("doodles/approved.json");
		assert.equal(new TextDecoder().decode(raw?.body), "{oops");
	});
});
