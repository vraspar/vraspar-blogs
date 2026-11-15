import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOODLE_PNG_HEIGHT, DOODLE_PNG_WIDTH } from "./shared.js";
import { makePng, toDataUrl } from "./test-utils.js";
import { cleanText, decodePngDataUrl, parseSubmission } from "./validate.js";

const image = toDataUrl(
	makePng({ width: DOODLE_PNG_WIDTH, height: DOODLE_PNG_HEIGHT }),
);

describe("cleanText", () => {
	it("treats missing values as empty", () => {
		assert.equal(cleanText(undefined, 10), "");
		assert.equal(cleanText(null, 10), "");
	});

	it("rejects non-strings", () => {
		assert.equal(cleanText(42, 10), null);
		assert.equal(cleanText(["a"], 10), null);
	});

	it("collapses whitespace and strips control and bidi characters", () => {
		assert.equal(cleanText("  hi\n\tthere\u0007 ", 40), "hi there");
		assert.equal(cleanText("evil‮txt.exe​", 40), "eviltxt.exe");
	});

	it("measures length after cleaning, in UTF-16 units like maxlength", () => {
		assert.equal(cleanText(`${"a".repeat(40)}   `, 40), "a".repeat(40));
		assert.equal(cleanText("a".repeat(41), 40), null);
		assert.equal(cleanText("😀".repeat(21), 40), null);
	});
});

describe("decodePngDataUrl", () => {
	it("decodes a PNG data URL", () => {
		const bytes = decodePngDataUrl("data:image/png;base64,iVBORw0KGgo=");
		assert.deepEqual([...(bytes ?? [])].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
	});

	it("rejects other types and malformed base64", () => {
		assert.equal(decodePngDataUrl("data:image/jpeg;base64,AAAA"), null);
		assert.equal(decodePngDataUrl("data:image/png;base64,@@@@"), null);
		assert.equal(decodePngDataUrl("data:image/png;base64,abc"), null);
		assert.equal(decodePngDataUrl("data:image/png;base64,"), null);
		assert.equal(decodePngDataUrl(123), null);
	});
});

describe("parseSubmission", () => {
	it("accepts a valid submission and cleans its text", () => {
		const result = parseSubmission({
			image,
			name: "  Ada ",
			note: "hi\nthere",
		});
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.equal(result.value.name, "Ada");
			assert.equal(result.value.note, "hi there");
			assert.equal(result.value.png[0], 0x89);
		}
	});

	it("allows name and note to be left out", () => {
		assert.equal(parseSubmission({ image }).kind, "ok");
	});

	it("accepts the 1x fallback size for very dense doodles", () => {
		const small = toDataUrl(makePng({ width: 480, height: 320 }));
		assert.equal(parseSubmission({ image: small }).kind, "ok");
	});

	it("flags a filled honeypot as a bot", () => {
		assert.deepEqual(parseSubmission({ image, website: "http://spam" }), {
			kind: "bot",
		});
	});

	it("rejects overlong text", () => {
		const name = parseSubmission({ image, name: "x".repeat(41) });
		assert.equal(name.kind === "invalid" && name.status, 400);
		const note = parseSubmission({ image, note: "x".repeat(141) });
		assert.equal(note.kind === "invalid" && note.status, 400);
	});

	it("rejects a missing or wrong-size image", () => {
		assert.equal(parseSubmission({ name: "x" }).kind, "invalid");
		const odd = toDataUrl(makePng({ width: 300, height: 200 }));
		const result = parseSubmission({ image: odd });
		assert.equal(result.kind, "invalid");
		if (result.kind === "invalid")
			assert.match(result.error, /960x640 or 480x320/);
	});

	it("answers 413 for an oversized payload without decoding it", () => {
		const huge = `data:image/png;base64,${"A".repeat(300_000)}`;
		const result = parseSubmission({ image: huge });
		assert.equal(result.kind === "invalid" && result.status, 413);
	});

	it("rejects non-object bodies", () => {
		assert.equal(parseSubmission(null).kind, "invalid");
		assert.equal(parseSubmission([image]).kind, "invalid");
		assert.equal(parseSubmission("x").kind, "invalid");
	});
});
