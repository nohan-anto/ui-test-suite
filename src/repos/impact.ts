/** Map changed files (from MRs / local commits) to UI routes and screens. */
import { basename, dirname, extname, join } from "node:path";
import type { RepoIndex } from "./indexer.ts";
import { uniq } from "../util/index.ts";

export interface FileImpact {
  file: string;
  routesInFile: string[];
  importedBy: string[];
  routesViaImporters: string[];
  flags: string[];
  apiEndpoints: string[];
}

export interface RepoImpact {
  repo: string;
  role: RepoIndex["role"];
  files: FileImpact[];
  /** For downstream repos: UI files that call endpoints changed in this repo. */
  uiConsumers: { endpoint: string; repo: string; file: string }[];
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/;

/** Reads each source file once per impact computation. Pure TS, so no ripgrep needed (e.g. on Windows). */
class SourceCache {
  private readonly texts = new Map<string, string>();
  constructor(private readonly ix: RepoIndex) {}
  async all(): Promise<Map<string, string>> {
    if (!this.texts.size) {
      for (const f of this.ix.files.filter((f) => CODE_EXT.test(f))) {
        const bf = Bun.file(join(this.ix.root, f));
        if (bf.size <= 400_000) this.texts.set(f, await bf.text().catch(() => ""));
      }
    }
    return this.texts;
  }
}

/** Files that import `file` (matched by module specifier ending in its extension-less basename path). */
async function findImporters(cache: SourceCache, file: string): Promise<string[]> {
  const stem = basename(file, extname(file));
  const name = stem === "index" ? basename(dirname(file)) : stem;
  if (!name || name.length < 3) return [];
  const re = new RegExp(
    `(?:from|import|require\\()\\s*\\(?["'\`][^"'\`]*/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.\\w+)?["'\`]`,
  );
  const out: string[] = [];
  for (const [f, text] of await cache.all()) if (f !== file && re.test(text)) out.push(f);
  return out;
}

export async function computeImpact(ix: RepoIndex, changedFiles: string[], depth = 2): Promise<RepoImpact> {
  const files: FileImpact[] = [];
  const cache = new SourceCache(ix);
  const routesByFile = new Map<string, string[]>();
  for (const r of ix.routes) routesByFile.set(r.file, [...(routesByFile.get(r.file) ?? []), r.path]);

  for (const file of uniq(changedFiles)) {
    const importedBy = new Set<string>();
    let frontier = [file];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier.slice(0, 25)) {
        for (const imp of await findImporters(cache, f)) {
          if (!importedBy.has(imp)) {
            importedBy.add(imp);
            next.push(imp);
          }
        }
      }
      frontier = next;
    }
    files.push({
      file,
      routesInFile: uniq(routesByFile.get(file) ?? []),
      importedBy: [...importedBy].slice(0, 50),
      routesViaImporters: uniq([...importedBy].flatMap((f) => routesByFile.get(f) ?? [])),
      flags: uniq(ix.featureFlags.filter((x) => x.file === file).map((x) => x.name)),
      apiEndpoints: uniq(ix.apiEndpoints.filter((x) => x.file === file).map((x) => x.name)),
    });
  }
  return { repo: ix.repo, role: ix.role, files, uiConsumers: [] };
}

/** Normalise an endpoint so "/api/orders/{id}" and "/api/orders/:id" and "/api/orders/${id}" compare equal. */
export function normaliseEndpoint(e: string): string {
  return e
    .replace(/\$\{[^}]+\}|\{[^}]+\}|:[A-Za-z_]\w*/g, "*")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Link downstream API changes to UI files that reference the same endpoints. */
export function linkDownstream(impacts: RepoImpact[], indexes: RepoIndex[]): void {
  const uiIndexes = indexes.filter((i) => i.role === "ui");
  for (const imp of impacts.filter((i) => i.role === "downstream")) {
    const ix = indexes.find((i) => i.repo === imp.repo);
    if (!ix) continue;
    const changedEndpoints = uniq(
      imp.files.flatMap((f) => [
        ...ix.routes.filter((r) => r.file === f.file).map((r) => r.path),
        ...f.apiEndpoints,
      ]),
    );
    for (const ep of changedEndpoints) {
      const n = normaliseEndpoint(ep);
      if (n.length < 3) continue;
      for (const ui of uiIndexes) {
        for (const a of ui.apiEndpoints) {
          const an = normaliseEndpoint(a.name);
          if (an === n || an.endsWith(n) || n.endsWith(an)) {
            imp.uiConsumers.push({ endpoint: ep, repo: ui.repo, file: `${a.file}:${a.line}` });
          }
        }
      }
    }
  }
}

export function impactToMarkdown(impacts: RepoImpact[]): string {
  if (!impacts.length) return "# Impact analysis\n\n_No changed files could be mapped to local repos._\n";
  const out = ["# Impact analysis", "", "Changed files mapped to UI routes/screens (lexical analysis, verify before relying on it).", ""];
  for (const imp of impacts) {
    out.push(`## ${imp.repo} (${imp.role})`, "");
    for (const f of imp.files) {
      out.push(`### ${f.file}`, "");
      if (f.routesInFile.length) out.push(`- **Routes defined here:** ${f.routesInFile.map((r) => `\`${r}\``).join(", ")}`);
      if (f.routesViaImporters.length)
        out.push(`- **Reached via routes:** ${f.routesViaImporters.map((r) => `\`${r}\``).join(", ")}`);
      if (f.importedBy.length) out.push(`- **Imported by:** ${f.importedBy.slice(0, 15).join(", ")}${f.importedBy.length > 15 ? " …" : ""}`);
      if (f.flags.length) out.push(`- **Feature flags:** ${f.flags.map((x) => `\`${x}\``).join(", ")}`);
      if (f.apiEndpoints.length) out.push(`- **API endpoints:** ${f.apiEndpoints.map((x) => `\`${x}\``).join(", ")}`);
      out.push("");
    }
    if (imp.uiConsumers.length) {
      out.push("### UI consumers of changed endpoints", "");
      for (const c of imp.uiConsumers) out.push(`- \`${c.endpoint}\` → ${c.repo}: ${c.file}`);
      out.push("");
    }
  }
  return out.join("\n");
}

