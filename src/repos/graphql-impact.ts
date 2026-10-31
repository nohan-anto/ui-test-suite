/**
 * GraphQL impact chains across  UI → gateway (GraphQL middle service) → downstream subgraphs.
 *
 * Links are made by root field:
 *  - UI operation selects root field F                      → gateway field F
 *  - gateway resolver for F sends an operation selecting D  → downstream field D
 *  - gateway and subgraph declare the same field (stitching / federation passthrough) → linked directly
 * With no gateway repo configured, UI operations link straight to subgraph fields of the same name.
 */
import { touchedItems, sdlFieldNamesInLines, type RepoChanges } from "./diff.ts";
import { fieldKey, lineAt, type GqlField, type GqlOperation } from "./graphql.ts";
import type { RepoGraph } from "./impact.ts";
import type { RepoIndex } from "./indexer.ts";
import { uniq } from "../util/index.ts";

export interface GqlRef {
  repo: string;
  file: string;
  line: number;
  label: string;
}

export interface UiRef extends GqlRef {
  routes: string[];
}

export interface GqlChain {
  trigger: GqlRef & { role: RepoIndex["role"] };
  gateway: GqlRef[];
  downstream: GqlRef[];
  ui: UiRef[];
}

export interface FieldHint {
  field: string;
  changedIn: GqlRef;
  ui: GqlRef[];
}

/** Field names too generic to be useful in "UI operations reading changed field X" hints. */
const HINT_STOPLIST = new Set(["id", "__typename", "name", "type", "value", "key", "code", "description", "title"]);

const fieldRef = (repo: string, f: GqlField): GqlRef => ({ repo, file: f.file, line: f.line, label: `${f.kind}.${f.field} (${f.source})` });
const opRef = (repo: string, o: GqlOperation): GqlRef => ({ repo, file: o.file, line: o.line, label: `${o.kind.toLowerCase()} ${o.name}` });
const opKeys = (o: GqlOperation) => o.rootFields.map((f) => fieldKey(o.kind, f));
const keyOf = (f: GqlField) => fieldKey(f.kind, f.field);

function dedupeRefs<T extends GqlRef>(refs: T[]): T[] {
  return [...new Map(refs.map((r) => [`${r.repo}:${r.file}:${r.line}:${r.label}`, r])).values()];
}

export class GraphqlLinker {
  private readonly uis: RepoIndex[];
  private readonly gateways: RepoIndex[];
  private readonly downstreams: RepoIndex[];
  private readonly senderMemo = new Map<GqlOperation, Promise<GqlField[]>>();

  constructor(
    indexes: RepoIndex[],
    private readonly graphs: Map<string, RepoGraph>,
  ) {
    this.uis = indexes.filter((i) => i.role === "ui");
    this.gateways = indexes.filter((i) => i.role === "gateway" && i.gqlFields.length);
    this.downstreams = indexes.filter((i) => i.role === "downstream");
  }

  /** The resolver/field in `file` whose body contains `line` (nearest declaration at or above it). */
  private owner(ix: RepoIndex, file: string, line: number): GqlField | undefined {
    return ix.gqlFields
      .filter((f) => f.file === file && f.source === "resolver" && f.line <= line)
      .sort((a, b) => b.line - a.line)[0];
  }

  /** Gateway resolvers that send `op` (defined in gateway repo `gx`) to a subgraph. */
  private sendersOf(gx: RepoIndex, op: GqlOperation): Promise<GqlField[]> {
    if (!this.senderMemo.has(op)) this.senderMemo.set(op, this.findSenders(gx, op));
    return this.senderMemo.get(op)!;
  }

  private async findSenders(gx: RepoIndex, op: GqlOperation): Promise<GqlField[]> {
    const out: GqlField[] = [];
    const inline = this.owner(gx, op.file, op.line);
    if (inline) out.push(inline);
    if (op.binding) {
      const g = this.graphs.get(gx.repo)!;
      for (const file of [op.file, ...(await g.importers(op.file))]) {
        const text = await g.text(file);
        for (const m of text.matchAll(new RegExp(`\\b${op.binding.replace(/\$/g, "\\$")}\\b`, "g"))) {
          const o = this.owner(gx, file, lineAt(text, m.index!));
          if (o) out.push(o);
        }
      }
    }
    return [...new Map(out.map((f) => [`${f.file}:${f.line}`, f])).values()];
  }

  /** Downstream field keys → gateway fields that expose or call them. */
  async gatewayFieldsFor(downstreamKeys: string[]): Promise<{ keys: string[]; refs: GqlRef[] }> {
    if (!this.gateways.length) return { keys: downstreamKeys, refs: [] };
    const refs: GqlRef[] = [];
    const keys: string[] = [];
    for (const gx of this.gateways) {
      for (const f of gx.gqlFields.filter((f) => downstreamKeys.includes(keyOf(f)))) {
        refs.push(fieldRef(gx.repo, f));
        keys.push(keyOf(f));
      }
      for (const op of gx.gqlOperations.filter((o) => opKeys(o).some((k) => downstreamKeys.includes(k)))) {
        for (const s of await this.sendersOf(gx, op)) {
          refs.push({ ...fieldRef(gx.repo, s), label: `${s.kind}.${s.field} (resolver, sends ${op.kind.toLowerCase()} ${op.name})` });
          keys.push(keyOf(s));
        }
      }
    }
    return { keys: uniq(keys), refs: dedupeRefs(refs) };
  }

