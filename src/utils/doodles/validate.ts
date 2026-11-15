/*
 * Server-side validation of a doodle submission. Never trust the browser:
 * every limit the drawing UI enforces is checked again here.
 */
import { inspectPng } from "./png.js";
import {
	DOODLE_PNG_SIZES,
	HONEYPOT_FIELD,
	MAX_NAME_LENGTH,
	MAX_NOTE_LENGTH,
	MAX_PNG_BYTES,
} from "./shared.js";

export interface CleanSubmission {
	png: Uint8Array;
	name: string;
	note: string;
}

export type SubmissionResult =
	| { kind: "ok"; value: CleanSubmission }
	/** Honeypot was filled: answer like a success, store nothing. */
	| { kind: "bot" }
	| { kind: "invalid"; status: 400 | 413; error: string };

const DATA_URL_PREFIX = "data:image/png;base64,";
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// C0/C1 controls, then zero-width and bidi-override characters that can be
// used to make a name render as something else.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁩﻿]/g;

/** Largest base64 payload that can decode to MAX_PNG_BYTES. */
export const MAX_BASE64_LENGTH: number = Math.ceil(MAX_PNG_BYTES / 3) * 4;

/**
 * Normalises a free-text field to one tidy line. Returns null when the value
 * is not a string or is still too long after cleaning (length is measured in
 * UTF-16 code units, the same unit the browser's `maxlength` uses).
 */
export function cleanText(value: unknown, maxLength: number): string | null {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") return null;
	const cleaned = value
		.normalize("NFC")
		.replace(CONTROL_RE, " ")
		.replace(INVISIBLE_RE, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxLength ? null : cleaned;
}

/** Decodes a `data:image/png;base64,` URL, or returns null if it is malformed. */
export function decodePngDataUrl(value: unknown): Uint8Array | null {
	if (typeof value !== "string" || !value.startsWith(DATA_URL_PREFIX)) {
		return null;
	}
	const base64 = value.slice(DATA_URL_PREFIX.length);
	if (base64.length === 0 || base64.length % 4 !== 0) return null;
	if (!BASE64_RE.test(base64)) return null;
	return new Uint8Array(Buffer.from(base64, "base64"));
}

export function parseSubmission(body: unknown): SubmissionResult {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { kind: "invalid", status: 400, error: "Malformed request." };
	}
	const fields = body as Record<string, unknown>;

	const trap = fields[HONEYPOT_FIELD];
	if (typeof trap === "string" && trap.trim() !== "") return { kind: "bot" };

	const name = cleanText(fields.name, MAX_NAME_LENGTH);
	if (name === null) {
		return {
			kind: "invalid",
			status: 400,
			error: `Name must be at most ${MAX_NAME_LENGTH} characters.`,
		};
	}
	const note = cleanText(fields.note, MAX_NOTE_LENGTH);
	if (note === null) {
		return {
			kind: "invalid",
			status: 400,
			error: `Note must be at most ${MAX_NOTE_LENGTH} characters.`,
		};
	}

	if (
		typeof fields.image === "string" &&
		fields.image.length > MAX_BASE64_LENGTH + DATA_URL_PREFIX.length
	) {
		return {
			kind: "invalid",
			status: 413,
			error:
				"That doodle is too detailed to send. Try simplifying it a little.",
		};
	}
	const png = decodePngDataUrl(fields.image);
	if (!png) {
		return {
			kind: "invalid",
			status: 400,
			error: "The drawing is missing or not a PNG.",
		};
	}
	const check = inspectPng(png, {
		sizes: DOODLE_PNG_SIZES,
		maxBytes: MAX_PNG_BYTES,
	});
	if (!check.ok) {
		const tooBig = check.reason === "image is too large";
		return {
			kind: "invalid",
			status: tooBig ? 413 : 400,
			error: tooBig
				? "That doodle is too detailed to send. Try simplifying it a little."
				: `The drawing was rejected: ${check.reason}.`,
		};
	}

	return { kind: "ok", value: { png, name, note } };
}
