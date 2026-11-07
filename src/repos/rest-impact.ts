/**
 * REST impact chains, for downstreams (and gateways) that are plain HTTP APIs instead of, or as well as, GraphQL:
 *
 *  downstream route changed ─► gateway code calling it ─► owning GraphQL resolver ─► UI operations ─► screens
 *                                                     └─► owning REST (BFF) route ─► UI HTTP calls ─► screens
 *                           └─► UI code calling it directly ─► screens
 *
 * A change in a service/repository file with no route in it is traced to the routes that call it (by function
 * name, up to two hops). Calls and routes are matched by trailing path segments and HTTP method.
 */
import { join } from "node:path";
import { touchedItems, type Range, type RepoChanges } from "./diff.ts";
import { fieldKey, type GqlField } from "./graphql.ts";
import type { GraphqlLinker, UiRef } from "./graphql-impact.ts";
import type { RepoGraph } from "./impact.ts";
import type { RepoIndex } from "./indexer.ts";
import { methodsMatch, pathsMatch, routeLabel, type HttpCall, type HttpRoute } from "./rest.ts";
import { uniq } from "../util/index.ts";

export interface Loc {
  repo: string;
  file: string;
  line: number;
  label: string;
}

export interface RestChain {
  trigger: Loc & { role: RepoIndex["role"] };
  /** How the trigger was reached when the changed code is not itself a route (service → controller). */
  via: Loc[];
  gateway: Loc[];
  downstream: Loc[];
  ui: UiRef[];
}

const MAX_FILE_BYTES = 400_000;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|cs|java|kt|py)$/;
/** Function names too generic to follow across files. */
const NAME_STOPLIST = new Set([
  "get", "set", "post", "put", "patch", "delete", "run", "main", "init", "handle", "handler", "execute", "invoke", "index",
  "list", "create", "update", "remove", "find", "constructor", "render", "build", "load", "save", "send", "map", "filter",
]);
const FN_DEFS: RegExp[] = [
  /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*[(\[]/, // Go
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/, // JS function
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>/, // JS arrow
  /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, // Python
  /^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|final|sealed|abstract|synchronized|readonly)\s+)+[\w<>\[\],.?\s]*?\b(\w+)\s*(?:<[^>]*>)?\s*\([^;]*$/, // C#/Java/TS methods
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, // TS/JS class method shorthand
];
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "function", "using", "lock", "foreach", "elseif", "new", "await"]);

class Sources {
  private readonly memo = new Map<string, Promise<Map<string, string>>>();
  all(ix: RepoIndex): Promise<Map<string, string>> {
    if (!this.memo.has(ix.repo)) {
      this.memo.set(
        ix.repo,
        (async () => {
          const out = new Map<string, string>();
          for (const f of ix.files.filter((f) => SOURCE.test(f))) {
            const bf = Bun.file(join(ix.root, f));
            if (bf.size <= MAX_FILE_BYTES) out.set(f, await bf.text().catch(() => ""));
          }
          return out;
        })(),
      );
    }
    return this.memo.get(ix.repo)!;
  }
}

/** Items sorted by line; the one whose span (up to the next item) contains `line`. */
const ownerAt = <T extends { line: number }>(items: T[], line: number): T | undefined =>
  items.filter((i) => i.line <= line).sort((a, b) => b.line - a.line)[0];

const inRanges = (line: number, ranges: Range[] | "all") => ranges === "all" || ranges.some(([s, e]) => line >= s && line <= e);

function dedupe<T extends Loc>(xs: T[]): T[] {
  return [...new Map(xs.map((x) => [`${x.repo}:${x.file}:${x.line}:${x.label}`, x])).values()];
}

export class RestLinker {
  private readonly sources = new Sources();
  private readonly uis: RepoIndex[];
  private readonly gateways: RepoIndex[];
  private readonly downstreams: RepoIndex[];

  constructor(
    private readonly indexes: RepoIndex[],
    private readonly graphs: Map<string, RepoGraph>,
    private readonly gql: GraphqlLinker,
  ) {
    this.uis = indexes.filter((i) => i.role === "ui");
    this.gateways = indexes.filter((i) => i.role === "gateway");
    this.downstreams = indexes.filter((i) => i.role === "downstream");
  }

  /** Name of the function/method whose body contains `line`. */
  async enclosingFunction(ix: RepoIndex, file: string, line: number): Promise<{ name: string; line: number } | null> {
    const lines = ((await this.sources.all(ix)).get(file) ?? "").split("\n");
    for (let i = Math.min(line, lines.length) - 1; i >= 0 && i >= line - 400; i--) {
      for (const re of FN_DEFS) {
        const name = lines[i]!.match(re)?.[1];
        if (name && !NOT_A_NAME.has(name.toLowerCase())) return { name, line: i + 1 };
      }
    }
    return null;
  }

