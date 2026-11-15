/*
 * Strict PNG check for doodle uploads, using only Node built-ins.
 *
 * Accepts what a browser canvas exports: a non-interlaced PNG of one of the
 * expected sizes, every chunk CRC-valid, nothing after IEND, and image data
 * that inflates to exactly the size the header promises (which also caps
 * decompression work). Returns a cleaned copy of the file to store.
 */
import { crc32, inflateSync } from "node:zlib";

export interface PngExpectation {
	sizes: readonly { width: number; height: number }[];
	maxBytes: number;
}

export type PngCheck =
	/** `png` is the file with every non-kept ancillary chunk removed. */
	| { ok: true; width: number; height: number; png: Uint8Array }
	| { ok: false; reason: string };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Critical chunks plus the colour/metadata chunks browsers may emit. Any other
// ancillary chunk (text, EXIF, or a private one some browsers add, such as
// deBG) is dropped so stored images can't carry payloads; an unknown critical
// chunk means we can't read the image, so it is refused.
const KEPT_CHUNKS = new Set([
	"IHDR",
	"PLTE",
	"IDAT",
	"IEND",
	"tRNS",
	"sRGB",
	"gAMA",
	"cHRM",
	"iCCP",
	"cICP",
	"pHYs",
	"bKGD",
	"sBIT",
]);

// colour type -> [samples per pixel, allowed bit depths]
const COLOR_TYPES: Record<number, [number, number[]]> = {
	0: [1, [1, 2, 4, 8, 16]],
	2: [3, [8, 16]],
	3: [1, [1, 2, 4, 8]],
	4: [2, [8, 16]],
	6: [4, [8, 16]],
};

function fail(reason: string): PngCheck {
	return { ok: false, reason };
}

export function inspectPng(
	bytes: Uint8Array,
	expected: PngExpectation,
): PngCheck {
	if (bytes.length > expected.maxBytes) return fail("image is too large");
	if (bytes.length < SIGNATURE.length + 12 + 13 + 12) return fail("not a PNG");
	for (let i = 0; i < SIGNATURE.length; i++) {
		if (bytes[i] !== SIGNATURE[i]) return fail("not a PNG");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = SIGNATURE.length;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = -1;
	let sawPalette = false;
	let sawIend = false;
	let idatState: "none" | "open" | "closed" = "none";
	const idat: Uint8Array[] = [];
	const kept: Uint8Array[] = [bytes.subarray(0, SIGNATURE.length)];
	let dropped = false;

	while (offset < bytes.length) {
		if (offset + 12 > bytes.length) return fail("truncated PNG");
		const length = view.getUint32(offset);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (length > 0x7fffffff || dataEnd + 4 > bytes.length) {
			return fail("truncated PNG");
		}
		const type = String.fromCharCode(...bytes.subarray(offset + 4, dataStart));
		if (!/^[A-Za-z]{4}$/.test(type)) return fail("corrupt PNG");
		const storedCrc = view.getUint32(dataEnd);
		if (crc32(bytes.subarray(offset + 4, dataEnd)) !== storedCrc) {
			return fail("corrupt PNG");
		}
		const isFirst = offset === SIGNATURE.length;
		if (isFirst !== (type === "IHDR")) return fail("IHDR must come first");
		if (!KEPT_CHUNKS.has(type)) {
			// Lowercase first letter = ancillary: safe to drop by the PNG spec.
			const ancillary = type[0] >= "a";
			if (!ancillary) return fail(`unsupported PNG chunk ${type}`);
			dropped = true;
			if (idatState === "open") idatState = "closed";
			offset = dataEnd + 4;
			continue;
		}
		kept.push(bytes.subarray(offset, dataEnd + 4));

		if (type === "IHDR") {
			if (length !== 13) return fail("bad PNG header");
			width = view.getUint32(dataStart);
			height = view.getUint32(dataStart + 4);
			bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			const spec = COLOR_TYPES[colorType];
			if (!spec?.[1].includes(bitDepth)) return fail("bad PNG header");
			if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0) {
				return fail("bad PNG header");
			}
			if (bytes[dataStart + 12] !== 0)
				return fail("interlaced PNGs are not accepted");
			if (
				!expected.sizes.some((s) => s.width === width && s.height === height)
			) {
				const allowed = expected.sizes.map((s) => `${s.width}x${s.height}`);
				return fail(
					`image must be ${allowed.join(" or ")}, got ${width}x${height}`,
				);
			}
		} else if (type === "PLTE") {
			sawPalette = true;
		} else if (type === "IDAT") {
			if (idatState === "closed") return fail("corrupt PNG");
			idatState = "open";
			idat.push(bytes.subarray(dataStart, dataEnd));
		} else if (type === "IEND") {
			sawIend = true;
			if (dataEnd + 4 !== bytes.length)
				return fail("unexpected data after PNG end");
		}
		if (type !== "IDAT" && idatState === "open") idatState = "closed";
		offset = dataEnd + 4;
	}

	if (!sawIend) return fail("truncated PNG");
	if (idat.length === 0) return fail("PNG has no image data");
	if (colorType === 3 && !sawPalette) return fail("bad PNG palette");

	const samples = COLOR_TYPES[colorType][0];
	const stride = Math.ceil((width * samples * bitDepth) / 8);
	const expectedRaw = height * (stride + 1);
	let raw: Uint8Array;
	try {
		raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRaw });
	} catch {
		return fail("corrupt PNG image data");
	}
	if (raw.length !== expectedRaw) return fail("corrupt PNG image data");
	for (let row = 0; row < height; row++) {
		if (raw[row * (stride + 1)] > 4) return fail("corrupt PNG image data");
	}

	const png = dropped ? new Uint8Array(Buffer.concat(kept)) : bytes;
	return { ok: true, width, height, png };
}
