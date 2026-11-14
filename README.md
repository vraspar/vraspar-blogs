# vraspar-blogs

Source for [vrajang.com](https://www.vrajang.com) and [vraspar.com](https://www.vraspar.com).

Built with [Astro](https://astro.build) on the [Firefly](https://github.com/CuteLeaf/Firefly) theme (imported from `CuteLeaf/Firefly@994c0b8`). The previous Fuwari version of the site is tagged `fuwari-2024`.

## Common tasks

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Local dev server at `localhost:4321` |
| `pnpm build` | Production build into `./dist/` |
| `pnpm new-post <filename>` | Start a new post in `src/content/posts/` |

Site settings live in `src/config/` (`siteConfig.ts`, `profileConfig.ts`, `musicConfig.ts`, `galleryConfig.ts`, ...).

- **Music:** put MP3s in `public/assets/music/` and list them in `src/config/musicConfig.ts`.
- **Photos:** add an album to `src/config/galleryConfig.ts` and drop its photos in `public/gallery/<album-id>/`.