  /** Call sites of a function in the same repo (excluding its definition). */
  async usages(ix: RepoIndex, name: string, def: { file: string; line: number }): Promise<{ file: string; line: number }[]> {
    if (name.length < 4 || NAME_STOPLIST.has(name.toLowerCase())) return [];
    const re = new RegExp(`\\b${name}\\b\\s*(?:<[^>\\n]*>)?\\s*[(,)]|\\b${name}\\b\\s*$`, "m");
    const out: { file: string; line: number }[] = [];
    for (const [file, text] of await this.sources.all(ix)) {
      if (!text.includes(name)) continue;
      text.split("\n").forEach((l, i) => {
        if (re.test(l) && !(file === def.file && i + 1 === def.line)) out.push({ file, line: i + 1 });
      });
      if (out.length > 50) break;
    }
    return out;
  }

  /** Routes and GraphQL resolvers that own a code location: directly, or through up to `depth` callers. */
  async ownersOf(ix: RepoIndex, file: string, line: number, depth = 2, via: Loc[] = []): Promise<{ routes: HttpRoute[]; fields: GqlField[]; via: Loc[] }> {
    const routes = ix.httpRoutes.filter((r) => r.file === file);
    const resolvers = ix.gqlFields.filter((f) => f.file === file && f.source === "resolver");
    const fn = await this.enclosingFunction(ix, file, line);
    const route = ownerAt(routes, line);
    const field = ownerAt(resolvers, line);
    // The nearest route/resolver above owns the line unless a different function starts after it
    // (allowing a few lines for attributes/annotations between a route and its handler method).
    const owns = (decl?: { line: number }) => !!decl && (!fn || fn.line <= decl.line + 3);
    const direct = { routes: owns(route) ? [route!] : [], fields: owns(field) ? [field!] : [] };
    if (direct.routes.length || direct.fields.length || depth === 0 || !fn) return { ...direct, via };
    const out = { routes: [] as HttpRoute[], fields: [] as GqlField[], via: [...via] };
    for (const u of await this.usages(ix, fn.name, { file, line: fn.line })) {
      const o = await this.ownersOf(ix, u.file, u.line, depth - 1, [...via, { repo: ix.repo, file, line: fn.line, label: `${fn.name}()` }]);
      out.routes.push(...o.routes);
      out.fields.push(...o.fields);
      if (o.routes.length || o.fields.length) out.via.push(...o.via);
    }
    return { routes: uniq(out.routes), fields: uniq(out.fields), via: dedupe(out.via) };
  }

  private callersIn(repos: RepoIndex[], route: { method: string | null; path: string }): { ix: RepoIndex; call: HttpCall }[] {
    return repos.flatMap((ix) => ix.httpCalls.filter((c) => methodsMatch(c.method, route.method) && pathsMatch(c.path, route.path)).map((call) => ({ ix, call })));
  }

  private routesFor(repos: RepoIndex[], call: { method: string | null; path: string }): { ix: RepoIndex; route: HttpRoute }[] {
    return repos.flatMap((ix) => ix.httpRoutes.filter((r) => methodsMatch(r.method, call.method) && pathsMatch(call.path, r.path)).map((route) => ({ ix, route })));
  }

  private async uiCallersOf(route: { method: string | null; path: string }): Promise<UiRef[]> {
    const out: UiRef[] = [];
    for (const { ix, call } of this.callersIn(this.uis, route)) {
      out.push({ repo: ix.repo, file: call.file, line: call.line, label: `calls ${routeLabel(call)}`, routes: await this.graphs.get(ix.repo)!.routesReaching(call.file) });
    }
    return dedupe(out);
  }

  /** Gateway code calling `route` → its resolvers/BFF routes → UI operations/calls → screens. */
  private async throughGateways(route: HttpRoute): Promise<{ gateway: Loc[]; ui: UiRef[] }> {
    const gateway: Loc[] = [];
    const ui: UiRef[] = [];
    for (const { ix, call } of this.callersIn(this.gateways, route)) {
      const o = await this.ownersOf(ix, call.file, call.line);
      for (const f of o.fields) gateway.push({ repo: ix.repo, file: f.file, line: f.line, label: `${f.kind}.${f.field} (resolver, calls ${routeLabel(call)})` });
      for (const r of o.routes) gateway.push({ repo: ix.repo, file: r.file, line: r.line, label: `${routeLabel(r)} (BFF route, calls ${routeLabel(call)})` });
      if (!o.fields.length && !o.routes.length) gateway.push({ repo: ix.repo, file: call.file, line: call.line, label: `calls ${routeLabel(call)} (no resolver/route found for it)` });
      ui.push(...(await this.gql.uiOpsFor(uniq(o.fields.map((f) => fieldKey(f.kind, f.field))))));
      for (const r of o.routes) ui.push(...(await this.uiCallersOf(r)));
    }
    return { gateway: dedupe(gateway), ui: dedupe(ui) };
  }

