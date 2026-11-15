/*
 * Doodle wall: constants and types shared by the browser UI and the server
 * handler. Keep this file free of Node and DOM imports so both sides can use it.
 *
 * Server-side modules in this folder are also loaded by the Vercel Function in
 * the root `api/` directory, which runs as native ES modules. Relative imports
 * between them must therefore keep their `.js` extension (Vite and tsx resolve
 * `./x.js` to `./x.ts`; Node does not resolve extensionless paths).
 */

/** The single Vercel Function that serves every doodle route. */
export const DOODLE_API_PATH = "/api/doodles";

/** Logical drawing size in CSS pixels. */
export const DOODLE_WIDTH = 480;
export const DOODLE_HEIGHT = 320;

/**
 * Exported PNGs are a fixed multiple of the logical size, whatever the
 * screen DPR. The pad tries 2x first; a very dense, colourful doodle can pass
 * MAX_PNG_BYTES at 2x, and is then sent at 1x instead of being refused.
 */
export const DOODLE_EXPORT_SCALES: readonly number[] = [2, 1];
export const DOODLE_PNG_WIDTH: number = DOODLE_WIDTH * DOODLE_EXPORT_SCALES[0];
export const DOODLE_PNG_HEIGHT: number =
	DOODLE_HEIGHT * DOODLE_EXPORT_SCALES[0];

/** Every PNG size the server accepts, one per export scale. */
export const DOODLE_PNG_SIZES: readonly { width: number; height: number }[] =
	DOODLE_EXPORT_SCALES.map((scale) => ({
		width: DOODLE_WIDTH * scale,
		height: DOODLE_HEIGHT * scale,
	}));

/** Upper bound for a decoded PNG upload. */
export const MAX_PNG_BYTES: number = 200 * 1024;

export const MAX_NAME_LENGTH = 40;
export const MAX_NOTE_LENGTH = 140;

/** Hidden form field that real visitors never fill in. */
export const HONEYPOT_FIELD = "website";

/** Body of `POST /api/doodles`. */
export interface DoodleSubmission {
	/** `data:image/png;base64,...` */
	image: string;
	name?: string;
	note?: string;
	website?: string;
}

/** One approved doodle as the public wall sees it. */
export interface PublicDoodle {
	id: string;
	name: string;
	note: string;
	createdAt: string;
	approvedAt: string;
	/** Same-origin URL of the PNG. */
	image: string;
}

export interface PublicDoodleList {
	items: PublicDoodle[];
}

export type DoodleStatus = "pending" | "approved";

/** One doodle as the moderation page sees it. */
export interface AdminDoodle {
	id: string;
	status: DoodleStatus;
	name: string;
	note: string;
	createdAt: string;
	approvedAt?: string;
}

export interface AdminDoodleList {
	storage: string;
	pending: AdminDoodle[];
	approved: AdminDoodle[];
}

/** Error body returned by every failing doodle route. */
export interface DoodleApiError {
	error: string;
}

export function publicImageUrl(id: string): string {
	return `${DOODLE_API_PATH}?image=${encodeURIComponent(id)}`;
}

export function adminImageUrl(id: string, status: DoodleStatus): string {
	return `${DOODLE_API_PATH}?admin=image&status=${status}&id=${encodeURIComponent(id)}`;
}
