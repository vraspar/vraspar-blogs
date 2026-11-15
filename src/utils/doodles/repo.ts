/*
 * Doodle storage layout on top of any ObjectStore:
 *
 *   doodles/pending/<id>.png    awaiting moderation (never served publicly)
 *   doodles/pending/<id>.json   { id, name, note, createdAt }
 *   doodles/approved/<id>.png   on the public wall
 *   doodles/approved.json       wall index, newest approval first
 *
 * The wall reads one small index object instead of listing the store, which
 * keeps public traffic off Blob's scarcer "advanced" (list) operations. Only
 * moderation writes the index, with ETag-conditional writes so two tabs
 * approving at once can't drop an entry.
 */
import { randomBytes } from "node:crypto";
import type { DoodleStatus } from "./shared.js";
import { type ObjectStore, StoreConflictError } from "./store.js";

export interface DoodleMeta {
	id: string;
	name: string;
	note: string;
	createdAt: string;
}

export interface ApprovedDoodle extends DoodleMeta {
	approvedAt: string;
}

const PENDING_PREFIX = "doodles/pending/";
const APPROVED_PREFIX = "doodles/approved/";
const INDEX_KEY = "doodles/approved.json";
const INDEX_WRITE_ATTEMPTS = 4;

const ID_RE = /^[0-9a-z]{8,11}-[0-9a-f]{12}$/;

export function isDoodleId(value: unknown): value is string {
	return typeof value === "string" && ID_RE.test(value);
}

export function newDoodleId(now: Date): string {
	return `${now.getTime().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function keyFor(status: DoodleStatus, id: string, ext: "png" | "json"): string {
	return `${status === "pending" ? PENDING_PREFIX : APPROVED_PREFIX}${id}.${ext}`;
}

function byNewest<T>(field: (item: T) => string): (a: T, b: T) => number {
	return (a, b) => field(b).localeCompare(field(a));
}

function parseMeta(body: Uint8Array): DoodleMeta | null {
	try {
		const data = JSON.parse(new TextDecoder().decode(body));
		if (!isDoodleId(data?.id)) return null;
		return {
			id: data.id,
			name: String(data.name ?? ""),
			note: String(data.note ?? ""),
			createdAt: String(data.createdAt ?? ""),
		};
	} catch {
		return null;
	}
}

/** Throws on a corrupt index so a write never silently replaces it with []. */
function parseIndex(body: Uint8Array): ApprovedDoodle[] {
	const data = JSON.parse(new TextDecoder().decode(body));
	if (!Array.isArray(data?.items)) throw new Error("doodle index is malformed");
	return data.items.filter((item: ApprovedDoodle) => isDoodleId(item?.id));
}

export class DoodleRepo {
	private readonly store: ObjectStore;
	private readonly now: () => Date;

	constructor(store: ObjectStore, now: () => Date = () => new Date()) {
		this.store = store;
		this.now = now;
	}

	get storageKind(): string {
		return this.store.kind;
	}

	async createPending(input: {
		png: Uint8Array;
		name: string;
		note: string;
	}): Promise<DoodleMeta> {
		const created = this.now();
		const meta: DoodleMeta = {
			id: newDoodleId(created),
			name: input.name,
			note: input.note,
			createdAt: created.toISOString(),
		};
		// Image first: a metadata file is what makes a pending doodle visible
		// to moderation, so it must never point at a missing image.
		await this.store.put(keyFor("pending", meta.id, "png"), input.png, {
			contentType: "image/png",
		});
		await this.store.put(
			keyFor("pending", meta.id, "json"),
			JSON.stringify(meta),
			{
				contentType: "application/json",
			},
		);
		return meta;
	}

	async countPending(): Promise<number> {
		const keys = await this.store.list(PENDING_PREFIX);
		return keys.filter((key) => key.endsWith(".json")).length;
	}

	async listPending(): Promise<DoodleMeta[]> {
		const keys = (await this.store.list(PENDING_PREFIX)).filter((key) =>
			key.endsWith(".json"),
		);
		const metas = await Promise.all(
			keys.map(async (key) => {
				const object = await this.store.get(key);
				return object ? parseMeta(object.body) : null;
			}),
		);
		return metas
			.filter((meta): meta is DoodleMeta => meta !== null)
			.sort(byNewest((m) => m.createdAt));
	}

	/**
	 * Approved doodles, newest approval first. `fresh` bypasses the read cache
	 * (moderation); the public wall reads through it.
	 */
	async listApproved(fresh = false): Promise<ApprovedDoodle[]> {
		const object = await this.store.get(INDEX_KEY, { fresh });
		return object ? parseIndex(object.body) : [];
	}

	async getImage(id: string, status: DoodleStatus): Promise<Uint8Array | null> {
		if (!isDoodleId(id)) return null;
		const object = await this.store.get(keyFor(status, id, "png"));
		return object ? object.body : null;
	}

	/** Moves a pending doodle onto the wall. Returns null if it doesn't exist. */
	async approve(id: string): Promise<ApprovedDoodle | null> {
		if (!isDoodleId(id)) return null;
		const metaObject = await this.store.get(keyFor("pending", id, "json"), {
			fresh: true,
		});
		const meta = metaObject ? parseMeta(metaObject.body) : null;
		if (!meta || meta.id !== id) {
			// A retried approval whose first attempt already finished.
			const approved = await this.listApproved(true);
			return approved.find((item) => item.id === id) ?? null;
		}

		await this.store.copy(
			keyFor("pending", id, "png"),
			keyFor("approved", id, "png"),
			"image/png",
		);
		const entry: ApprovedDoodle = {
			...meta,
			approvedAt: this.now().toISOString(),
		};
		await this.updateIndex((items) => {
			if (items.some((item) => item.id === id)) return null;
			return [entry, ...items].sort(byNewest((item) => item.approvedAt));
		});
		await this.store.delete([
			keyFor("pending", id, "png"),
			keyFor("pending", id, "json"),
		]);
		return entry;
	}

	/** Deletes a pending doodle. Returns false if it doesn't exist. */
	async reject(id: string): Promise<boolean> {
		if (!isDoodleId(id)) return false;
		const exists = await this.store.get(keyFor("pending", id, "json"), {
			fresh: true,
		});
		await this.store.delete([
			keyFor("pending", id, "png"),
			keyFor("pending", id, "json"),
		]);
		return exists !== null;
	}

	/** Takes an approved doodle off the wall and deletes it. */
	async removeApproved(id: string): Promise<boolean> {
		if (!isDoodleId(id)) return false;
		let found = false;
		await this.updateIndex((items) => {
			found = items.some((item) => item.id === id);
			return found ? items.filter((item) => item.id !== id) : null;
		});
		if (found) await this.store.delete([keyFor("approved", id, "png")]);
		return found;
	}

	/** Read-modify-write of the wall index; `mutate` returns null for "no change". */
	private async updateIndex(
		mutate: (items: ApprovedDoodle[]) => ApprovedDoodle[] | null,
	): Promise<void> {
		for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
			const current = await this.store.get(INDEX_KEY, { fresh: true });
			const next = mutate(current ? parseIndex(current.body) : []);
			if (next === null) return;
			try {
				await this.store.put(
					INDEX_KEY,
					JSON.stringify({ version: 1, items: next }),
					{
						contentType: "application/json",
						ifMatch: current?.etag,
					},
				);
				return;
			} catch (error) {
				if (!(error instanceof StoreConflictError)) throw error;
			}
		}
		throw new Error("doodle index is busy; try again");
	}
}
