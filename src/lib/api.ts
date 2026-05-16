/**
 * WordPress GraphQL API client
 * Provides functions for fetching data from WordPress via GraphQL
 */
import { DEFAULT_APP_NAME, DEFAULT_APP_DESCRIPTION, log } from "./constants";

// Type definitions for GraphQL responses
interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

interface GraphQLErrorObject {
	message: string;
	locations?: { line: number; column: number }[];
	path?: string[];
}

interface GraphQLResponse<T> {
	data: T;
	errors?: GraphQLErrorObject[];
}

interface FetchOptions extends RequestInit {
	cache?: "force-cache" | "no-store" | "reload" | "no-cache" | "default";
}

// WordPress types
interface MediaNode {
	mediaItemUrl: string;
	altText: string;
}

interface CategoryNode {
	name: string;
	uri: string;
}

interface PostNode {
	id: string;
	postId?: number;
	title: string;
	date: string;
	dateGmt: string;
	modified: string;
	modifiedGmt: string;
	uri: string;
	link?: string;
	guid?: string;
	excerpt: string;
	content: string;
	categories?: {
		nodes: CategoryNode[];
	};
	featuredImage?: {
		node: MediaNode;
	};
	next?: {
		id: string;
		title: string;
		uri: string;
	} | null;
	previous?: {
		id: string;
		title: string;
		uri: string;
	} | null;
}

interface PageNode {
	id: string;
	title: string;
	slug: string;
	uri: string;
	date: string;
	content: string;
	featuredImage?: {
		node: MediaNode;
	};
}

interface CategoryPageNode {
	id: string;
	name: string;
	slug: string;
	posts: {
		nodes: PostNode[];
	};
	featuredImage?: {
		node: MediaNode;
	};
}

interface TagNode {
	id: string;
	name: string;
	slug: string;
	posts: {
		nodes: PostNode[];
	};
	featuredImage?: {
		node: MediaNode;
	};
}

interface MenuItemNode {
	uri: string;
	url: string;
	order: number;
	label: string;
}

interface MenuNode {
	name: string;
	menuItems: {
		nodes: MenuItemNode[];
	};
}

interface PageInfo {
	total: number;
	hasNextPage: boolean;
	hasPreviousPage?: boolean;
	endCursor?: string;
}

interface NodeByUriResponse {
	nodeByUri:
		| ({ __typename: "Post" } & PostNode)
		| ({ __typename: "Page" } & PageNode)
		| ({ __typename: "Category" } & CategoryPageNode)
		| ({ __typename: "Tag" } & TagNode)
		| null;
}

/** Terms + categories only (used for first part of getAllUris) */
interface TermsCategoriesUrisResponse {
	terms: { nodes: { uri: string }[] };
	categories: { nodes: { uri: string }[] };
}

