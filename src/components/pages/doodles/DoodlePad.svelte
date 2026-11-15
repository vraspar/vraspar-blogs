<script lang="ts">
import { onMount } from "svelte";
import {
	DOODLE_API_PATH,
	DOODLE_EXPORT_SCALES,
	DOODLE_HEIGHT,
	DOODLE_WIDTH,
	HONEYPOT_FIELD,
	MAX_NAME_LENGTH,
	MAX_NOTE_LENGTH,
	MAX_PNG_BYTES,
} from "@/utils/doodles/shared";
import {
	addPoint,
	clampPoint,
	dataUrlBytes,
	drawLatest,
	exportPng,
	hasInk,
	renderAll,
	type SketchAction,
	type Stroke,
} from "./sketch";

// Colours come from the theme, so they follow the visitor's hue picker.
const SWATCHES = [
	{ id: "ink", label: "Ink", css: "oklch(0.25 0.02 var(--hue))" },
	{ id: "accent", label: "Accent", css: "var(--primary)" },
	{ id: "red", label: "Red", css: "var(--admonitions-color-caution)" },
	{ id: "blue", label: "Blue", css: "var(--admonitions-color-note)" },
	{ id: "teal", label: "Teal", css: "var(--admonitions-color-tip)" },
	{ id: "white", label: "White", css: "#ffffff" },
];
const SIZES = [
	{ label: "Thin", px: 3 },
	{ label: "Medium", px: 7 },
	{ label: "Thick", px: 14 },
];

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D | null = null;
let scale = 1;

// Strokes are plain (non-reactive) data: they change on every pointer move.
let actions: SketchAction[] = [];
let active: { pointerId: number; stroke: Stroke } | null = null;

let swatch = $state("ink");
let sizeIndex = $state(1);
let erasing = $state(false);
let canUndo = $state(false);
let inked = $state(false);

let name = $state("");
let note = $state("");
let trap = $state("");
let status: "idle" | "sending" | "sent" | "error" = $state("idle");
let message = $state("");

function sync() {
	canUndo = actions.length > 0;
	inked = hasInk(actions);
	if (status === "sent" || status === "error") {
		status = "idle";
		message = "";
	}
}

function redraw() {
	if (ctx) renderAll(ctx, actions, scale);
}

function resize() {
	const rect = canvas.getBoundingClientRect();
	if (rect.width === 0) return;
	const dpr = Math.min(window.devicePixelRatio || 1, 3);
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(
		((rect.width * dpr) / DOODLE_WIDTH) * DOODLE_HEIGHT,
	);
	scale = canvas.width / DOODLE_WIDTH;
	redraw();
}

onMount(() => {
	ctx = canvas.getContext("2d");
	resize();
	const observer = new ResizeObserver(resize);
	observer.observe(canvas);
	return () => observer.disconnect();
});

function pointFrom(event: PointerEvent): [number, number] {
	const rect = canvas.getBoundingClientRect();
	return clampPoint(
		((event.clientX - rect.left) / rect.width) * DOODLE_WIDTH,
		((event.clientY - rect.top) / rect.height) * DOODLE_HEIGHT,
	);
}

/** The swatch's resolved colour right now (follows dark mode and the hue picker). */
function currentColor(): string {
	const el = canvas.closest("form")?.querySelector(`[data-swatch="${swatch}"]`);
	return el ? getComputedStyle(el).backgroundColor : "#000";
}

function onPointerDown(event: PointerEvent) {
	if (active || status === "sending" || !ctx) return;
	if (event.pointerType === "mouse" && event.button !== 0) return;
	event.preventDefault();
	// Keep keyboard undo working after a mouse stroke; skip on touch, where a
	// focus ring after every stroke is just noise.
	if (event.pointerType !== "touch") canvas.focus({ preventScroll: true });
	canvas.setPointerCapture(event.pointerId);
	const stroke: Stroke = {
		kind: "stroke",
		color: currentColor(),
		size: SIZES[sizeIndex].px * (erasing ? 1.8 : 1),
		erase: erasing,
		points: [],
	};
	const [x, y] = pointFrom(event);
	addPoint(stroke, x, y);
	actions.push(stroke);
	active = { pointerId: event.pointerId, stroke };
	drawLatest(ctx, stroke);
}

function onPointerMove(event: PointerEvent) {
	if (!active || event.pointerId !== active.pointerId || !ctx) return;
	const events = event.getCoalescedEvents?.() ?? [];
	for (const e of events.length > 0 ? events : [event]) {
		const [x, y] = pointFrom(e);
		if (addPoint(active.stroke, x, y)) drawLatest(ctx, active.stroke);
	}
}

function onPointerEnd(event: PointerEvent) {
	if (!active || event.pointerId !== active.pointerId) return;
	active = null;
	redraw();
	sync();
}

function undo() {
	if (active || actions.length === 0) return;
	actions.pop();
	redraw();
	sync();
}

function clear() {
	if (active || !inked) return;
	actions.push({ kind: "clear" });
	redraw();
	sync();
}

function onCanvasKey(event: KeyboardEvent) {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
		event.preventDefault();
		undo();
	}
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		if (body.error) return body.error;
	} catch {
		// not JSON (e.g. a host without the doodle Function)
	}
	if (response.status === 404)
		return "The doodle wall isn't available on this site right now.";
	return `Something went wrong (HTTP ${response.status}). Please try again later.`;
}

