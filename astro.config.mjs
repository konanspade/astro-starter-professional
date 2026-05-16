import "dotenv/config";
import { defineConfig, passthroughImageService } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
// Fallback for CI when PUBLIC_SITE_URL is not set (e.g. forks, PRs)
const siteUrl = process.env.PUBLIC_SITE_URL || "https://example.com";
export default defineConfig({
	site: siteUrl,
	output: "static", // Changed from server to static for build-time rendering
	devToolbar: { enabled: false },
	integrations: [
		sitemap({
			filter: (page) => !page.includes("/success") && !page.includes("/404"),
		}),
	],
	vite: {
		plugins: [tailwindcss()],
		server: {
			allowedHosts: true,
		},
		build: {
			chunkSizeWarningLimit: 1000,
		},
		ssr: {
			noExternal: ["react-icons"],
		},
		css: {
			devSourcemap: true,
		},
	},
	// View Transitions disabled — added per-page setup cost we don't need
	// for a marketing site, and can be re-added selectively per template
	// when the new design lands.
	// Pass remote images straight through — WP serves featured images via
	// LiteSpeed (already CDN-cacheable) and Cloudflare can rewrite/resize on
	// the way out. Avoids Astro re-fetching + re-encoding every WP image at
	// build time, which dominated total build time for 448 pages.
	image: {
		domains: [],
		remotePatterns: [{ protocol: "https" }],
		service: passthroughImageService(),
	},
});