/** One page of posts/pages with cursor info */
interface UriPageResponse {
	nodes: { uri: string }[];
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface UriParams {
	params: {
		uri: string;
	};
}

export interface SettingsResponse {
	generalSettings: {
		title: string;
		url: string;
		description: string;
	};
	allSettings: {
		readingSettingsPostsPerPage: number;
	};
}

/** Result of settingsQuery (data + whether fallback or stale cache was used) */
export interface SettingsQueryResult {
	data: SettingsResponse;
	fromFallback: boolean;
}

/** Result of navQuery (data + whether fallback or stale cache was used) */
export interface NavQueryResult {
	data: MenusResponse;
	fromFallback: boolean;
}

export interface MenusResponse {
	menus: {
		nodes: MenuNode[];
	};
}

interface PostsResponse {
	posts: {
		edges: {
			node: PostNode;
		}[];
		pageInfo: PageInfo;
	};
}

interface CategoryPostsResponse {
	category: {
		name: string;
		slug: string;
		posts: {
			edges: {
				node: PostNode;
			}[];
			pageInfo: PageInfo;
		};
	};
}

/**
 * Local storage cache for GraphQL responses
 * Simple in-memory cache implementation to reduce duplicate API calls
 */
const queryCache = new Map<string, CacheEntry<unknown>>();

/**
 * Cache duration in milliseconds
 * - 30 minutes for build-time operations
 * - 5 minutes for runtime operations
 */
const RUNTIME_CACHE_DURATION = 5 * 60 * 1000;
const BUILD_CACHE_DURATION = 30 * 60 * 1000;

/** Default request timeout in ms (prevents builds hanging on slow/unresponsive WordPress) */
const API_FETCH_TIMEOUT_MS = 30_000;

/** Number of retries for transient failures (5xx or network errors) */
const API_FETCH_RETRIES = 3;

/** Initial backoff in ms; doubles each retry */
const API_FETCH_RETRY_INITIAL_MS = 1_000;

// Determine if we're in a build context
const IS_BUILD_CONTEXT =
	typeof process !== "undefined" && process.env.NODE_ENV === "production";
const CACHE_DURATION = IS_BUILD_CONTEXT
	? BUILD_CACHE_DURATION
	: RUNTIME_CACHE_DURATION;

// Persistent build-time cache: GraphQL responses are written to .cache/graphql/
// so subsequent CI builds reuse them. A pre-flight inventory query (below)
// invalidates only entries whose URI's modifiedGmt has changed.
// See src/lib/build-cache.ts for storage details.
const ENABLE_BUILD_CACHE = typeof window === "undefined";
let inventoryPromise: Promise<void> | null = null;

const INVENTORY_QUERY = `query CacheInventory {
  contentNodes(first: 10000) {
    nodes { uri modifiedGmt }
  }
}`;

async function rawGraphQL<T>(
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(import.meta.env.WORDPRESS_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	if (!response.ok) {
		throw new Error(`GraphQL HTTP ${response.status}`);
	}
	const json = (await response.json()) as {
		data: T;
		errors?: { message: string }[];
	};
	if (json.errors?.length) {
		throw new Error(
			`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
		);
	}
	return json.data;
}

async function runInventoryAndInvalidate(): Promise<void> {
	const bc = await import("./build-cache");
	type InventoryResp = {
		contentNodes: { nodes: { uri: string; modifiedGmt: string }[] };
	};
	const fresh = await rawGraphQL<InventoryResp>(INVENTORY_QUERY, {});
	const currentNodes = fresh.contentNodes?.nodes ?? [];
	const cachedNodes = bc.readInventory();
	if (!cachedNodes) {
		bc.writeInventory(currentNodes);
		log.info(
			`[build-cache] First run; cataloged ${currentNodes.length} URIs`,
		);
		return;
	}
	const cachedMap = new Map(cachedNodes.map((n) => [n.uri, n.modifiedGmt]));
	const currentMap = new Map(currentNodes.map((n) => [n.uri, n.modifiedGmt]));
	const changed = new Set<string>();
	for (const [uri, mod] of currentMap) {
		if (cachedMap.get(uri) !== mod) changed.add(uri);
	}
	for (const uri of cachedMap.keys()) {
		if (!currentMap.has(uri)) changed.add(uri);
	}
	if (changed.size > 0) {
		const { perUriDeleted, listDeleted } = bc.invalidateBy(changed, true);
		log.info(
			`[build-cache] ${changed.size} URI(s) changed; invalidated ${perUriDeleted} per-URI + ${listDeleted} list entries`,
		);
	} else {
		log.info(
			`[build-cache] No content changes — full cache reuse (${currentNodes.length} URIs)`,
		);
	}
	bc.writeInventory(currentNodes);
}

async function ensureInventoryReady(): Promise<void> {
	if (!ENABLE_BUILD_CACHE) return;
	if (!inventoryPromise) {
		inventoryPromise = runInventoryAndInvalidate().catch((err) => {
			log.warn(
				`[build-cache] Pre-flight failed; proceeding without invalidation: ${(err as Error).message}`,
			);
		});
	}
	await inventoryPromise;
}

// Batched node pre-fetch: when getStaticPaths returns N URIs, kick off a
// background pre-fetch that batches them into groups of PREFETCH_BATCH_SIZE
// using aliased nodeByUri queries (one HTTP round-trip per batch instead of
// one per page). getNodeByURI awaits the prefetch and reads the result from
// memory. Cuts a 448-page build from ~14 min of fetches to ~30s.
const PREFETCH_BATCH_SIZE = 25;
const NODE_BY_URI_INNER = `
  __typename
  ... on Post {
    id
    postId
    databaseId
    title
    date
    dateGmt
    modified
    modifiedGmt
    uri
    link
    guid
    excerpt
    content
    categories { nodes { name uri } }
    featuredImage { node { mediaItemUrl altText } }
  }
  ... on Page {
    id
    databaseId
    title
    slug
    uri
    date
    content
    featuredImage { node { mediaItemUrl altText } }
  }
`;
const NODE_BY_URI_QUERY = `query GetNodeByURI($uri: String!) {
  nodeByUri(uri: $uri) { ${NODE_BY_URI_INNER} }
}`;

type NodeByUri = NodeByUriResponse["nodeByUri"];
const prefetchedNodes = new Map<string, NodeByUri>();
let prefetchPromise: Promise<void> | null = null;

function normalizeUri(uri: string): string {
	let s = uri || "/";
	if (!s.startsWith("/")) s = "/" + s;
	if (!s.endsWith("/")) s = s + "/";
	return s;
}

async function prefetchNodes(uris: string[]): Promise<void> {
	if (!ENABLE_BUILD_CACHE) return;
	const bc = await import("./build-cache");
	const normalized = uris.map(normalizeUri);

	// Skip URIs that already have a fresh disk-cache entry from a prior build.
	const need: string[] = [];
	let preHit = 0;
	for (const uri of normalized) {
		const cached = bc.readCacheEntry<NodeByUriResponse>(NODE_BY_URI_QUERY, {
			uri,
		});
		if (cached?.nodeByUri) {
			prefetchedNodes.set(uri, cached.nodeByUri);
			preHit++;
		} else {
			need.push(uri);
		}
	}
	log.info(
		`[prefetch] ${need.length} URIs to fetch, ${preHit} already cached on disk (total ${normalized.length})`,
	);

	const totalBatches = Math.ceil(need.length / PREFETCH_BATCH_SIZE);
	for (let i = 0; i < need.length; i += PREFETCH_BATCH_SIZE) {
		const batch = need.slice(i, i + PREFETCH_BATCH_SIZE);
		const batchNum = Math.floor(i / PREFETCH_BATCH_SIZE) + 1;
		const aliases = batch
			.map(
				(uri, idx) =>
					`q${idx}: nodeByUri(uri: "${uri.replace(/"/g, '\\"')}") { ${NODE_BY_URI_INNER} }`,
			)
			.join("\n");
		const batchedQuery = `query BatchedNodes {\n${aliases}\n}`;
		const t0 = Date.now();
		try {
			const data = await rawGraphQL<Record<string, NodeByUri>>(
				batchedQuery,
				{},
			);
			let ok = 0;
			batch.forEach((uri, idx) => {
				const node = data[`q${idx}`];
				if (node) {
					prefetchedNodes.set(uri, node);
					bc.writeCacheEntry(NODE_BY_URI_QUERY, { uri }, { nodeByUri: node });
					ok++;
				}
			});
			log.info(
				`[prefetch] batch ${batchNum}/${totalBatches}: ${ok}/${batch.length} nodes in ${Date.now() - t0}ms`,
			);
		} catch (err) {
			log.warn(
				`[prefetch] batch ${batchNum}/${totalBatches} failed (${(err as Error).message}); pages will fall back to per-URI fetch`,
			);
		}
	}
}

function ensurePrefetch(uris: string[]): void {
	if (!ENABLE_BUILD_CACHE) return;
	if (prefetchPromise) return;
	prefetchPromise = prefetchNodes(uris).catch((err) => {
		log.warn(`[prefetch] aborted: ${(err as Error).message}`);
	});
}

/**
 * Execute a GraphQL query with caching
 * Leverages Astro's built-in fetch with caching when available
 */
async function executeQuery<T>(
	query: string,
	variables: Record<string, unknown> = {},
	cacheKey: string = "",
	bypassCache: boolean = false,
): Promise<T> {
	// Generate a cache key if not provided
	const finalCacheKey = cacheKey || `${query}${JSON.stringify(variables)}`;

	log.debug(
		`executeQuery called for ${cacheKey} (bypass cache: ${bypassCache})`,
	);

	// Check cache if not bypassing
	if (!bypassCache && queryCache.has(finalCacheKey)) {
		const { data, timestamp } = queryCache.get(finalCacheKey) as CacheEntry<T>;
		// Use cache if it's not expired
		if (Date.now() - timestamp < CACHE_DURATION) {
			log.debug(
				`Using cached data for ${cacheKey}, age: ${(Date.now() - timestamp) / 1000}s`,
			);
			return data;
		}
		// Remove expired cache entry
		log.debug(`Cache expired for ${cacheKey}, fetching fresh data`);
		queryCache.delete(finalCacheKey);
	}

	// Persistent disk cache — only at build time, after pre-flight invalidation.
	if (ENABLE_BUILD_CACHE && !bypassCache) {
		await ensureInventoryReady();
		const bc = await import("./build-cache");
		const cached = bc.readCacheEntry<T>(query, variables);
		if (cached !== null) {
			queryCache.set(finalCacheKey, { data: cached, timestamp: Date.now() });
			log.debug(`[build-cache] disk hit for ${cacheKey}`);
			return cached;
		}
	}

	try {
		// Prepare headers with authentication
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};

		log.debug("Preparing authentication headers...");

		// Add authentication if environment variables are set.
		// Never log WP_APP_PASSWORD, REVALIDATE_TOKEN, WP_JWT_TOKEN, WP_AUTH_NONCE or other secrets.
		// Method 1: Application Password (WordPress 5.6+)
		if (import.meta.env.WP_APP_USERNAME && import.meta.env.WP_APP_PASSWORD) {
			try {
				log.debug("Using Basic Auth for API request");
				// Use browser's btoa for compatibility
				const auth =
					typeof btoa === "function"
						? btoa(
								`${import.meta.env.WP_APP_USERNAME}:${import.meta.env.WP_APP_PASSWORD}`,
							)
						: Buffer.from(
								`${import.meta.env.WP_APP_USERNAME}:${import.meta.env.WP_APP_PASSWORD}`,
							).toString("base64");

				headers["Authorization"] = `Basic ${auth}`;
				log.debug("Added Basic Auth header for API request");
			} catch (e) {
				log.error(`Error creating Basic Auth header: ${e}`);
			}
		} else if (import.meta.env.WP_JWT_TOKEN) {
			// Method 2: JWT Authentication if using a JWT plugin
			headers["Authorization"] = `Bearer ${import.meta.env.WP_JWT_TOKEN}`;
			log.debug("Added JWT Auth header for API request");
		} else if (import.meta.env.WP_AUTH_NONCE) {
			// Method 3: WPGraphQL Authentication plugin (nonce-based)
			headers["X-WP-Nonce"] = import.meta.env.WP_AUTH_NONCE;
			log.debug("Added WP Nonce header for API request");
		} else {
			log.debug("No auth credentials found in environment variables");
		}

		const fetchOptions: FetchOptions = {
			method: "post",
			headers,
			body: JSON.stringify({
				query,
				variables,
			}),
		};

		// Add cache options if in Astro SSG/SSR context (not in browser)
		// Since we can't directly check for Astro, check if we're in a browser context
		if (typeof window === "undefined") {
			fetchOptions.cache = bypassCache ? "no-store" : "force-cache";
			log.debug(`Using fetch cache policy: ${fetchOptions.cache}`);
		} else {
			log.debug("Running in browser context, not setting fetch cache policy");
		}

		log.debug(
			`Fetching from WordPress API URL: ${import.meta.env.WORDPRESS_API_URL}`,
		);
		log.debug(
			"Headers: " +
				Object.fromEntries(
					Object.entries(headers).map(([k, v]) =>
						k === "Authorization" ? [k, "Basic ***"] : [k, v],
					),
				),
		);
		log.debug("Request body length: " + fetchOptions.body?.toString().length);

		const sleep = (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms));

