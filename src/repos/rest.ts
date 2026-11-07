/**
 * Lexical REST extraction: HTTP routes a service exposes, and HTTP calls code makes to other services.
 * Covers Node (Express, Fastify, Koa-style routers, NestJS), ASP.NET (controllers, minimal APIs), Go (net/http,
 * gin, echo, fiber, chi, gorilla/mux), Spring, Flask/FastAPI. Calls: fetch, axios-style clients, Apollo
 * RESTDataSource, HttpClient, RestSharp, Go net/http + resty, RestTemplate/WebClient, requests/httpx.
 */
import { lineAt } from "./graphql.ts";

export interface HttpRoute {
  method: string | null;
  path: string;
  file: string;
  line: number;
}

export interface HttpCall {
  method: string | null;
  path: string;
  file: string;
  line: number;
}

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const verb = (s: string | undefined | null) => {
  const v = s?.toUpperCase();
  return v && VERBS.includes(v) ? v : null;
};

/** Comparable path: no scheme/host, no leading base-url placeholder, no query; params → "*", lower case. */
export function normalisePath(raw: string): string {
  let p = raw.trim().replace(/^https?:\/\/[^/]+/i, "");
  p = p.replace(/^(?:\$\{[^}]*\}|\{[^}/]*\}|%[sv])+/, ""); // `${BASE}/x`, `{_baseUrl}/x`, "%s/x"
  p = p.split(/[?#]/)[0]!.replace(/^~/, "");
  p = p.replace(/\$\{[^}]*\}|\{[^}]*\}|<[^>]+>|:[A-Za-z_]\w*|%[sdvq]|\[[^\]]*\]|\*\w*/g, "*");
  p = ("/" + p).replace(/\/+/g, "/").replace(/\/$/, "");
  return (p || "/").toLowerCase();
}

const segs = (p: string) => normalisePath(p).split("/").filter(Boolean);

/**
 * Does a call path hit a route path? Compared by trailing segments so base paths on either side don't matter
 * (`/api/v1/orders/*` ↔ `orders/{id}`), with "*" matching any one segment. Needs one real literal segment in common.
 */
export function pathsMatch(a: string, b: string): boolean {
  const x = segs(a);
  const y = segs(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const tail = long.slice(long.length - short.length);
  if (!short.every((s, i) => s === "*" || tail[i] === "*" || s === tail[i])) return false;
  return short.some((s, i) => s !== "*" && s === tail[i] && s.length >= 2 && !/^(api|v\d+|rest)$/.test(s));
}

export const methodsMatch = (a: string | null, b: string | null) => !a || !b || a === b;

/** prefix + child. `absoluteSlash`: a leading "/" in the child ignores the prefix (ASP.NET attribute routes only). */
function joinPath(prefix: string, p: string, absoluteSlash = false): string {
  if (absoluteSlash && /^~?\//.test(p)) return p.replace(/^~/, "");
  if (!p) return prefix || "/";
  return prefix ? `${prefix.replace(/\/$/, "")}/${p.replace(/^\//, "")}` : p;
}

/** Route attributes that sit in front of a class (C# [Route], Spring @RequestMapping, Nest @Controller). */
function classPrefixes(text: string, prefixRe: RegExp): { pos: number; prefix: string; name: string }[] {
  const out: { pos: number; prefix: string; name: string }[] = [];
  for (const m of text.matchAll(/\bclass\s+(\w+)/g)) {
    const before = text.slice(Math.max(0, m.index! - 800), m.index!);
    const head = before.slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf(";")) + 1);
    const p = [...head.matchAll(prefixRe)].at(-1);
    out.push({ pos: m.index!, prefix: p?.[1] ?? "", name: m[1]! });
  }
  return out;
}

function classScoped(file: string, text: string, prefixRe: RegExp, methodRe: RegExp, aspNet: boolean): HttpRoute[] {
  const classes = classPrefixes(text, prefixRe);
  const out: HttpRoute[] = [];
  for (const m of text.matchAll(methodRe)) {
    // An annotation directly in front of a class is the class prefix (Spring @RequestMapping), not a route.
    const next = classes.find((c) => c.pos > m.index!);
    if (next && !/[{};]/.test(text.slice(m.index! + m[0].length, next.pos))) continue;
    const cls = classes.filter((c) => c.pos < m.index!).at(-1);
    let prefix = cls?.prefix ?? "";
    if (aspNet && cls) prefix = prefix.replace(/\[controller\]/gi, cls.name.replace(/Controller$/, ""));
    const template = m.groups?.path ?? "";
    out.push({ method: verb(m.groups?.verb), path: joinPath(prefix, template, aspNet), file, line: lineAt(text, m.index!) });
  }
  return out;
}

