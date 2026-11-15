import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { bearerToken, clientIp, RateLimiter, tokensMatch } from "./security.js";
import { FsObjectStore, StoreConflictError } from "./store.js";

describe("tokensMatch", () => {
	it("matches equal tokens only", () => {
		assert.equal(tokensMatch("abc", "abc"), true);
		assert.equal(tokensMatch("abc", "abd"), false);
		assert.equal(tokensMatch("abc", "abcd"), false);
		assert.equal(tokensMatch("", "abc"), false);
	});
});

describe("request helpers", () => {
	it("reads a bearer token", () => {
		const request = new Request("https://x.test", {
			headers: { authorization: "Bearer  s3cret " },
		});
		assert.equal(bearerToken(request), "s3cret");
		assert.equal(bearerToken(new Request("https://x.test")), null);
		assert.equal(
			bearerToken(
				new Request("https://x.test", {
					headers: { authorization: "Basic abc" },
				}),
			),
			null,
		);
	});

	it("prefers x-real-ip, then the first x-forwarded-for hop", () => {
		const both = new Request("https://x.test", {
			headers: { "x-real-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" },
		});
		assert.equal(clientIp(both), "1.2.3.4");
		const forwarded = new Request("https://x.test", {
			headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1" },
		});
		assert.equal(clientIp(forwarded), "5.6.7.8");
		assert.equal(clientIp(new Request("https://x.test")), "unknown");
	});
});

describe("RateLimiter", () => {
	it("enforces every rule and reports when to retry", () => {
		const limiter = new RateLimiter([
			{ limit: 2, windowMs: 1000 },
			{ limit: 3, windowMs: 10_000 },
		]);
		limiter.hit("a", 0);
		limiter.hit("a", 100);
		assert.equal(limiter.retryAfter("a", 200), 1);
		assert.equal(limiter.retryAfter("a", 1001), 0);
		limiter.hit("a", 1001);
		assert.equal(limiter.retryAfter("a", 2500), 8);
		assert.equal(limiter.retryAfter("b", 2500), 0);
		assert.equal(limiter.retryAfter("a", 10_001), 0);
	});

	it("forgets the oldest keys beyond its size cap", () => {
		const limiter = new RateLimiter([{ limit: 1, windowMs: 1000 }], 2);
		limiter.hit("a", 0);
		limiter.hit("b", 0);
		limiter.hit("c", 0);
		assert.equal(limiter.retryAfter("a", 1), 0);
		assert.equal(limiter.retryAfter("c", 1), 1);
	});
});

describe("FsObjectStore", () => {
	it("round-trips objects and enforces create-only and ifMatch", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "doodles-"));
		try {
			const store = new FsObjectStore(root);
			await store.put("doodles/pending/a.json", "{}", {
				contentType: "application/json",
			});
			await assert.rejects(
				store.put("doodles/pending/a.json", "{}", {
					contentType: "application/json",
				}),
				StoreConflictError,
			);
			const found = await store.get("doodles/pending/a.json");
			assert.equal(found?.contentType, "application/json");
			await assert.rejects(
				store.put("doodles/pending/a.json", "[]", {
					contentType: "application/json",
					ifMatch: "nope",
				}),
				StoreConflictError,
			);
			await store.put("doodles/pending/a.json", "[]", {
				contentType: "application/json",
				ifMatch: found?.etag,
			});
			await store.copy("doodles/pending/a.json", "doodles/approved/a.json");
			assert.deepEqual((await store.list("doodles/")).sort(), [
				"doodles/approved/a.json",
				"doodles/pending/a.json",
			]);
			await store.delete(["doodles/pending/a.json"]);
			assert.equal(await store.get("doodles/pending/a.json"), null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refuses keys that escape its root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "doodles-"));
		try {
			const store = new FsObjectStore(root);
			await assert.rejects(
				store.put("../escape.png", "x", { contentType: "image/png" }),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