		let lastError: unknown;
		for (let attempt = 0; attempt <= API_FETCH_RETRIES; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				API_FETCH_TIMEOUT_MS,
			);
			const requestOptions: RequestInit = {
				...fetchOptions,
				signal: controller.signal,
			};

			try {
				log.debug(
					`Sending fetch request...${attempt > 0 ? ` (retry ${attempt}/${API_FETCH_RETRIES})` : ""}`,
				);
				const response = await fetch(
					import.meta.env.WORDPRESS_API_URL,
					requestOptions,
				);
				clearTimeout(timeoutId);

				log.debug(`Response status: ${response.status} ${response.statusText}`);
				log.debug(
					"Response headers:",
					Object.fromEntries([...response.headers.entries()]),
				);

				if (!response.ok) {
					const errorText = await response.text();
					log.error(`Error response body: ${errorText}`);
					const err = new Error(
						`GraphQL request failed: ${response.status} ${response.statusText}`,
					);
					if (response.status >= 500 && attempt < API_FETCH_RETRIES) {
						const backoff = API_FETCH_RETRY_INITIAL_MS * Math.pow(2, attempt);
						log.debug(
							`Server error ${response.status}, retrying in ${backoff}ms...`,
						);
						lastError = err;
						await sleep(backoff);
						continue;
					}
					throw err;
				}

				log.debug("Response OK, parsing JSON...");
				const result = (await response.json()) as GraphQLResponse<T>;

				if (result.errors && result.errors.length) {
					log.error(
						`GraphQL result contains errors: ${JSON.stringify(result.errors)}`,
					);
					throw new Error(
						`GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`,
					);
				}

				log.debug("GraphQL query successful");

				queryCache.set(finalCacheKey, {
					data: result.data,
					timestamp: Date.now(),
				});

				if (ENABLE_BUILD_CACHE) {
					const bc = await import("./build-cache");
					bc.writeCacheEntry(query, variables, result.data);
				}

				return result.data;
			} catch (fetchError) {
				clearTimeout(timeoutId);
				const isAbort =
					(fetchError as { name?: string })?.name === "AbortError";
				const isNetwork =
					fetchError instanceof TypeError &&
					((fetchError as Error).message === "fetch failed" ||
						(fetchError as { cause?: { code?: string } })?.cause?.code ===
							"ECONNREFUSED");
				const retryable = (isAbort || isNetwork) && attempt < API_FETCH_RETRIES;
				if (retryable) {
					const backoff = API_FETCH_RETRY_INITIAL_MS * Math.pow(2, attempt);
					log.debug(
						`Request failed (${isAbort ? "timeout" : "network"}), retrying in ${backoff}ms...`,
					);
					lastError = fetchError;
					await sleep(backoff);
					continue;
				}
				log.error(`Fetch operation failed: ${fetchError}`);
				throw fetchError;
			}
		}
		log.error(`Fetch operation failed after retries: ${lastError}`);
		throw lastError;
	} catch (error) {
		log.error(`GraphQL query error: ${error}`);
		throw error;
	}
}

