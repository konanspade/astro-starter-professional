/**
 * SEO resolution chain.
 *
 * Single source of truth for `<head>` metadata across the site. The
 * homepage and any high-stakes landing page can pass code-level
 * overrides; everything else reads Rank Math meta from WP via REST,
 * with a graceful fallback to WP post title + site description.
 *
 * Resolution order (highest authority wins, fields cascade individually):
 *   1. Code overrides (Astro props)
 *   2. Platform (app.konanspade.com) — stub until a real endpoint exists
 *   3. Rank Math meta (per-post WP overrides, exposed by the
 *      konanspade-helper Rank_Math_Bridge_Module via standard WP REST)
 *   4. Fallback (WP post title + site description)
 *
 * All fetching happens at build time. The Rank Math REST endpoint
 * requires authentication — we use the same WP_APP_USERNAME /
 * WP_APP_PASSWORD that lib/api.ts reads.
 */

const WP_BASE = (() => {
	const apiUrl = import.meta.env.WORDPRESS_API_URL;
	if (!apiUrl) return null;
	return new URL("/", apiUrl).toString().replace(/\/$/, "");
})();

const WP_USER = import.meta.env.WP_APP_USERNAME;
const WP_PASS = import.meta.env.WP_APP_PASSWORD;
const WP_AUTH =
	WP_USER && WP_PASS
		? `Basic ${Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")}`
		: null;

// Optional platform endpoint. Absent today; reserved.
const PLATFORM_SEO_API_URL = import.meta.env.PLATFORM_SEO_API_URL || null;

export type SEOData = {
	title?: string;
	description?: string;
	canonical?: string;
	robots?: string[];
	ogTitle?: string;
	ogDescription?: string;
	ogImage?: string;
	twitterTitle?: string;
	twitterDescription?: string;
	twitterImage?: string;
	twitterCard?: "summary" | "summary_large_image";
	focusKeyword?: string;
	source?: "code" | "rankmath" | "platform" | "fallback";
};

export type ResolveSEOInput = {
	/** WP post ID — when present we hit Rank Math directly. */
	postId?: number;
	/** WP post type slug for the REST path (`posts`, `pages`, `products`, `solution`, `suitable_sectors`). */
	postType?: string;
	/** URI for cache key + future platform lookup. */
	uri?: string;
	/** Code-level overrides — highest authority. */
	codeOverrides?: Partial<SEOData>;
	/** Final fallback when nothing else resolves. */
	fallback: { title: string; description: string };
};

/**
 * Map WP REST `meta` payload (rank_math_* keys) → our normalised shape.
 * Only fields we actually render are pulled through.
 */