  /** Routes affected by a change in `file`: routes whose handler was touched, else routes calling the touched functions. */
  private async affectedRoutes(ix: RepoIndex, file: string, ranges: Range[] | "all"): Promise<{ route: HttpRoute; via: Loc[] }[]> {
    const here = touchedItems(ix.httpRoutes.filter((r) => r.file === file), ranges);
    if (here.length) return here.map((route) => ({ route, via: [] }));
    if (ranges === "all") return [];
    const out: { route: HttpRoute; via: Loc[] }[] = [];
    const seen = new Set<string>();
    for (const [s, e] of ranges) {
      for (const line of uniq([s, e])) {
        const fn = await this.enclosingFunction(ix, file, line);
        if (!fn || seen.has(fn.name)) continue;
        seen.add(fn.name);
        const o = await this.ownersOf(ix, file, line);
        for (const route of o.routes) out.push({ route, via: o.via });
      }
    }
    return [...new Map(out.map((x) => [`${x.route.file}:${x.route.line}`, x])).values()];
  }

  async build(changes: Map<string, RepoChanges>): Promise<RestChain[]> {
    const chains: RestChain[] = [];
    const loc = (ix: RepoIndex, r: { file: string; line: number }, label: string) => ({ repo: ix.repo, file: r.file, line: r.line, label });

    for (const ix of this.indexes) {
      for (const [file, change] of changes.get(ix.repo) ?? []) {
        if (!ix.files.includes(file)) continue;

        if (ix.role === "downstream" || (ix.role === "gateway" && ix.httpRoutes.length)) {
          for (const { route, via } of await this.affectedRoutes(ix, file, change.ranges)) {
            const viaGateway = ix.role === "downstream" ? await this.throughGateways(route) : { gateway: [], ui: [] };
            // A changed BFF route: the downstream endpoints its handler calls.
            const downstream: Loc[] = [];
            if (ix.role === "gateway") {
              const next = ix.httpRoutes.filter((r) => r.file === route.file && r.line > route.line).sort((a, b) => a.line - b.line)[0];
              const handlerCalls = ix.httpCalls.filter((c) => c.file === route.file && c.line >= route.line && c.line < (next?.line ?? Infinity));
              for (const c of handlerCalls) for (const t of this.routesFor(this.downstreams, c)) downstream.push(loc(t.ix, t.route, routeLabel(t.route)));
            }
            chains.push({
              trigger: { ...loc(ix, route, routeLabel(route)), role: ix.role },
              via,
              gateway: viaGateway.gateway,
              downstream: dedupe(downstream),
              ui: dedupe([...viaGateway.ui, ...(await this.uiCallersOf(route))]),
            });
          }
        }

        // Calls made from changed code (UI or gateway) → the backend routes they hit.
        if (ix.role !== "downstream") {
          const calls = ix.httpCalls.filter((c) => c.file === file && inRanges(c.line, change.ranges));
          for (const call of calls) {
            const targets = this.routesFor(ix.role === "ui" ? [...this.gateways, ...this.downstreams] : this.downstreams, call);
            if (!targets.length) continue;
            const screens = ix.role === "ui" ? await this.graphs.get(ix.repo)!.routesReaching(file) : [];
            chains.push({
              trigger: { ...loc(ix, call, `calls ${routeLabel(call)}`), role: ix.role },
              via: [],
              gateway: targets.filter((t) => t.ix.role === "gateway").map((t) => loc(t.ix, t.route, routeLabel(t.route))),
              downstream: targets.filter((t) => t.ix.role === "downstream").map((t) => loc(t.ix, t.route, routeLabel(t.route))),
              ui: ix.role === "ui" ? [{ ...loc(ix, call, `calls ${routeLabel(call)}`), routes: screens }] : [],
            });
          }
        }
      }
    }
    return [...new Map(chains.map((c) => [`${c.trigger.repo}:${c.trigger.file}:${c.trigger.line}:${c.trigger.label}`, c])).values()];
  }
}

export function restChainsToMarkdown(chains: RestChain[]): string {
  if (!chains.length) return "";
  const at = (r: Loc) => `${r.repo}: ${r.file}:${r.line}`;
  const out = [
    "## REST impact chains",
    "",
    "Changed REST endpoints (and the services behind them) traced to the gateway and UI screens, and changed HTTP calls traced to the endpoints they hit. Matched by path and method (lexical, verify before relying on it).",
    "",
  ];
  for (const c of chains) {
    out.push(`### ${c.trigger.label} — changed in ${at(c.trigger)} (${c.trigger.role})`, "");
    if (c.via.length) out.push(`- **Reached via:** ${c.via.map((v) => `\`${v.label}\` (${at(v)})`).join(" → ")}`);
    for (const g of c.gateway) out.push(`- **Gateway:** \`${g.label}\` — ${at(g)}`);
    for (const d of c.downstream) out.push(`- **Downstream:** \`${d.label}\` — ${at(d)}`);
    for (const u of c.ui) out.push(`- **UI:** \`${u.label}\` — ${at(u)}${u.routes.length ? ` → screens ${u.routes.map((r) => `\`${r}\``).join(", ")}` : ""}`);
    if (!c.gateway.length && !c.downstream.length && !c.ui.length) out.push("- _No callers found in the configured repos._");
    out.push("");
  }
  return out.join("\n");
}