  /** Gateway field keys → downstream subgraph fields they call or pass through to. */
  async downstreamFieldsFor(gatewayKeys: string[]): Promise<GqlRef[]> {
    const targetKeys = new Set(gatewayKeys);
    for (const gx of this.gateways) {
      for (const op of gx.gqlOperations) {
        const senders = await this.sendersOf(gx, op);
        if (senders.some((s) => gatewayKeys.includes(keyOf(s)))) for (const k of opKeys(op)) targetKeys.add(k);
      }
    }
    const refs: GqlRef[] = [];
    for (const dx of this.downstreams) for (const f of dx.gqlFields.filter((f) => targetKeys.has(keyOf(f)))) refs.push(fieldRef(dx.repo, f));
    return dedupeRefs(refs);
  }

  /** UI operations selecting any of the gateway keys, with the routes/screens that reach them. */
  async uiOpsFor(keys: string[]): Promise<UiRef[]> {
    const out: UiRef[] = [];
    for (const ux of this.uis) {
      const g = this.graphs.get(ux.repo)!;
      for (const op of ux.gqlOperations.filter((o) => opKeys(o).some((k) => keys.includes(k)))) {
        out.push({ ...opRef(ux.repo, op), routes: await g.routesReaching(op.file) });
      }
    }
    return dedupeRefs(out);
  }

  async build(changes: Map<string, RepoChanges>): Promise<{ chains: GqlChain[]; hints: FieldHint[] }> {
    const chains: GqlChain[] = [];
    const hints: FieldHint[] = [];
    const all = [...this.downstreams, ...this.gateways, ...this.uis];

    for (const ix of all) {
      const repoChanges = changes.get(ix.repo);
      if (!repoChanges) continue;
      for (const [file, change] of repoChanges) {
        const inFile = ix.gqlFields.filter((f) => f.file === file);
        const fieldsHere = [
          ...touchedItems(inFile.filter((f) => f.source === "sdl"), change.ranges, true),
          ...touchedItems(inFile.filter((f) => f.source === "resolver"), change.ranges),
        ];
        const opsHere = touchedItems(ix.gqlOperations.filter((o) => o.file === file), change.ranges);

        if (ix.role === "downstream") {
          for (const key of uniq(fieldsHere.map(keyOf))) {
            const f = fieldsHere.find((x) => keyOf(x) === key)!;
            const gw = await this.gatewayFieldsFor([key]);
            chains.push({ trigger: { ...fieldRef(ix.repo, f), role: ix.role }, gateway: gw.refs, downstream: [], ui: await this.uiOpsFor(gw.keys) });
          }
        } else if (ix.role === "gateway") {
          const touched = [...fieldsHere];
          for (const op of opsHere) touched.push(...(await this.sendersOf(ix, op)));
          for (const key of uniq(touched.map(keyOf))) {
            const f = touched.find((x) => keyOf(x) === key)!;
            chains.push({
              trigger: { ...fieldRef(ix.repo, f), role: ix.role },
              gateway: [],
              downstream: await this.downstreamFieldsFor([key]),
              ui: await this.uiOpsFor([key]),
            });
          }
        } else {
          for (const op of opsHere) {
            const keys = opKeys(op);
            const gw = this.gateways.flatMap((gx) => gx.gqlFields.filter((f) => keys.includes(keyOf(f))).map((f) => fieldRef(gx.repo, f)));
            chains.push({
              trigger: { ...opRef(ix.repo, op), role: ix.role },
              gateway: dedupeRefs(gw),
              downstream: await this.downstreamFieldsFor(keys),
              ui: [{ ...opRef(ix.repo, op), routes: await this.graphs.get(ix.repo)!.routesReaching(op.file) }],
            });
          }
        }

        // Non-root SDL field changes (e.g. `+ status: OrderStatus`) → UI operations that select a field of that name.
        if (ix.role !== "ui" && /\.(graphql|graphqls|gql)$/.test(file)) {
          for (const name of sdlFieldNamesInLines([...change.added, ...change.removed])) {
            if (HINT_STOPLIST.has(name) || fieldsHere.some((f) => f.field === name)) continue;
            const ui = this.uis.flatMap((ux) => ux.gqlOperations.filter((o) => o.fields.includes(name)).map((o) => opRef(ux.repo, o)));
            if (ui.length) hints.push({ field: name, changedIn: { repo: ix.repo, file, line: 0, label: name }, ui: dedupeRefs(ui) });
          }
        }
      }
    }
    return { chains, hints };
  }
}

export function graphqlChainsToMarkdown(chains: GqlChain[], hints: FieldHint[]): string {
  if (!chains.length && !hints.length) return "";
  const loc = (r: GqlRef) => `${r.repo}: ${r.file}${r.line ? `:${r.line}` : ""}`;
  const out = [
    "## GraphQL impact chains",
    "",
    "Changed GraphQL fields/operations traced UI → gateway → subgraph by root-field name (lexical, verify before relying on it).",
    "",
  ];
  for (const c of chains) {
    out.push(`### ${c.trigger.label} — changed in ${loc(c.trigger)} (${c.trigger.role})`, "");
    for (const g of c.gateway) out.push(`- **Gateway:** \`${g.label}\` — ${loc(g)}`);
    for (const d of c.downstream) out.push(`- **Subgraph:** \`${d.label}\` — ${loc(d)}`);
    for (const u of c.ui) out.push(`- **UI:** \`${u.label}\` — ${loc(u)}${u.routes.length ? ` → screens ${u.routes.map((r) => `\`${r}\``).join(", ")}` : ""}`);
    if (!c.gateway.length && !c.downstream.length && !c.ui.length) out.push("- _No linked repos found (is the consuming repo configured?)_");
    out.push("");
  }
  if (hints.length) {
    out.push("### Changed type fields selected by UI operations", "");
    for (const h of hints) out.push(`- \`${h.field}\` (${h.changedIn.repo}: ${h.changedIn.file}) → ${h.ui.map((u) => `\`${u.label}\` (${loc(u)})`).join(", ")}`);
    out.push("");
  }
  return out.join("\n");
}
