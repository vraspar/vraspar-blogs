/*
 * Test-only helpers: a tiny PNG encoder for building valid and deliberately
 * broken uploads without a canvas. Not imported by any runtime code.
 */
import { crc32, deflateSync } from "node:zlib";

export interface PngOptions {
	width: number;
	height: number;
	/** Colour type byte (6 = RGBA, the browser canvas default). */
	colorType?: number;
	interlace?: number;
	/** Extra chunks inserted before the first IDAT. */
	extraChunks?: { type: string; data: Uint8Array }[];
	/** Raw scanline bytes to compress instead of a blank image. */
	raw?: Uint8Array;
	/** Bytes appended after IEND. */
	trailing?: Uint8Array;
}

export function pngChunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

export function makePng(options: PngOptions): Buffer {
	const { width, height, colorType = 6, interlace = 0 } = options;
	const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = colorType;
	header[10] = 0;
	header[11] = 0;
	header[12] = interlace;
	const raw = options.raw ?? Buffer.alloc(height * (width * channels + 1), 0);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		...(options.extraChunks ?? []).map((chunk) =>
			pngChunk(chunk.type, chunk.data),
		),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", new Uint8Array(0)),
		options.trailing ?? Buffer.alloc(0),
	]);
}

export function toDataUrl(bytes: Uint8Array): string {
	return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}