const SETTINGS_CACHE_KEY = "settings";
const NAV_CACHE_KEY = "navigation";

const SETTINGS_FALLBACK: SettingsResponse = {
	generalSettings: {
		title: DEFAULT_APP_NAME,
		url: import.meta.env.PUBLIC_SITE_URL || "https://example.com",
		description: DEFAULT_APP_DESCRIPTION,
	},
	allSettings: {
		readingSettingsPostsPerPage: 10,
	},
};

const NAV_FALLBACK: MenusResponse = {
	menus: {
		nodes: [
			{
				name: "Primary",
				menuItems: {
					nodes: [
						{ uri: "/", url: "/", order: 1, label: "Home" },
						{ uri: "/about/", url: "/about/", order: 2, label: "About" },
						{
							uri: "/contact/",
							url: "/contact/",
							order: 3,
							label: "Contact",
						},
					],
				},
			},
		],
	},
};

/**
 * Get site settings from WordPress.
 * On failure, returns stale data from cache if available (stale-while-revalidate), else static fallback.
 */
export async function settingsQuery(): Promise<SettingsQueryResult> {
	try {
		const data = await executeQuery<SettingsResponse>(
			`{
      generalSettings { title url description }
      allSettings { readingSettingsPostsPerPage }
    }`,
			{},
			SETTINGS_CACHE_KEY,
		);
		return { data, fromFallback: false };
	} catch (error) {
		log.error(`Error fetching settings: ${error}`);
		const cached = queryCache.get(SETTINGS_CACHE_KEY) as
			| CacheEntry<SettingsResponse>
			| undefined;
		if (cached?.data) {
			return { data: cached.data, fromFallback: false };
		}
		// Cache the fallback so we don't retry the failing query 5x per page
		queryCache.set(SETTINGS_CACHE_KEY, {
			data: SETTINGS_FALLBACK,
			timestamp: Date.now(),
		});
		return { data: SETTINGS_FALLBACK, fromFallback: true };
	}
}

