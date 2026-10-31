/**
 * Lexical repo indexer: file tree, routes, UI components, API endpoints, feature flags, i18n files.
 * Cached per repo keyed by HEAD sha. Pluggable: other strategies can implement the same RepoIndex shape.
 */
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { RepoConfig } from "../config/schema.ts";
import { scanGraphql, type GqlField, type GqlOperation } from "./graphql.ts";
import { headSha, lsFiles } from "./git.ts";

export interface RouteEntry {
  path: string;
  file: string;
  line: number;
}
export interface SymbolEntry {
  name: string;
  file: string;
  line: number;
}

/** Bump when the index shape or extraction changes, so cached indexes are rebuilt. */
export const INDEX_VERSION = 2;

export interface RepoIndex {
  version: number;
  repo: string;
  role: RepoConfig["role"];
  root: string;
  headSha: string;
  builtAt: string;
  files: string[];
  routes: RouteEntry[];
  components: string[];
  apiEndpoints: SymbolEntry[];
  featureFlags: SymbolEntry[];
  i18nFiles: string[];
  /** GraphQL operations found in code / .graphql files (UI queries, or queries a gateway sends to subgraphs). */
  gqlOperations: GqlOperation[];
  /** GraphQL root fields declared in SDL or implemented by resolvers. */
  gqlFields: GqlField[];
}

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", ".html",
  ".java", ".kt", ".py", ".go", ".cs", ".rb", ".php",
  ".graphql", ".graphqls", ".gql",
]);
const MAX_FILE_BYTES = 400_000;

