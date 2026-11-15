# Doodle wall

Visitors draw a small sketch on the guestbook page, optionally add a name and a
short note, and pin it to the wall. Nothing is public until you approve it on
`/admin/doodles/`. Approved doodles show on the guestbook, newest approval first.

## How it works

```
guestbook page (static)                     Vercel Function: api/doodles.ts
┌───────────────────────────┐   POST     ┌──────────────────────────────────┐
│ DoodlePad (canvas)        │ ─────────▶ │ validate → doodles/pending/<id>  │
│ DoodleGrid (public wall)  │ ◀───────── │ GET list ← doodles/approved.json │
└───────────────────────────┘   GET      │ GET image ← doodles/approved/…   │
/admin/doodles/ (static)    Bearer token │ approve / reject / remove        │
┌───────────────────────────┐ ─────────▶ └──────────────┬───────────────────┘
│ DoodleAdmin               │                           │ @vercel/blob
└───────────────────────────┘                  private Blob store
```

- **The site stays static.** `pnpm build` and `dist/` are unchanged. The only
  server code is one file in the root `api/` folder, which Vercel's zero-config
  build compiles as a Node.js Function next to the Astro output. All routes go
  to that one function (`/api/doodles` with query parameters), so there is one
  cold start and the in-memory rate limits are shared across routes.
- **Drawing** (`src/components/pages/doodles/`): plain canvas and pointer events,
  no library. Strokes are stored as vectors in 480x320 logical coordinates, so
  undo just replays them, and the PNG is always exported at a fixed 960x640
  (or 480x320 for a very dense doodle that would pass the size cap at 2x),
  whatever the visitor's screen. The paper is always light, so every doodle on
  the wall looks the same in light and dark mode. The island loads with
  `client:visible` on the guestbook only; no other page loads its JS.
- **Validation** (`src/utils/doodles/validate.ts`, `png.ts`), all server-side:
  - PNG signature, IHDR first, dimensions exactly 960x640 or 480x320, valid CRC
    on every chunk, no text/EXIF/unknown chunks, nothing after `IEND`, not
    interlaced, and the image data must inflate to exactly the size the header
    promises (which also stops decompression bombs).
  - At most 200 KB decoded; the request body is capped while it is read.
  - Name up to 40 and note up to 140 characters, after stripping control,
    zero-width and bidi-override characters and collapsing whitespace.
  - A hidden honeypot field (`website`). Bots that fill it get a fake success.
  - JSON only, and a cross-site `Origin` is refused.