/**
 * Get navigation menu from WordPress.
 * On failure, returns stale data from cache if available, else static fallback.
 */
export async function navQuery(): Promise<NavQueryResult> {
	try {
		const data = await executeQuery<MenusResponse>(
			`{
      menus(where: {location: PRIMARY}) {
        nodes {
          name
          menuItems { nodes { uri url order label } }
        }
      }
    }`,
			{},
			NAV_CACHE_KEY,
		);
		return { data, fromFallback: false };
	} catch (error) {
		log.error(`Error fetching nav: ${error}`);
		const cached = queryCache.get(NAV_CACHE_KEY) as
			| CacheEntry<MenusResponse>
			| undefined;
		if (cached?.data) {
			return { data: cached.data, fromFallback: false };
		}
		// Cache the fallback so subsequent components on this and later pages
		// don't re-issue the failing query (was 3+ network round trips per page).
		queryCache.set(NAV_CACHE_KEY, {
			data: NAV_FALLBACK,
			timestamp: Date.now(),
		});
		return { data: NAV_FALLBACK, fromFallback: true };
	}
}

/**
 * Get posts from WordPress with pagination support
 *
 * @requires WPGraphQL Offset Pagination plugin (https://github.com/valu-digital/wp-graphql-offset-pagination)
 * This function uses the offsetPagination argument which requires the plugin to be installed on WordPress.
 */
