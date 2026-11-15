/*
 * `astro dev` only: serves /api/doodles from the same handler the Vercel
 * Function uses, backed by the local filesystem store. Astro's dev server
 * doesn't run the root `api/` folder, so without this the wall can't be
 * tried locally. Never part of a production build (`apply: "serve"`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DOODLE_API_PATH } from "./shared.js";

type Next = (error?: unknown) => void;
type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: Next,
) => void;

/** The slice of Vite's dev server this plugin uses (vite isn't a direct dependency). */
interface DevServer {
	middlewares: { stack: { route: string; handle: Middleware }[] };
	ssrLoadModule(id: string): Promise<Record<string, unknown>>;
}

/** Placeholder token so moderation works locally without any setup. */
export const DEV_ADMIN_TOKEN = "dev-doodle-admin-token-change-me";

async function toRequest(req: IncomingMessage): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) for (const v of value) headers.append(name, v);
		else if (value !== undefined) headers.set(name, value);
	}
	const method = req.method ?? "GET";
	return new Request(
		`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`,
		{
			method,
			headers,
			body:
				method === "GET" || method === "HEAD"
					? undefined
					: Buffer.concat(chunks),
		},
	);
}

export function doodleDevApi(): {
	name: string;
	apply: "serve";
	configureServer(server: DevServer): () => void;
} {
	return {
		name: "vraspar-doodle-dev-api",
		apply: "serve",
		configureServer(server) {
			let handle: ((request: Request) => Promise<Response>) | undefined;
			const middleware: Middleware = (req, res, next) => {
				const path = (req.url ?? "").split("?")[0];
				if (path !== DOODLE_API_PATH) return next();
				(async () => {
					if (!handle) {
						const mod = await server.ssrLoadModule(
							"/src/utils/doodles/runtime.ts",
						);
						const create = mod.createDoodleRuntime as (
							env: Record<string, string | undefined>,
						) => (request: Request) => Promise<Response>;
						const env = { ...process.env };
						delete env.VERCEL;
						// Only the throwaway local store gets a default token; a real
						// Blob store (credentials exported in the shell) needs a real one.
						if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) {
							env.DOODLE_ADMIN_TOKEN ||= DEV_ADMIN_TOKEN;
						}
						handle = create(env);
					}
					const response = await handle(await toRequest(req));
					res.statusCode = response.status;
					for (const [name, value] of response.headers)
						res.setHeader(name, value);
					res.end(Buffer.from(await response.arrayBuffer()));
				})().catch(next);
			};
			// Astro puts its own middlewares (trailing-slash check, router) at the
			// front of the stack in its post hook, and with trailingSlash: "always"
			// it would answer /api/doodles with a 404. This post hook runs after
			// Astro's (user plugins come later), so unshift lands in front of it.
			return () => {
				server.middlewares.stack.unshift({ route: "", handle: middleware });
			};
		},
	};
}
