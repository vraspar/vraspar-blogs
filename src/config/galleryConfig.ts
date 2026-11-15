import type { GalleryConfig } from "@/types/galleryConfig";

// 相册配置
export const galleryConfig: GalleryConfig = {
	// 相册列表
	albums: [
		// Add an album here and put its photos in public/gallery/<id>/, e.g.
		// { id: "toronto", name: "Toronto", description: "", location: "Toronto, ON", date: "2026-11-01", tags: [] },
		// Photos are WebP with all metadata (GPS, dates, camera) stripped.
		{
			id: "sketches",
			name: "Sketches",
			description: "Sticky notes, notebook pages, an iPad and one canvas.",
		},
	],

	// 瀑布流最小列宽(px)，浏览器根据容器宽度自动计算列数，默认 240
	// 值越小列数越多，值越大列数越少
	columnWidth: 240,
};