/** `g := r.Group("/x")` / `var g = app.MapGroup("/x")`: variable → full prefix (groups of groups resolved). */
function groupPrefixes(text: string, re: RegExp): Map<string, string> {
  const raw = new Map<string, { parent: string; path: string }>();
  for (const m of text.matchAll(re)) raw.set(m[1]!, { parent: m[2]!, path: m[3]! });
  const resolve = (v: string, depth = 0): string => {
    const g = raw.get(v);
    return g && depth < 5 ? joinPath(resolve(g.parent, depth + 1), g.path) : "";
  };
  return new Map([...raw.keys()].map((k) => [k, resolve(k)]));
}

export function scanHttpRoutes(file: string, text: string): HttpRoute[] {
  const out: HttpRoute[] = [];
  const at = (m: RegExpMatchArray) => lineAt(text, m.index!);

  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
    // Express / Fastify / Koa-router / Hono: app.get("/x"), ordersRouter.post("/x")
    for (const m of text.matchAll(/\b(?:app|server|fastify|hono|\w*[rR]outer|\w*[rR]outes)\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`]*)\2/g)) {
      out.push({ method: verb(m[1]), path: m[3]!, file, line: at(m) });
    }
    for (const m of text.matchAll(/\.route\(\s*(['"`])(\/[^'"`]*)\1\s*\)/g)) out.push({ method: null, path: m[2]!, file, line: at(m) });
    // NestJS
    if (text.includes("@Controller")) {
      out.push(...classScoped(file, text, /@Controller\(\s*(?:\{\s*path\s*:\s*)?['"`]([^'"`]*)['"`]/g, /@(?<verb>Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`](?<path>[^'"`]*)['"`])?\s*\)/g, false));
    }
  } else if (file.endsWith(".cs")) {
    // Controllers: [Route("api/[controller]")] class OrdersController { [HttpGet("{id}")] ... }
    out.push(
      ...classScoped(
        file,
        text,
        /\[(?:Route|RoutePrefix)\(\s*@?"([^"]*)"/g,
        /\[Http(?<verb>Get|Post|Put|Patch|Delete)(?:\(\s*(?:template:\s*)?@?"(?<path>[^"]*)"[^)]*\))?\]/g,
        true,
      ),
    );
    // Minimal APIs, including MapGroup prefixes
    const groups = groupPrefixes(text, /\b(?:var\s+)?(\w+)\s*=\s*(\w+)\.MapGroup\(\s*"([^"]*)"\s*\)/g);
    for (const m of text.matchAll(/\b(\w+)\.Map(Get|Post|Put|Patch|Delete|Methods)\(\s*"([^"]*)"/g)) {
      out.push({ method: verb(m[2]), path: joinPath(groups.get(m[1]!) ?? "", m[3]!), file, line: at(m) });
    }
  } else if (file.endsWith(".go")) {
    const groups = groupPrefixes(text, /\b(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g);
    // gin/echo/fiber (GET), chi (Get), net/http + gorilla (HandleFunc/Handle, Go 1.22 "GET /x" patterns)
    for (const m of text.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"((?:[A-Z]+ )?\/[^"]*)"/g)) {
      let [method, path] = [verb(m[2]), m[3]!];
      const pattern = path.match(/^([A-Z]+) (\/.*)$/);
      if (pattern) [method, path] = [verb(pattern[1]), pattern[2]!];
      if (!method) method = verb(text.slice(m.index!, text.indexOf("\n", m.index!)).match(/\.Methods\(\s*"(\w+)"/)?.[1]);
      out.push({ method, path: joinPath(groups.get(m[1]!) ?? "", path), file, line: at(m) });
    }
  } else if (/\.(java|kt)$/.test(file)) {
    out.push(
      ...classScoped(
        file,
        text,
        /@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/g,
        /@(?<verb>Get|Post|Put|Patch|Delete|Request)Mapping(?:\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"(?<path>[^"]*)")?/g,
        false,
      ),
    );
  } else if (file.endsWith(".py")) {
    for (const m of text.matchAll(/@(\w+)\.(get|post|put|patch|delete|route|api_route)\(\s*['"]([^'"]+)['"]/g)) {
      out.push({ method: verb(m[2]), path: m[3]!, file, line: at(m) });
    }
  }
  return out;
}

/** Lines that make HTTP requests (or build request URLs). */
const CALL_HINT = new RegExp(
  [
    String.raw`\bfetch\s*\(`,
    String.raw`\baxios\b`,
    String.raw`\b(?:ky|got|superagent|requests|httpx|http|client|httpClient|_httpClient|_client|restClient|api|apiClient|\$http|this)\s*\.\s*(?:get|post|put|patch|delete|request|send|head)\w*\s*(?:<[^>]*>)?\s*\(`,
    String.raw`\b(?:Get|Post|Put|Patch|Delete|Send)(?:Async|FromJsonAsync|AsJsonAsync)\s*(?:<[^>]*>)?\s*\(`,
    String.raw`new\s+(?:HttpRequestMessage|RestRequest|URL|Request)\s*\(`,
    String.raw`\bhttp\.(?:Get|Post|Head|NewRequest\w*)\s*\(`,
    String.raw`\.R\(\)\.\w+\(`,
    String.raw`\.uri\s*\(`,
    String.raw`\b(?:getForObject|getForEntity|postForObject|postForEntity|exchange)\s*\(`,
    String.raw`\b(?:url|uri|endpoint|baseUrl|resource)\w*\s*(?::=|=|:)(?!=)`,
  ].join("|"),
  "i",
);
/** Client calls whose first argument may be a bare relative path: this.get("orders"), client.GetAsync($"orders/{id}"). */
const RELATIVE_ARG = /\b(?:this|client|httpClient|_httpClient|_client|api|apiClient|http)\s*\.\s*(get|post|put|patch|delete)\w*\s*(?:<[^>]*>)?\s*\(\s*[$@]?["'`]/i;
const LITERAL = /[$@]{0,2}"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const NOT_PATH_EXT = /\.(tsx?|jsx?|mjs|json|css|scss|less|png|svg|jpe?g|gif|webp|ico|html?|md|ya?ml|go|cs|py|java|kt|graphql|gql)$/i;

function looksLikePath(s: string, allowBare: boolean): boolean {
  if (!s || /\s/.test(s) || s.length > 200 || /^\.{1,2}\//.test(s) || s.startsWith("//")) return false;
  if (/^(application|text|image|multipart|audio|video|font)\//i.test(s) || NOT_PATH_EXT.test(s)) return false;
  if (/^(get|post|put|patch|delete|head|options)$/i.test(s)) return false;
  const p = normalisePath(s);
  if (!/^\/[\w\-*.~]+(?:\/[\w\-*.~]+)*$/.test(p) || !/[a-z]{2,}/.test(p)) return false;
  const hasSlash = /^https?:\/\//i.test(s) || s.replace(/^(?:\$\{[^}]*\}|\{[^}/]*\}|%[sv])+/, "").includes("/");
  return hasSlash || allowBare;
}

export function scanHttpCalls(file: string, text: string, routeLines: Set<number> = new Set()): HttpCall[] {
  const out: HttpCall[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    if (routeLines.has(n) || /^\s*(import|from|export \* from|require|using|package|#include|\/\/|\*|#)/.test(line)) return;
    const hint = line.match(CALL_HINT);
    if (!hint) return;
    const lineVerb =
      verb(hint[0].match(/\b(get|post|put|patch|delete)/i)?.[1]) ??
      verb(line.match(/method\s*[:=]\s*["'`](\w+)["'`]/i)?.[1]) ??
      verb(line.match(/HttpMethod\.(\w+)/)?.[1]) ??
      verb(line.match(/["'](GET|POST|PUT|PATCH|DELETE)["']/)?.[1]);
    const relative = RELATIVE_ARG.test(line);
    let first = true;
    for (const m of line.matchAll(LITERAL)) {
      let s = m[0].replace(/^[$@]+/, "").slice(1, -1);
      // "…/orders/" + id → treat the concatenated part as a parameter
      if (s.endsWith("/") && /^\s*\+/.test(line.slice(m.index! + m[0].length))) s += "{p}";
      if (looksLikePath(s, relative && first)) out.push({ method: lineVerb, path: s, file, line: n });
      first = false;
    }
  });
  return out;
}

export function scanHttp(file: string, text: string): { routes: HttpRoute[]; calls: HttpCall[] } {
  const routes = scanHttpRoutes(file, text);
  return { routes, calls: scanHttpCalls(file, text, new Set(routes.map((r) => r.line))) };
}

export const routeLabel = (r: { method: string | null; path: string }) => `${r.method ?? "ANY"} ${r.path}`;