export async function getPosts(
	$first: number = 20,
	$page: number = 1,
): Promise<PostsResponse> {
	try {
		// Calculate offset for pagination
		const $offset = ($page - 1) * $first;

		const query = `query GET_POSTS($first: Int, $offset: Int) {
      posts(where: { offsetPagination: { offset: $offset, size: $first } }) {
        edges {
          node {
            id
            title
            date
            dateGmt
            modified
            modifiedGmt
            uri
            excerpt
            content
            categories {
              nodes {
                name
                uri
              }
            }
            featuredImage {
              node {
                mediaItemUrl
                altText
              }
            }
          }
        }
        pageInfo {
          total
          hasNextPage
          endCursor
        }
      }
    }`;

		// Use a cache key that includes pagination parameters
		const cacheKey = `posts-${$first}-${$page}`;

		// Pass both first and offset for proper pagination
		return await executeQuery<PostsResponse>(
			query,
			{ first: $first, offset: $offset },
			cacheKey,
		);
	} catch (error) {
		log.error(`Error fetching posts: ${error}`);
		// Return fallback data for development
		return {
			posts: {
				edges: [
					{
						node: {
							id: "post-1",
							title: "Example Post 1",
							date: new Date().toISOString(),
							dateGmt: new Date().toISOString(),
							modified: new Date().toISOString(),
							modifiedGmt: new Date().toISOString(),
							uri: "/example-post-1/",
							excerpt: "<p>This is a sample post excerpt.</p>",
							content: "<p>This is sample post content.</p>",
							categories: {
								nodes: [{ name: "Sample Category", uri: "/category/sample/" }],
							},
							featuredImage: {
								node: {
									mediaItemUrl: "/logo.svg",
									altText: "Example image",
								},
							},
						},
					},
				],
				pageInfo: {
					total: 1,
					hasNextPage: false,
					endCursor: "",
				},
			},
		};
	}
}

/**
 * Get posts by category from WordPress with pagination support
 *
 * Uses standard WPGraphQL cursor-based pagination
 */
