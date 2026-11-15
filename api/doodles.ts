/*
 * Vercel Function for the doodle wall (guestbook page).
 *
 * Vercel's zero-config build compiles every file in the root `api/` folder
 * with @vercel/node, next to the static Astro build, so the site output in
 * `dist/` is unchanged. See docs/doodle-wall.md.
 *
 * This runs as a native ES module: keep the `.js` extension on relative
 * imports, or the Function builds fine and then fails at runtime.
 */
import { createDoodleRuntime } from "../src/utils/doodles/runtime.js";

const handle = createDoodleRuntime(process.env);

export default {
	fetch(request: Request): Promise<Response> {
		return handle(request);
	},
};