- **Storage** (`src/utils/doodles/repo.ts`) in a **private** Vercel Blob store:

  | Path | What |
  | --- | --- |
  | `doodles/pending/<id>.png` and `.json` | Waiting for review, never served publicly |
  | `doodles/approved/<id>.png` | On the wall |
  | `doodles/approved.json` | The wall index (one small file the public list reads) |

  Approving copies the PNG to `approved/`, adds it to the index with an
  ETag-conditional write (two tabs approving at once can't lose an entry), and
  deletes the pending files. Rejecting deletes them. "Remove from wall" drops
  an approved doodle from the index and deletes its PNG.
- **Public wall**: `GET /api/doodles` returns the newest 120 approved doodles
  (`Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=600`).
  Images are streamed from the private store by the function and cached by the
  CDN for a day.
- **No IPs are stored.** Rate limiting hashes the IP with a random
  per-instance salt and keeps the hash in memory only.

### Why a root `api/` function and not `@astrojs/vercel`

Vercel builds Functions from the root `api/` directory for projects that aren't
Next.js ([Functions quickstart](https://vercel.com/docs/functions/quickstart),
[Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)), and a
static Astro site needs no adapter
([Astro on Vercel](https://vercel.com/docs/frameworks/frontend/astro)). This was
checked with a local `vercel build` (framework preset `astro`, nothing linked or
deployed): the CLI ran two builders, `@vercel/node` for `api/doodles.ts` and
`@vercel/static-build` for `pnpm build` with `outputDirectory: dist`. The static
output was the usual `dist/` (pagefind index, pruned mascot assets, minified
scripts) and the function landed in `.vercel/output/functions/api/doodles.func`
on `nodejs24.x`. The compiled function was then imported and driven locally.

Adding `@astrojs/vercel` instead would make Astro emit `.vercel/output` itself,
so `dist/` would no longer be the site root and the post-build scripts
(`prune-pio-assets`, `subset-fonts`, `minify-inline-scripts`, `run-pagefind`)
would need reworking. Not worth it for one endpoint.

**Gotcha:** the function runs as native ES modules (`"type": "module"`), and
`@vercel/node` compiles TypeScript file by file without rewriting imports.
Relative imports in `api/` and `src/utils/doodles/` must keep the `.js`
extension (`import … from "./repo.js"`). An extensionless import builds fine and
then crashes at runtime with `ERR_MODULE_NOT_FOUND`. Vite and tsx resolve
`./x.js` to `./x.ts`, so the same files work in `astro dev` and the tests.
Path aliases (`@/…`) aren't supported in the function either.

## Setting it up on Vercel (one time)

1. **Create a private Blob store.** In the project, open the **Storage** tab →
   **Create Storage** → **Blob** → **Continue**, and set access to **Private**
   (this can't be changed later). Pick the region closest to where your
   functions run. See [Private storage](https://vercel.com/docs/vercel-blob/private-storage).
2. **Connect it to the project**, ideally for the **Production** environment
   only (store → **Projects** → **Connect to Project**, if creating it from the
   project didn't already). Vercel then adds `BLOB_STORE_ID` and authenticates
   with short-lived OIDC tokens, so no long-lived secret is needed. You don't
   need the optional `BLOB_READ_WRITE_TOKEN`, though the code accepts it too.
   Preview deployments without the store answer "isn't set up yet" instead of
   writing to production data.
3. **Add the moderation token.** Settings → Environment Variables →
   `DOODLE_ADMIN_TOKEN`, Production, marked Sensitive. Use at least 24
   random characters, for example `openssl rand -base64 32`. Shorter values are
   ignored and moderation stays off.
4. **Redeploy** so the new variables apply.
5. **Recommended: an edge rate limit.** The function's own limits are per
   instance (see Limits). Hobby includes one WAF rate-limit rule
   ([WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)):
   Firewall → Configure → New Rule, *Request Path equals `/api/doodles`* and
   *Method equals `POST`*, action **Rate Limit**, fixed window 600 s, 5
   requests, key IP, then publish.

Optional variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `DOODLE_SUBMISSIONS` | `open` | `closed` turns off new submissions; the wall still shows |
| `DOODLE_MAX_PENDING` | `100` | New submissions are refused while this many await review |

## Moderating

1. Open `https://<your-site>/admin/doodles/` (not linked anywhere, kept out of
   the sitemap, `noindex` meta tag plus an `X-Robots-Tag` header).
2. Paste `DOODLE_ADMIN_TOKEN` and **Unlock**. The token stays in this tab's
   `sessionStorage` until you press **Lock** or close the tab. The page itself
   is static and holds nothing secret; every action is checked by the function,
   which compares tokens in constant time and, after 10 wrong tokens in 15
   minutes, makes that client wait before trying again.
3. **Approve** puts a doodle on the wall, **Reject** deletes it, and **Remove
   from wall** takes an approved one down and deletes it.

The public list is cached for about a minute (up to ~90 s with the browser
cache), so changes show up on the guestbook after that. A removed doodle's
image URL can still be served from the CDN cache for up to a day, though it is
no longer listed anywhere.

## Local development

- `pnpm dev`, then open `/guestbook/`. Astro's dev server doesn't run the root
  `api/` folder, so a dev-only Vite middleware (`src/utils/doodles/dev-api.ts`,
  `apply: "serve"`) serves `/api/doodles` with the same handler, backed by files
  in `.doodles-dev/` (gitignored; delete it to start over).
- Moderate at `/admin/doodles/` with the token `dev-doodle-admin-token-change-me`,
  or your own `DOODLE_ADMIN_TOKEN` if it is set in the shell.
- To try the real store locally, export `BLOB_READ_WRITE_TOKEN` (and a real
  `DOODLE_ADMIN_TOKEN`) in the shell before `pnpm dev`.
- `pnpm preview` serves only the static build, so the wall shows its "couldn't
  load" state there. The same happens on the Cloudflare Workers build, which
  doesn't deploy the `api/` folder.
- `pnpm test` runs the unit tests (Node's built-in test runner via `tsx`, no
  extra dependency): PNG checks, text cleaning, rate limiting, both local stores,
  and the full handler flow against an in-memory store.

## API

| Request | Auth | Result |
| --- | --- | --- |
| `GET /api/doodles` | none | `{ items: [{ id, name, note, createdAt, approvedAt, image }] }` |
| `GET /api/doodles?image=<id>` | none | Approved PNG |
| `POST /api/doodles` | none | Body `{ image: "data:image/png;base64,…", name?, note?, website? }` → `201 { ok, status: "pending" }` |
| `GET /api/doodles?admin=list` | Bearer | `{ storage, pending: […], approved: […] }` |
| `GET /api/doodles?admin=image&status=pending\|approved&id=<id>` | Bearer | PNG, `no-store` |
| `POST /api/doodles?admin=approve\|reject\|remove&id=<id>` | Bearer | `{ ok }` |

Errors are `{ "error": "message" }` with a 4xx/5xx status: 400 bad input, 401 bad
token, 403 cross-site, 413 too large, 415 not JSON, 429 rate limited (with
`Retry-After`), 503 not configured, closed or inbox full.

## Limits and costs

- **Per doodle:** at most 200 KB. Typical sketches are 20–80 KB; a densely
  coloured one is sent at 480x320 instead of 960x640 to stay under the cap.
- **Per-IP limits (best effort):** 3 submissions per 10 minutes and 12 per day;
  10 wrong admin tokens per 15 minutes. Counters live in one function
  instance's memory: they reset on cold starts and aren't shared between
  instances or regions, so a determined spammer rotating IPs isn't stopped by
  them. The WAF rule above and the pending cap are the real backstops.
- **Pending cap:** 100 by default. While the inbox is full, submissions are
  refused without touching Blob. The count is cached per instance for 10
  minutes, so the cap can be overshot slightly.
- **Vercel Blob on Hobby**
  ([pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)): free
  within 1 GB storage, 10,000 simple operations, 2,000 advanced operations and
  10 GB data transfer per month. Over the limit you aren't charged, but Blob is
  blocked for 30 days, which takes the wall down. What this feature uses:
  - Submit: 2 uploads (advanced), plus at most one listing per instance every
    10 minutes for the pending cap.
  - Approve: 1 copy + 1 index write (advanced) and 2 reads. Reject and remove:
    deletes are free.
  - Public wall: one cached read of the index per function call; with the CDN
    caching the response, that's at most about one call per minute per region.
  - Images: one function call and blob read per image per CDN region per day.
  - Browsing the store in the Vercel dashboard also counts as operations.

  So the advanced-operation allowance covers about 500 submitted-and-approved
  doodles a month (or about 1,000 rejected ones), and 1 GB holds well over
  10,000 typical doodles.
- **Functions:** every uncached request is a function invocation, a small
  fraction of Hobby's included usage for a personal guestbook
  ([limits](https://vercel.com/docs/limits)).