export async function getPostsByCategory(
	$category: string,
	$first: number = 20,
	$page: number = 1,
): Promise<CategoryPostsResponse> {
	try {
		// Calculate cursor for pagination if not on first page
		// We'll fetch the cursor in a separate query if needed
		let afterCursor = null;

		// If we're requesting beyond the first page, we need to get the cursor
		if ($page > 1) {
			// First get the cursor at the position we need
			const cursorIndex = ($page - 1) * $first - 1; // Position of the last item on the previous page

			// Get the cursor for pagination
			const cursorQuery = `query GET_CURSOR($category: ID!) {
        category(id: $category, idType: SLUG) {
          posts(first: ${cursorIndex + 1}) {
            edges {
              cursor
            }
          }
        }
      }`;

			try {
				const cursorData = await executeQuery(
					cursorQuery,
					{ category: $category },
					`cursor-${$category}-${cursorIndex}`,
				);

				// Get the last cursor
				if (cursorData?.category?.posts?.edges?.[cursorIndex]) {
					afterCursor = cursorData.category.posts.edges[cursorIndex].cursor;
					log.debug(`Using cursor for page ${$page}: ${afterCursor}`);
				}
			} catch (cursorError) {
				log.error(`Error getting cursor for pagination: ${cursorError}`);
				// If we fail to get the cursor, we'll just try to get the first page
			}
		}

		// Build our main query, using the cursor if we have one
		const query = `query GET_POSTS_BY_CATEGORY($category: ID!, $first: Int, $after: String) {
      category(id: $category, idType: SLUG) {
        name
        slug
        posts(first: $first, after: $after) {
          edges {
            node {
              id
              postId
              title
              date
              dateGmt
              modified
              modifiedGmt
              uri
              link
              guid
              excerpt
              content
              featuredImage {
                node {
                  mediaItemUrl
                  altText
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            total
          }
        }
      }
    }`;

		// Use a cache key that includes category and pagination parameters
		const cacheKey = `category-${$category}-${$first}-${$page}`;

		return await executeQuery<CategoryPostsResponse>(
			query,
			{
				category: $category,
				first: $first,
				after: afterCursor,
			},
			cacheKey,
		);
	} catch (error) {
		log.error(`Error fetching posts for category ${$category}: ` + error);
		// Return fallback data for development
		return {
			category: {
				name: $category.charAt(0).toUpperCase() + $category.slice(1),
				slug: $category,
				posts: {
					edges: [
						{
							node: {
								id: "post-1",
								postId: 1,
								title: `Example Post in ${$category}`,
								date: new Date().toISOString(),
								dateGmt: new Date().toISOString(),
								modified: new Date().toISOString(),
								modifiedGmt: new Date().toISOString(),
								uri: "/example-category-post/",
								link: "/example-category-post/",
								guid: "https://example.com/example-category-post/",
								excerpt: "<p>This is a sample post excerpt in a category.</p>",
								content: "<p>This is sample post content in a category.</p>",
								featuredImage: {
									node: {
										mediaItemUrl: "/logo.svg",
										altText: "Example image",
									},
								},
							},
						},
					],
					pageInfo: {
						hasNextPage: false,
						hasPreviousPage: false,
						total: 1,
					},
				},
			},
		};
	}
}

/**
 * Get a node by its URI from WordPress
 */
export async function getNodeByURI(uri: string): Promise<NodeByUriResponse> {
	try {
		// Build context: wait for the batched pre-fetch (kicked off by getAllUris)
		// and serve from in-memory map. Saves hundreds of round-trips per build.
		const normalized = normalizeUri(uri);
		if (prefetchPromise) {
			await prefetchPromise;
			const cached = prefetchedNodes.get(normalized);
			if (cached) {
				return { nodeByUri: cached };
			}
		}

		// Fall through: single-URI fetch (only hit when prefetch missed, e.g. for
		// content added between inventory pre-flight and now, or in dev mode).
		const bypassCache = true;
		return await executeQuery<NodeByUriResponse>(
			NODE_BY_URI_QUERY,
			{ uri },
			`uri-${uri}`,
			bypassCache,
		);
	} catch (error) {
		log.error(`Error fetching node by URI ${uri}: ` + error);
		// Return fallback data for development
		return {
			nodeByUri: {
				__typename: "Post",
				id: "post-fallback",
				postId: 999,
				title: "Fallback Post",
				date: new Date().toISOString(),
				dateGmt: new Date().toISOString(),
				modified: new Date().toISOString(),
				modifiedGmt: new Date().toISOString(),
				uri: uri,
				link: uri,
				guid: `https://example.com${uri}`,
				excerpt: "<p>This is a fallback post excerpt.</p>",
				content: "<p>This is fallback post content.</p>",
				categories: {
					nodes: [{ name: "Fallback Category", uri: "/category/fallback/" }],
				},
				featuredImage: {
					node: {
						mediaItemUrl: "/logo.svg",
						altText: "Fallback image",
					},
				},
				next: null,
				previous: null,
			},
		};
	}
}