function fromRankMath(meta: Record<string, unknown> | null | undefined): Partial<SEOData> {
	if (!meta || typeof meta !== "object") return {};
	const m = meta as Record<string, unknown>;
	const str = (k: string): string | undefined => {
		const v = m[k];
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	};
	const arr = (k: string): string[] | undefined => {
		const v = m[k];
		return Array.isArray(v) && v.length
			? v.filter((x) => typeof x === "string")
			: undefined;
	};
	const out: Partial<SEOData> = {
		title: str("rank_math_title"),
		description: str("rank_math_description"),
		canonical: str("rank_math_canonical_url"),
		robots: arr("rank_math_robots"),
		ogTitle: str("rank_math_facebook_title"),
		ogDescription: str("rank_math_facebook_description"),
		ogImage: str("rank_math_facebook_image"),
		twitterTitle: str("rank_math_twitter_title"),
		twitterDescription: str("rank_math_twitter_description"),
		twitterImage: str("rank_math_twitter_image"),
		focusKeyword: str("rank_math_focus_keyword"),
	};
	const card = str("rank_math_twitter_card_type");
	if (card === "summary" || card === "summary_large_image") {
		out.twitterCard = card;
	}
	// Strip undefined keys so cascading merges don't overwrite later layers.
	for (const k of Object.keys(out) as (keyof SEOData)[]) {
		if (out[k] === undefined) delete out[k];
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* RankMath fetch                                                      */
/* ------------------------------------------------------------------ */

const rankMathCache = new Map<string, Partial<SEOData>>();

// Cache key prefix for the on-disk store. We reuse build-cache.ts so
// RankMath responses survive across cold builds (CI restores
// .cache/graphql/ between runs) and per-URI invalidation flips them
// when the WP post's modifiedGmt changes.
const RANKMATH_CACHE_PREFIX = "rankmath-meta";

async function getRankMathMeta(
	postId: number,
	postType: string = "posts",
): Promise<Partial<SEOData>> {
	if (!WP_BASE || !WP_AUTH) return {};
	const cacheKey = `${postType}:${postId}`;
	if (rankMathCache.has(cacheKey)) {
		return rankMathCache.get(cacheKey) as Partial<SEOData>;
	}

	// Try disk cache first — survives across cold builds. Variables are
	// (postType, postId), keyed by build-cache's sha256 of (query+vars).
	const bc = await import("./build-cache");
	const cacheVars = { postType, postId };
	const disk = bc.readCacheEntry<Partial<SEOData>>(
		RANKMATH_CACHE_PREFIX,
		cacheVars,
	);
	if (disk) {
		rankMathCache.set(cacheKey, disk);
		return disk;
	}

	try {
		const url = `${WP_BASE}/wp-json/wp/v2/${postType}/${postId}?_fields=meta`;
		const res = await fetch(url, {
			headers: { Authorization: WP_AUTH, Accept: "application/json" },
		});
		if (!res.ok) {
			rankMathCache.set(cacheKey, {});
			bc.writeCacheEntry(RANKMATH_CACHE_PREFIX, cacheVars, {});
			return {};
		}
		const json = (await res.json()) as { meta?: Record<string, unknown> };
		const seo = fromRankMath(json.meta);
		rankMathCache.set(cacheKey, seo);
		bc.writeCacheEntry(RANKMATH_CACHE_PREFIX, cacheVars, seo);
		return seo;
	} catch {
		rankMathCache.set(cacheKey, {});
		return {};
	}
}

/* ------------------------------------------------------------------ */
/* Platform stub — wire up when app.konanspade.com exposes an endpoint */
/* ------------------------------------------------------------------ */

async function getPlatformSEO(
	uri: string | undefined,
): Promise<Partial<SEOData>> {
	if (!PLATFORM_SEO_API_URL || !uri) return {};
	// Future contract:
	//   GET ${PLATFORM_SEO_API_URL}/lookup?path=<uri>
	//   Auth: Bearer <token from PLATFORM_SEO_API_TOKEN>
	//   Response: { title, description, ogImage, ... }
	// Returns {} on any failure so the chain falls through to RankMath.
	return {};
}

/* ------------------------------------------------------------------ */
/* Resolve                                                             */
/* ------------------------------------------------------------------ */

/**
 * Merge two SEOData layers, keeping defined keys from the higher-priority
 * (left) layer and filling missing ones from the lower (right).
 */
function merge(
	high: Partial<SEOData>,
	low: Partial<SEOData>,
): Partial<SEOData> {
	const out: Partial<SEOData> = { ...low };
	for (const k of Object.keys(high) as (keyof SEOData)[]) {
		const v = high[k];
		if (v !== undefined && v !== null && v !== "") {
			(out as Record<string, unknown>)[k] = v as unknown;
		}
	}
	return out;
}

export async function resolveSEO(input: ResolveSEOInput): Promise<SEOData> {
	const { postId, postType = "posts", uri, codeOverrides = {}, fallback } = input;

	// Lower-priority fallback (always defined).
	const baseFallback: SEOData = {
		title: fallback.title,
		description: fallback.description,
		twitterCard: "summary_large_image",
		source: "fallback",
	};

	// Layer up.
	let merged: Partial<SEOData> = baseFallback;
	let source: SEOData["source"] = "fallback";

	if (postId) {
		const rm = await getRankMathMeta(postId, postType);
		if (Object.keys(rm).length > 0) {
			merged = merge(rm, merged);
			source = "rankmath";
		}
	}

	const platform = await getPlatformSEO(uri);
	if (Object.keys(platform).length > 0) {
		merged = merge(platform, merged);
		source = "platform";
	}

	if (Object.keys(codeOverrides).length > 0) {
		merged = merge(codeOverrides, merged);
		source = "code";
	}

	return { ...(merged as SEOData), source };
}
