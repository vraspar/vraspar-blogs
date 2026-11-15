/*
 * Minimal object-store interface the doodle repository is written against,
 * plus two local implementations: in-memory (unit tests) and filesystem
 * (`astro dev`, or any run without Vercel Blob credentials). The Vercel Blob
 * implementation lives in blob-store.ts so local runs never load the SDK.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredObject {
	body: Uint8Array;
	contentType: string;
	etag: string;
}

export interface PutOptions {
	contentType: string;
	/** Replace an existing object. Without it, writing an existing key fails. */
	overwrite?: boolean;
	/** Only write if the current object still has this ETag. */
	ifMatch?: string;
}

export interface GetOptions {
	/** Bypass any cache and read the latest version. */
	fresh?: boolean;
}

/** A conditional write lost a race, or a create-only write found the key taken. */
export class StoreConflictError extends Error {
	constructor(key: string) {
		super(`object ${key} changed or already exists`);
		this.name = "StoreConflictError";
	}
}

export interface ObjectStore {
	/** Short label for logs and the moderation page. */
	readonly kind: string;
	put(
		key: string,
		body: Uint8Array | string,
		options: PutOptions,
	): Promise<void>;
	get(key: string, options?: GetOptions): Promise<StoredObject | null>;
	/** Keys that start with `prefix`, in no particular order. */
	list(prefix: string): Promise<string[]>;
	copy(fromKey: string, toKey: string, contentType: string): Promise<void>;
	delete(keys: string[]): Promise<void>;
}

function toBytes(body: Uint8Array | string): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function etagOf(body: Uint8Array): string {
	return createHash("sha1").update(body).digest("hex");
}

export class MemoryObjectStore implements ObjectStore {
	readonly kind: string = "memory";
	private readonly objects = new Map<string, StoredObject>();

	async put(
		key: string,
		body: Uint8Array | string,
		options: PutOptions,
	): Promise<void> {
		const existing = this.objects.get(key);
		if (options.ifMatch !== undefined) {
			if (!existing || existing.etag !== options.ifMatch) {
				throw new StoreConflictError(key);
			}
		} else if (existing && !options.overwrite) {
			throw new StoreConflictError(key);
		}
		const bytes = toBytes(body).slice();
		this.objects.set(key, {
			body: bytes,
			contentType: options.contentType,
			etag: etagOf(bytes),
		});
	}

	async get(key: string): Promise<StoredObject | null> {
		const found = this.objects.get(key);
		return found ? { ...found, body: found.body.slice() } : null;
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
	}

	async copy(
		fromKey: string,
		toKey: string,
		contentType: string,
	): Promise<void> {
		const found = this.objects.get(fromKey);
		if (!found) throw new Error(`object ${fromKey} not found`);
		this.objects.set(toKey, { ...found, contentType });
	}

	async delete(keys: string[]): Promise<void> {
		for (const key of keys) this.objects.delete(key);
	}
}

const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".json": "application/json",
};

/** Stores objects as plain files under `root`. Single-process use only. */
export class FsObjectStore implements ObjectStore {
	readonly kind: string;
	private readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
		this.kind = `filesystem (${this.root})`;
	}

	private file(key: string): string {
		const resolved = path.resolve(this.root, key);
		if (!resolved.startsWith(this.root + path.sep)) {
			throw new Error(`refusing key outside the store: ${key}`);
		}
		return resolved;
	}

	async put(
		key: string,
		body: Uint8Array | string,
		options: PutOptions,
	): Promise<void> {
		const target = this.file(key);
		const existing = await this.get(key);
		if (options.ifMatch !== undefined) {
			if (!existing || existing.etag !== options.ifMatch) {
				throw new StoreConflictError(key);
			}
		} else if (existing && !options.overwrite) {
			throw new StoreConflictError(key);
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, toBytes(body));
	}

	async get(key: string): Promise<StoredObject | null> {
		try {
			const body = new Uint8Array(await readFile(this.file(key)));
			return {
				body,
				contentType:
					CONTENT_TYPES[path.extname(key)] ?? "application/octet-stream",
				etag: etagOf(body),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async list(prefix: string): Promise<string[]> {
		let entries: string[];
		try {
			entries = await readdir(this.root, { recursive: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return entries
			.map((entry) => entry.split(path.sep).join("/"))
			.filter((key) => key.startsWith(prefix) && path.extname(key) !== "");
	}

	async copy(fromKey: string, toKey: string): Promise<void> {
		const found = await this.get(fromKey);
		if (!found) throw new Error(`object ${fromKey} not found`);
		await this.put(toKey, found.body, {
			contentType: found.contentType,
			overwrite: true,
		});
	}

	async delete(keys: string[]): Promise<void> {
		await Promise.all(keys.map((key) => rm(this.file(key), { force: true })));
	}
}
