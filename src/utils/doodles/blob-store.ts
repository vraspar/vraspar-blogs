/*
 * ObjectStore backed by a *private* Vercel Blob store. Nothing in it is
 * reachable by URL: every read goes through the doodle Function, which only
 * serves approved images to the public.
 *
 * Credentials are resolved by the SDK: OIDC (`BLOB_STORE_ID` + the token
 * Vercel injects) when the store is connected to the project, otherwise
 * `BLOB_READ_WRITE_TOKEN`.
 */
import {
	BlobError,
	BlobPreconditionFailedError,
	copy,
	del,
	get,
	list,
	put,
} from "@vercel/blob";
import {
	type GetOptions,
	type ObjectStore,
	type PutOptions,
	StoreConflictError,
	type StoredObject,
} from "./store.js";

function isConflict(error: unknown): boolean {
	if (error instanceof BlobPreconditionFailedError) return true;
	// Create-only writes to a taken pathname surface as a generic BlobError.
	return error instanceof BlobError && /already exists/i.test(error.message);
}

export class VercelBlobStore implements ObjectStore {
	readonly kind: string = "vercel-blob (private)";

	async put(
		key: string,
		body: Uint8Array | string,
		options: PutOptions,
	): Promise<void> {
		try {
			await put(key, typeof body === "string" ? body : Buffer.from(body), {
				access: "private",
				contentType: options.contentType,
				addRandomSuffix: false,
				allowOverwrite:
					options.overwrite === true || options.ifMatch !== undefined,
				ifMatch: options.ifMatch,
			});
		} catch (error) {
			if (isConflict(error)) throw new StoreConflictError(key);
			throw error;
		}
	}

	async get(key: string, options?: GetOptions): Promise<StoredObject | null> {
		const result = await get(key, {
			access: "private",
			useCache: options?.fresh !== true,
		});
		if (result?.statusCode !== 200) return null;
		const body = new Uint8Array(
			await new Response(result.stream).arrayBuffer(),
		);
		return {
			body,
			contentType: result.blob.contentType,
			etag: result.blob.etag,
		};
	}

	async list(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await list({ prefix, cursor, limit: 1000 });
			for (const blob of page.blobs) keys.push(blob.pathname);
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
		return keys;
	}

	async copy(
		fromKey: string,
		toKey: string,
		contentType: string,
	): Promise<void> {
		await copy(fromKey, toKey, {
			access: "private",
			contentType,
			addRandomSuffix: false,
			allowOverwrite: true,
		});
	}

	async delete(keys: string[]): Promise<void> {
		if (keys.length > 0) await del(keys);
	}
}