const ALL_URIS_PAGE_SIZE = 100;
const ALL_URIS_MERGED_CACHE_KEY = "all-uris-merged";

function uriNodeToParams(node: { uri: string | null }): UriParams | null {
	// Drafts, templates, and some taxonomy edge-cases come back with a null
	// uri — skip them rather than crash the entire static-paths build.
	if (!node.uri || node.uri === "/") return null;
	let trimmedURI = node.uri.substring(1);
	if (trimmedURI.endsWith("/")) {
		trimmedURI = trimmedURI.substring(0, trimmedURI.length - 1);
	}
	return { params: { uri: trimmedURI } };
}

/**
 * Get all URIs from WordPress for static path generation.
 * Uses cursor-based pagination for posts and pages so sites with >1000 items are fully covered.
 */
export async function getAllUris(): Promise<UriParams[]> {
	try {
		if (queryCache.has(ALL_URIS_MERGED_CACHE_KEY)) {
			const entry = queryCache.get(ALL_URIS_MERGED_CACHE_KEY) as
				| CacheEntry<UriParams[]>
				| undefined;
			if (entry && Date.now() - entry.timestamp < CACHE_DURATION) {
				log.debug("Returning cached merged URIs");
				return entry.data;
			}
		}

		// contentNodes covers posts + pages + every CPT exposed to WPGraphQL
		// (products, suitable_sectors, solution, etc) in one paginated stream.
		// Category and tag archive URIs are intentionally NOT included — the
		// new design doesn't surface them, and skipping them removes ~100
		// pages from the build plus lets us strip Category/Tag fragments from
		// the prefetch query.
		const contentNodesPageQuery = `query GetContentNodesUrisPage($after: String) {
      contentNodes(first: ${ALL_URIS_PAGE_SIZE}, after: $after) {
        nodes { uri }
        pageInfo { hasNextPage endCursor }
      }
    }`;
		const allContentNodes: { uri: string | null }[] = [];
		let contentAfter: string | null = null;
		do {
			const data = await executeQuery<{ contentNodes: UriPageResponse }>(
				contentNodesPageQuery,
				{ after: contentAfter },
				`all-uris-contentnodes-${contentAfter ?? "initial"}`,
				false,
			);
			allContentNodes.push(...data.contentNodes.nodes);
			contentAfter = data.contentNodes.pageInfo.hasNextPage
				? data.contentNodes.pageInfo.endCursor
				: null;
		} while (contentAfter !== null);

		const allNodes: { uri: string | null }[] = allContentNodes;
		const result = allNodes
			.map(uriNodeToParams)
			.filter((p): p is UriParams => p !== null);

		queryCache.set(ALL_URIS_MERGED_CACHE_KEY, {
			data: result,
			timestamp: Date.now(),
		});
		log.debug(`Total URIs fetched for static paths: ${result.length}`);

		// Kick off batched pre-fetch in the background — getNodeByURI will await it.
		ensurePrefetch(result.map((r) => `/${r.params.uri}/`));

		return result;
	} catch (error) {
		log.error(`Error fetching all URIs: ${error}`);
		return [
			{ params: { uri: "example-post-1" } },
			{ params: { uri: "example-post-2" } },
			{ params: { uri: "about" } },
			{ params: { uri: "contact" } },
			{ params: { uri: "category/sample" } },
		];
	}
}