async function submit(event: SubmitEvent) {
	event.preventDefault();
	if (status === "sending" || !inked) return;

	const paper = getComputedStyle(canvas).backgroundColor || "#ffffff";
	// Sharp 2x export first; fall back to 1x for very dense doodles.
	let image = "";
	for (const exportScale of DOODLE_EXPORT_SCALES) {
		image = exportPng(actions, paper, exportScale);
		if (dataUrlBytes(image) <= MAX_PNG_BYTES) break;
	}
	if (dataUrlBytes(image) > MAX_PNG_BYTES) {
		status = "error";
		message =
			"That doodle is too detailed to send. Try simplifying it a little.";
		return;
	}

	status = "sending";
	message = "";
	try {
		const response = await fetch(DOODLE_API_PATH, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ image, name, note, [HONEYPOT_FIELD]: trap }),
		});
		if (!response.ok) {
			status = "error";
			message = await errorMessage(response);
			return;
		}
		actions = [];
		note = "";
		redraw();
		canUndo = false;
		inked = false;
		status = "sent";
		message =
			"Thanks! Your doodle will go up on the wall once I've had a look.";
	} catch {
		status = "error";
		message = "Couldn't reach the server. Check your connection and try again.";
	}
}
</script>

<form class="doodle-pad" onsubmit={submit} novalidate>
	<div class="doodle-pad__layout">
		<div class="doodle-pad__surface">
			<canvas
				bind:this={canvas}
				class="doodle-canvas"
				class:is-erasing={erasing}
				width={DOODLE_WIDTH}
				height={DOODLE_HEIGHT}
				tabindex="0"
				role="img"
				aria-label="Drawing area. Draw with a mouse, pen or finger. Ctrl or Cmd+Z undoes the last stroke."
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerEnd}
				onpointercancel={onPointerEnd}
				onlostpointercapture={onPointerEnd}
				onkeydown={onCanvasKey}
			></canvas>
			{#if !inked}
				<p class="doodle-canvas__hint" aria-hidden="true">Draw here</p>
			{/if}
		</div>

		<div class="doodle-tools">
			<fieldset class="doodle-tools__group">
				<legend class="doodle-tools__label">Colour</legend>
				<div class="flex flex-wrap gap-2">
					{#each SWATCHES as item (item.id)}
						<button
							type="button"
							data-swatch={item.id}
							class="doodle-swatch"
							style="--swatch: {item.css}"
							aria-label={item.label}
							aria-pressed={!erasing && swatch === item.id}
							title={item.label}
							onclick={() => {
								swatch = item.id;
								erasing = false;
							}}
						></button>
					{/each}
				</div>
			</fieldset>

			<fieldset class="doodle-tools__group">
				<legend class="doodle-tools__label">Brush</legend>
				<div class="flex flex-wrap gap-2">
					{#each SIZES as size, i (size.px)}
						<button
							type="button"
							class="doodle-tool"
							aria-label="{size.label} brush"
							aria-pressed={sizeIndex === i}
							title="{size.label} brush"
							onclick={() => (sizeIndex = i)}
						>
							<span class="doodle-tool__dot" style="width: {size.px + 3}px; height: {size.px + 3}px"></span>
						</button>
					{/each}
					<button
						type="button"
						class="doodle-tool"
						aria-pressed={erasing}
						aria-label="Eraser"
						title="Eraser"
						onclick={() => (erasing = !erasing)}
					>
						<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M8 20 3.6 15.6a2 2 0 0 1 0-2.8l8.8-8.8a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L12 20Z" />
							<path d="M8 20h12M8.5 9.5l6 6" />
						</svg>
					</button>
				</div>
			</fieldset>

			<div class="doodle-tools__group flex flex-wrap gap-2">
				<button type="button" class="doodle-action" onclick={undo} disabled={!canUndo || status === "sending"}>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M9 14 4 9l5-5" />
						<path d="M4 9h10a6 6 0 0 1 0 12h-3" />
					</svg>
					Undo
				</button>
				<button type="button" class="doodle-action" onclick={clear} disabled={!inked || status === "sending"}>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
					</svg>
					Clear
				</button>
			</div>
		</div>
	</div>

	<div class="doodle-fields">
		<label class="doodle-field">
			<span class="doodle-field__label">Name <span class="doodle-field__hint">optional</span></span>
			<input
				type="text"
				bind:value={name}
				maxlength={MAX_NAME_LENGTH}
				autocomplete="nickname"
				placeholder="Who drew this?"
			/>
		</label>
		<label class="doodle-field">
			<span class="doodle-field__label">
				Note <span class="doodle-field__hint">optional</span>
				<span class="doodle-field__count" aria-hidden="true">{note.length}/{MAX_NOTE_LENGTH}</span>
			</span>
			<input
				type="text"
				bind:value={note}
				maxlength={MAX_NOTE_LENGTH}
				autocomplete="off"
				placeholder="Say hi, or tell me what it is"
			/>
		</label>
		<!-- Honeypot: hidden from people and assistive tech, irresistible to bots. -->
		<label class="doodle-trap" aria-hidden="true">
			Website
			<input type="text" name={HONEYPOT_FIELD} bind:value={trap} tabindex="-1" autocomplete="off" />
		</label>
	</div>

	<div class="doodle-submit">
		<button type="submit" class="doodle-submit__button" disabled={!inked || status === "sending"}>
			{#if status === "sending"}
				<span class="doodle-spinner" aria-hidden="true"></span>
				Sending…
			{:else}
				Pin it to the wall
			{/if}
		</button>
		<p
			class="doodle-status"
			class:is-error={status === "error"}
			class:is-sent={status === "sent"}
			role="status"
			aria-live="polite"
		>
			{#if message}
				{message}
			{:else if !inked}
				Draw something first, then pin it up.
			{:else}
				I look at every doodle before it goes on the wall.
			{/if}
		</p>
	</div>
</form>