const ROUTE_PATTERNS: RegExp[] = [
  /<Route\b[^>]*\bpath=["'`]([^"'`]+)["'`]/g, // React Router JSX
  /\bpath\s*:\s*["'`]([^"'`]*)["'`]/g, // React Router objects, Angular, Vue Router
  /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g, // Spring
  /@(?:app|router|bp)\.(?:get|post|put|patch|delete|route)\(\s*["']([^"']+)["']/g, // Flask/FastAPI
  /\b(?:router|app)\.(?:get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g, // Express
];
const API_PATTERN = /["'`](\/(?:api|v\d+|graphql)\/?[\w\-/{}:.$]*)["'`]/g;
const FLAG_PATTERNS: RegExp[] = [
  /\b(?:isEnabled|isFeatureEnabled|useFlag|useFeatureFlag|featureFlag|getFlag|variation|isOn)\(\s*["'`]([\w.\-:]+)["'`]/g,
  /\bFEATURE_[A-Z0-9_]+\b/g,
];

export function isExcluded(file: string, exclude: string[]): boolean {
  const parts = file.split("/");
  return exclude.some((e) => parts.includes(e) || file.startsWith(e));
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** File-system routes for Next.js / Nuxt / SvelteKit / Remix style projects. */
export function fileBasedRoute(file: string): string | null {
  const m = file.match(/(?:^|\/)(?:src\/)?(pages|app|routes)\/(.+)\.(tsx|jsx|ts|js|vue|svelte)$/);
  if (!m) return null;
  let rest = m[2]!;
  if (m[1] === "app" && !/(^|\/)page$/.test(rest)) return null;
  if (m[1] === "routes" && /\+(layout|server)/.test(rest)) return null;
  if (/(^|\/)_(app|document|layout)/.test(rest) || rest.startsWith("api/")) return null;
  rest = rest.replace(/(^|\/)(index|page|\+page)$/, "").replace(/\([^)]*\)\/?/g, "");
  return "/" + rest.replace(/\[([^\]]+)\]/g, ":$1").replace(/\/$/, "");
}

export function scanSource(file: string, text: string) {
  const routes: RouteEntry[] = [];
  const apiEndpoints: SymbolEntry[] = [];
  const featureFlags: SymbolEntry[] = [];
  for (const re of ROUTE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const p = m[1]!;
      // `path:` is noisy (fs paths, URLs); keep route-looking values only
      if (p.includes("\\") || /\.\w{2,4}$/.test(p) || p.startsWith("http")) continue;
      routes.push({ path: p, file, line: lineOf(text, m.index!) });
    }
  }
  for (const m of text.matchAll(API_PATTERN)) apiEndpoints.push({ name: m[1]!, file, line: lineOf(text, m.index!) });
  for (const re of FLAG_PATTERNS) {
    for (const m of text.matchAll(re)) featureFlags.push({ name: m[1] ?? m[0], file, line: lineOf(text, m.index!) });
  }
  return { routes, apiEndpoints, featureFlags };
}

export async function buildIndex(repo: RepoConfig, exclude: string[]): Promise<RepoIndex> {
  const files = (await lsFiles(repo.path)).filter((f) => !isExcluded(f, exclude));
  const index: RepoIndex = {
    version: INDEX_VERSION,
    repo: repo.name,
    role: repo.role,
    root: repo.path,
    headSha: await headSha(repo.path),
    builtAt: new Date().toISOString(),
    files,
    routes: [],
    components: [],
    apiEndpoints: [],
    featureFlags: [],
    i18nFiles: [],
    gqlOperations: [],
    gqlFields: [],
  };
  for (const f of files) {
    const ext = extname(f);
    if (/(^|\/)(i18n|locales?|translations|lang)\//i.test(f) && /\.(json|ya?ml|properties)$/.test(f)) {
      index.i18nFiles.push(f);
    }
    if (/(^|\/)(components?|pages|views|screens|features|app|routes)\//.test(f) && /\.(tsx|jsx|vue|svelte)$/.test(f)) {
      index.components.push(f);
    }
    const fr = fileBasedRoute(f);
    if (fr) index.routes.push({ path: fr, file: f, line: 1 });
    if (!SOURCE_EXT.has(ext)) continue;
    const bf = Bun.file(join(repo.path, f));
    if (!(await bf.exists()) || bf.size > MAX_FILE_BYTES) continue;
    const text = await bf.text();
    const s = scanSource(f, text);
    const g = scanGraphql(f, text);
    index.gqlOperations.push(...g.operations);
    index.gqlFields.push(...g.fields);
    index.routes.push(...s.routes);
    index.apiEndpoints.push(...s.apiEndpoints);
    index.featureFlags.push(...s.featureFlags);
  }
  return index;
}

export async function getIndex(repo: RepoConfig, opts: { exclude: string[]; cacheDir: string; force?: boolean }) {
  mkdirSync(opts.cacheDir, { recursive: true });
  const cachePath = join(opts.cacheDir, `${repo.name}.json`);
  const sha = await headSha(repo.path);
  if (!opts.force && existsSync(cachePath)) {
    const cached = (await Bun.file(cachePath).json()) as RepoIndex;
    if (cached.headSha === sha && cached.version === INDEX_VERSION) return { index: cached, cached: true };
  }
  const index = await buildIndex(repo, opts.exclude);
  await Bun.write(cachePath, JSON.stringify(index));
  return { index, cached: false };
}

export function indexSummaryMarkdown(ix: RepoIndex, maxItems = 200): string {
  const routes = [...new Map(ix.routes.map((r) => [`${r.path}@${r.file}`, r])).values()];
  const flags = [...new Set(ix.featureFlags.map((f) => f.name))];
  const apis = [...new Set(ix.apiEndpoints.map((a) => a.name))];
  return [
    `# Repo index: ${ix.repo} (${ix.role})`,
    "",
    `- **Path:** ${ix.root}`,
    `- **HEAD:** ${ix.headSha}`,
    `- **Files:** ${ix.files.length} · **Routes:** ${routes.length} · **Components:** ${ix.components.length} · **API endpoints:** ${apis.length} · **Flags:** ${flags.length} · **GraphQL operations:** ${ix.gqlOperations.length} · **GraphQL root fields:** ${new Set(ix.gqlFields.map((f) => `${f.kind}.${f.field}`)).size}`,
    "",
    "## Routes",
    "",
    ...routes.slice(0, maxItems).map((r) => `- \`${r.path}\` — ${r.file}:${r.line}`),
    "",
    "## Feature flags",
    "",
    ...flags.slice(0, maxItems).map((f) => `- \`${f}\``),
    "",
    "## GraphQL root fields (schema / resolvers)",
    "",
    ...[...new Map(ix.gqlFields.map((f) => [`${f.kind}.${f.field}`, f])).values()]
      .slice(0, maxItems)
      .map((f) => `- \`${f.kind}.${f.field}\` — ${f.file}:${f.line} (${f.source})`),
    "",
    "## GraphQL operations",
    "",
    ...ix.gqlOperations.slice(0, maxItems).map((o) => `- ${o.kind.toLowerCase()} \`${o.name}\` → ${o.rootFields.join(", ")} — ${o.file}:${o.line}`),
    "",
    "## API endpoints referenced",
    "",
    ...apis.slice(0, maxItems).map((a) => `- \`${a}\``),
    "",
  ].join("\n");
}
