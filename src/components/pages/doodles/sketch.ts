/*
 * Vector model behind the doodle pad. Strokes are kept as points in logical
 * (480x320) coordinates and replayed onto any canvas size, so undo is just
 * "drop the last action and redraw" and the exported PNG has a fixed
 * resolution regardless of the visitor's screen.
 */
import { DOODLE_HEIGHT, DOODLE_WIDTH } from "@/utils/doodles/shared";

export interface Stroke {
	kind: "stroke";
	color: string;
	size: number;
	erase: boolean;
	/** Flat [x0, y0, x1, y1, ...] in logical pixels. */
	points: number[];
}

export interface ClearAction {
	kind: "clear";
}

export type SketchAction = Stroke | ClearAction;

/** Ignore pointer jitter smaller than this (logical px). */
const MIN_POINT_DISTANCE = 0.75;

/** Strokes that are still visible: everything after the last "clear". */
export function visibleStrokes(actions: SketchAction[]): Stroke[] {
	const strokes: Stroke[] = [];
	for (const action of actions) {
		if (action.kind === "clear") strokes.length = 0;
		else strokes.push(action);
	}
	return strokes;
}

/** True when there is at least one ink (non-eraser) stroke on the page. */
export function hasInk(actions: SketchAction[]): boolean {
	return visibleStrokes(actions).some((stroke) => !stroke.erase);
}

export function clampPoint(x: number, y: number): [number, number] {
	const cx = Math.min(Math.max(x, 0), DOODLE_WIDTH);
	const cy = Math.min(Math.max(y, 0), DOODLE_HEIGHT);
	return [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10];
}

/** Appends a point unless it is too close to the previous one. */
export function addPoint(stroke: Stroke, x: number, y: number): boolean {
	const n = stroke.points.length;
	if (n >= 2) {
		const dx = x - stroke.points[n - 2];
		const dy = y - stroke.points[n - 1];
		if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE)
			return false;
	}
	stroke.points.push(x, y);
	return true;
}

function applyStyle(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
	ctx.globalCompositeOperation = stroke.erase
		? "destination-out"
		: "source-over";
	ctx.strokeStyle = stroke.color;
	ctx.fillStyle = stroke.color;
	ctx.lineWidth = stroke.size;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
}

function dot(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
	ctx.beginPath();
	ctx.arc(stroke.points[0], stroke.points[1], stroke.size / 2, 0, Math.PI * 2);
	ctx.fill();
}

/** Draws a whole stroke as one smooth path (midpoint quadratic curves). */
export function drawStroke(
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
): void {
	const p = stroke.points;
	const n = p.length / 2;
	if (n === 0) return;
	applyStyle(ctx, stroke);
	if (n === 1) {
		dot(ctx, stroke);
		return;
	}
	ctx.beginPath();
	ctx.moveTo(p[0], p[1]);
	for (let i = 1; i < n - 1; i++) {
		const mx = (p[2 * i] + p[2 * i + 2]) / 2;
		const my = (p[2 * i + 1] + p[2 * i + 3]) / 2;
		ctx.quadraticCurveTo(p[2 * i], p[2 * i + 1], mx, my);
	}
	ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
	ctx.stroke();
}

/**
 * Draws only the newest piece of a stroke while the pointer moves, so live
 * drawing stays cheap. The full stroke is redrawn once the pointer lifts.
 */
export function drawLatest(
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
): void {
	const p = stroke.points;
	const n = p.length / 2;
	applyStyle(ctx, stroke);
	if (n === 1) {
		dot(ctx, stroke);
		return;
	}
	const startX = n === 2 ? p[0] : (p[2 * n - 6] + p[2 * n - 4]) / 2;
	const startY = n === 2 ? p[1] : (p[2 * n - 5] + p[2 * n - 3]) / 2;
	ctx.beginPath();
	ctx.moveTo(startX, startY);
	ctx.quadraticCurveTo(
		p[2 * n - 4],
		p[2 * n - 3],
		(p[2 * n - 4] + p[2 * n - 2]) / 2,
		(p[2 * n - 3] + p[2 * n - 1]) / 2,
	);
	ctx.stroke();
}

/** Clears `ctx` and replays every visible stroke at `scale` device px per logical px. */
export function renderAll(
	ctx: CanvasRenderingContext2D,
	actions: SketchAction[],
	scale: number,
): void {
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	for (const stroke of visibleStrokes(actions)) drawStroke(ctx, stroke);
	ctx.globalCompositeOperation = "source-over";
}

/** Renders the doodle onto `paper` at `scale` x the logical size; returns a PNG data URL. */
export function exportPng(
	actions: SketchAction[],
	paper: string,
	scale: number,
): string {
	const canvas = document.createElement("canvas");
	canvas.width = DOODLE_WIDTH * scale;
	canvas.height = DOODLE_HEIGHT * scale;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas is not available in this browser.");
	renderAll(ctx, actions, scale);
	// Paint the paper *behind* the ink, so eraser strokes reveal paper, not holes.
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = "destination-over";
	ctx.fillStyle = paper;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/png");
}

/** Decoded size in bytes of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
	const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return (base64.length * 3) / 4 - padding;
}
