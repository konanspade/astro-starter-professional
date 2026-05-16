/**
 * Persistent file-based cache for GraphQL responses, used during `astro build`
 * to avoid re-fetching unchanged content. The cache directory is restored from
 * GitHub Actions cache between CI runs.
 *
 * Per-URI invalidation: a pre-flight "inventory" query (in api.ts) records
 * every contentNode's modifiedGmt; on the next build we delete only the cache
 * entries whose URI's modifiedGmt has changed. List/global queries (anything
 * without a uri variable) are invalidated whenever anything changed.
 *
 * This module uses node:fs and is only safe to import from server-side
 * (build-time) code. Always guard with `typeof window === "undefined"`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const CACHE_DIR = path.join(process.cwd(), ".cache", "graphql");
const INVENTORY_FILE = path.join(CACHE_DIR, "_inventory.json");

export interface InventoryNode {
	uri: string;
	modifiedGmt: string;
}

interface CacheEntry<T = unknown> {
	query: string;
	variables: Record<string, unknown>;
	data: T;
	fetchedAt: string;
}

function ensureDir(): void {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function entryFile(
	query: string,
	variables: Record<string, unknown>,
): string {
	const key = crypto
		.createHash("sha256")
		.update(query + JSON.stringify(variables))
		.digest("hex");
	return path.join(CACHE_DIR, `${key}.json`);
}

export function readCacheEntry<T>(
	query: string,
	variables: Record<string, unknown>,
): T | null {
	const file = entryFile(query, variables);
	if (!fs.existsSync(file)) return null;
	try {
		const entry = JSON.parse(fs.readFileSync(file, "utf-8")) as CacheEntry<T>;
		return entry.data;
	} catch {
		return null;
	}
}

export function writeCacheEntry<T>(
	query: string,
	variables: Record<string, unknown>,
	data: T,
): void {
	try {
		ensureDir();
		const entry: CacheEntry<T> = {
			query,
			variables,
			data,
			fetchedAt: new Date().toISOString(),
		};
		fs.writeFileSync(entryFile(query, variables), JSON.stringify(entry));
	} catch {
		// Cache writes are best-effort
	}
}

export function readInventory(): InventoryNode[] | null {
	if (!fs.existsSync(INVENTORY_FILE)) return null;
	try {
		return JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf-8"));
	} catch {
		return null;
	}
}

export function writeInventory(nodes: InventoryNode[]): void {
	try {
		ensureDir();
		fs.writeFileSync(INVENTORY_FILE, JSON.stringify(nodes));
	} catch {
		// best-effort
	}
}

/**
 * Delete cache files whose stored variables.uri is in `changedUris`. When
 * `invalidateLists` is true, also delete entries that have no uri variable
 * (list / global queries — getPosts, getAllUris, settings, menus, etc).
 */
export function invalidateBy(
	changedUris: Set<string>,
	invalidateLists: boolean,
): { perUriDeleted: number; listDeleted: number } {
	if (!fs.existsSync(CACHE_DIR)) {
		return { perUriDeleted: 0, listDeleted: 0 };
	}
	let perUriDeleted = 0;
	let listDeleted = 0;
	for (const filename of fs.readdirSync(CACHE_DIR)) {
		if (!filename.endsWith(".json") || filename.startsWith("_")) continue;
		const filepath = path.join(CACHE_DIR, filename);
		let entry: CacheEntry;
		try {
			entry = JSON.parse(fs.readFileSync(filepath, "utf-8")) as CacheEntry;
		} catch {
			fs.unlinkSync(filepath);
			continue;
		}
		const uri = (entry.variables as { uri?: unknown })?.uri;
		if (typeof uri === "string") {
			if (changedUris.has(uri)) {
				fs.unlinkSync(filepath);
				perUriDeleted++;
			}
		} else if (invalidateLists) {
			fs.unlinkSync(filepath);
			listDeleted++;
		}
	}
	return { perUriDeleted, listDeleted };
}
