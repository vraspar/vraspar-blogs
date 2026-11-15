import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import { inspectPng } from "./png.js";
import { makePng, pngChunk } from "./test-utils.js";

const W = 960;
const H = 640;
const expected = { sizes: [{ width: W, height: H }], maxBytes: 200 * 1024 };

function reason(bytes: Uint8Array, exp = expected): string {
	const result = inspectPng(bytes, exp);
	assert.equal(result.ok, false, "expected the PNG to be rejected");
	return result.ok ? "" : result.reason;
}

describe("inspectPng", () => {
	it("accepts a canvas-like RGBA PNG of the right size", () => {
		assert.deepEqual(inspectPng(makePng({ width: W, height: H }), expected), {
			ok: true,
			width: W,
			height: H,
		});
	});

	it("accepts harmless colour chunks such as sRGB", () => {
		const png = makePng({
			width: W,
			height: H,
			extraChunks: [{ type: "sRGB", data: new Uint8Array([0]) }],
		});
		assert.equal(inspectPng(png, expected).ok, true);
	});

	it("rejects the wrong dimensions", () => {
		assert.match(
			reason(makePng({ width: 480, height: 321 })),
			/must be 960x640, got 480x321/,
		);
	});

	it("accepts any of several allowed sizes", () => {
		const both = {
			...expected,
			sizes: [
				{ width: W, height: H },
				{ width: 480, height: 320 },
			],
		};
		assert.equal(
			inspectPng(makePng({ width: 480, height: 320 }), both).ok,
			true,
		);
		assert.match(
			reason(makePng({ width: 640, height: 480 }), both),
			/960x640 or 480x320, got 640x480/,
		);
	});

	it("rejects files over the byte cap before parsing", () => {
		const png = makePng({ width: W, height: H });
		assert.equal(
			reason(png, { ...expected, maxBytes: png.length - 1 }),
			"image is too large",
		);
	});

	it("rejects non-PNG data", () => {
		assert.equal(reason(Buffer.from("GIF89a".padEnd(64, "x"))), "not a PNG");
	});

	it("rejects a chunk with a bad CRC", () => {
		const png = makePng({ width: W, height: H });
		png[29] ^= 0xff; // first byte of the IHDR CRC
		assert.equal(reason(png), "corrupt PNG");
	});

	it("rejects data after IEND (polyglot files)", () => {
		const png = makePng({
			width: W,
			height: H,
			trailing: Buffer.from("<script>"),
		});
		assert.match(reason(png), /after PNG end/);
	});

	it("rejects text and unknown chunks", () => {
		const png = makePng({
			width: W,
			height: H,
			extraChunks: [{ type: "tEXt", data: Buffer.from("Comment\0hello") }],
		});
		assert.match(reason(png), /unsupported PNG chunk tEXt/);
	});

	it("rejects interlaced images", () => {
		assert.match(
			reason(makePng({ width: W, height: H, interlace: 1 })),
			/interlaced/,
		);
	});

	it("rejects image data that inflates past the header's promise", () => {
		const raw = Buffer.alloc(H * (W * 4 + 1) + 4096, 0);
		assert.equal(
			reason(makePng({ width: W, height: H, raw })),
			"corrupt PNG image data",
		);
	});

	it("rejects image data that is too short", () => {
		const raw = Buffer.alloc(100, 0);
		assert.equal(
			reason(makePng({ width: W, height: H, raw })),
			"corrupt PNG image data",
		);
	});

	it("rejects invalid scanline filter bytes", () => {
		const raw = Buffer.alloc(H * (W * 4 + 1), 0);
		raw[0] = 9;
		assert.equal(
			reason(makePng({ width: W, height: H, raw })),
			"corrupt PNG image data",
		);
	});

	it("rejects a truncated file", () => {
		const png = makePng({ width: W, height: H });
		assert.equal(reason(png.subarray(0, png.length - 6)), "truncated PNG");
	});

	it("rejects a file whose first chunk isn't IHDR", () => {
		const good = makePng({ width: W, height: H });
		const idat = pngChunk("IDAT", deflateSync(Buffer.alloc(10)));
		const bad = Buffer.concat([good.subarray(0, 8), idat, good.subarray(8)]);
		assert.equal(reason(bad), "IHDR must come first");
	});
});
