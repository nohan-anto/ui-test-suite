/**
 * Lightweight GraphQL extraction for impact analysis (no full GraphQL parser needed):
 *  - operations (query/mutation/subscription) from gql`` / graphql`` literals and .graphql files
 *  - schema root fields from SDL (`type Query { … }`, `extend type Mutation { … }`)
 *  - resolver root fields from code: JS/TS resolver maps, Go gqlgen, .NET Hot Chocolate
 */

export type RootKind = "Query" | "Mutation" | "Subscription";

export interface GqlOperation {
  file: string;
  line: number;
  kind: RootKind;
  name: string;
  /** Root fields the operation selects, e.g. ["orders"]. */
  rootFields: string[];
  /** Every field name selected at any depth (for "which ops read field X" hints). */
  fields: string[];
  /** Variable the literal is assigned to (`const GET_ORDERS = gql…`), used to find where it is sent from. */
  binding?: string;
}

export interface GqlField {
  kind: RootKind;
  field: string;
  file: string;
  line: number;
  source: "sdl" | "resolver";
}

export const fieldKey = (kind: RootKind, field: string) => `${kind}.${field}`;

const OP_KIND: Record<string, RootKind> = { query: "Query", mutation: "Mutation", subscription: "Subscription" };
const ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);

export function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------- template literals

export interface GqlLiteral {
  body: string;
  /** Offset of the body within the source file. */
  offset: number;
  binding?: string;
}

/** gql`…`, graphql`…`, gql(`…`) and /* GraphQL *\/ `…` literals. ${…} interpolations are blanked out. */
export function extractGqlLiterals(source: string): GqlLiteral[] {
  const out: GqlLiteral[] = [];
  const re = /(?:\b(?:gql|graphql)\s*\(?\s*|\/\*\s*GraphQL\s*\*\/\s*)`/g;
  for (const m of source.matchAll(re)) {
    const start = m.index! + m[0].length;
    let i = start;
    let body = "";
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") {
        body += "  ";
        i += 2;
        continue;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        let depth = 0;
        while (i < source.length) {
          const c = source[i]!;
          body += c === "\n" ? "\n" : " ";
          i++;
          if (c === "{") depth++;
          else if (c === "}" && --depth === 0) break;
        }
        continue;
      }
      body += source[i];
      i++;
    }
    const before = source.slice(Math.max(0, m.index! - 160), m.index!);
    const binding = before.match(/\b([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>.\[\]]+\s*)?=\s*$/)?.[1];
    out.push({ body, offset: start, binding });
  }
  return out;
}

// ---------------------------------------------------------------- tokenizer

interface Tok {
  t: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      i = end < 0 ? src.length : end + 3;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const s = i;
      while (i < src.length && /\w/.test(src[i]!)) i++;
      toks.push({ t: src.slice(s, i), pos: s });
    } else if (src.startsWith("...", i)) {
      toks.push({ t: "...", pos: i });
      i += 3;
    } else if ("{}():@$!=[]|&".includes(c)) {
      toks.push({ t: c, pos: i });
      i++;
    } else i++;
  }
  return toks;
}

const isName = (t?: Tok) => !!t && /^[A-Za-z_]\w*$/.test(t.t);

/** Skip a balanced (...) group starting at toks[i] === "(". Returns index after it. */
function skipParens(toks: Tok[], i: number): number {
  let depth = 0;
  for (; i < toks.length; i++) {
    if (toks[i]!.t === "(") depth++;
    else if (toks[i]!.t === ")" && --depth === 0) return i + 1;
  }
  return i;
}

function skipDirectives(toks: Tok[], i: number): number {
  while (toks[i]?.t === "@" && isName(toks[i + 1])) {
    i += 2;
    if (toks[i]?.t === "(") i = skipParens(toks, i);
  }
  return i;
}

/** Parse a selection set at toks[i] === "{". Collects depth-1 field names into `top` and all into `all`. */
function parseSelection(toks: Tok[], i: number, top: string[] | null, all: Set<string>): number {
  i++; // past "{"
  while (i < toks.length && toks[i]!.t !== "}") {
    const tk = toks[i]!;
    if (tk.t === "...") {
      i++;
      if (toks[i]?.t === "on") i += 2; // inline fragment type condition
      else if (isName(toks[i]) && toks[i + 1]?.t !== "{") {
        i++; // named spread
        i = skipDirectives(toks, i);
        continue;
      }
      i = skipDirectives(toks, i);
      if (toks[i]?.t === "{") i = parseSelection(toks, i, top, all); // inline fragment fields count at this level
      continue;
    }
    if (isName(tk)) {
      let name = tk.t;
      i++;
      if (toks[i]?.t === ":" && isName(toks[i + 1])) {
        name = toks[i + 1]!.t; // alias: field
        i += 2;
      }
      if (toks[i]?.t === "(") i = skipParens(toks, i);
      i = skipDirectives(toks, i);
      top?.push(name);
      all.add(name);
      if (toks[i]?.t === "{") i = parseSelection(toks, i, null, all);
      continue;
    }
    i++;
  }
  return i + 1;
}

// ---------------------------------------------------------------- documents

export interface ParsedDocument {
  operations: { kind: RootKind; name: string; pos: number; rootFields: string[]; fields: string[] }[];
  rootFields: { kind: RootKind; field: string; pos: number }[];
}

/** Parse an executable and/or SDL GraphQL document. Tolerant: unknown constructs are skipped. */
export function parseGraphql(src: string): ParsedDocument {
  const toks = tokenize(src);
  const doc: ParsedDocument = { operations: [], rootFields: [] };
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i]!;
    const kind = OP_KIND[tk.t];
    if (kind && (isName(toks[i + 1]) || ["{", "(", "@"].includes(toks[i + 1]?.t ?? ""))) {
      // operation definition — but not `query: Query` inside `schema { … }`
      if (toks[i + 1]?.t === ":") {
        i++;
        continue;
      }
      let j = i + 1;
      let name = "(anonymous)";
      if (isName(toks[j])) name = toks[j++]!.t;
      if (toks[j]?.t === "(") j = skipParens(toks, j);
      j = skipDirectives(toks, j);
      if (toks[j]?.t !== "{") {
        i++;
        continue;
      }
      const top: string[] = [];
      const all = new Set<string>();
      i = parseSelection(toks, j, top, all);
      doc.operations.push({ kind, name, pos: tk.pos, rootFields: [...new Set(top)], fields: [...all] });
      continue;
    }
    if (tk.t === "{" && (i === 0 || toks[i - 1]!.t === "}")) {
      // shorthand query `{ orders { id } }`
      const top: string[] = [];
      const all = new Set<string>();
      const start = tk.pos;
      i = parseSelection(toks, i, top, all);
      doc.operations.push({ kind: "Query", name: "(anonymous)", pos: start, rootFields: top, fields: [...all] });
      continue;
    }
    if (tk.t === "fragment" && isName(toks[i + 1]) && toks[i + 2]?.t === "on") {
      // Skip fragment bodies so their fields aren't mistaken for a shorthand query.
      const j = skipDirectives(toks, i + 4);
      if (toks[j]?.t === "{") {
        i = parseSelection(toks, j, null, new Set());
        continue;
      }
    }
    if (tk.t === "type" && ROOT_TYPES.has(toks[i + 1]?.t ?? "")) {
      const rk = toks[i + 1]!.t as RootKind;
      let j = i + 2;
      while (j < toks.length && toks[j]!.t !== "{" && toks[j]!.t !== "}") {
        if (toks[j]!.t === "(") j = skipParens(toks, j);
        else j++;
      }
      if (toks[j]?.t !== "{") {
        i = j;
        continue;
      }
      j++;
      let depth = 1;
      while (j < toks.length && depth > 0) {
        const t = toks[j]!;
        if (t.t === "{") depth++;
        else if (t.t === "}") depth--;
        else if (t.t === "(") {
          j = skipParens(toks, j);
          continue;
        } else if (depth === 1 && isName(t) && toks[j - 1]?.t !== "@" && (toks[j + 1]?.t === ":" || toks[j + 1]?.t === "(")) {
          doc.rootFields.push({ kind: rk, field: t.t, pos: t.pos });
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return doc;
}

// ---------------------------------------------------------------- resolvers in code

/** Index of the matching close brace for the "{" at `open`, skipping JS/C#/Go string literals and comments. */
export function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) return src.length;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return src.length;
}

/** Positions inside src[open+1, close) that are at brace/paren/bracket depth 0 relative to the block. */
function depthOnePositions(src: string, open: number, close: number): Set<number> {
  const ok = new Set<number>();
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < close && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? close : nl;
      continue;
    }
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
    else if (depth === 0) ok.add(i);
  }
  return ok;
}

/** JS/TS resolver maps: `Query: { orders: …, async order(…) {…}, user() {…} }` (also `Mutation`, `Subscription`). */
export function jsResolverFields(src: string): { kind: RootKind; field: string; pos: number }[] {
  const out: { kind: RootKind; field: string; pos: number }[] = [];
  for (const m of src.matchAll(/\b(Query|Mutation|Subscription)\s*:\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(src, open);
    const ok = depthOnePositions(src, open, close);
    const block = src.slice(open + 1, close);
    for (const k of block.matchAll(/(^|[{,\n])\s*(?:async\s+)?\*?\s*(?:["']?)([A-Za-z_$][\w$]*)(?:["']?)\s*(?=[:(])/g)) {
      const pos = open + 1 + k.index! + k[0].indexOf(k[2]!);
      if (ok.has(pos)) out.push({ kind: m[1] as RootKind, field: k[2]!, pos });
    }
  }
  return out;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Go gqlgen: `func (r *queryResolver) Orders(ctx context.Context, …)` → Query.orders. */
export function goResolverFields(src: string): { kind: RootKind; field: string; pos: number }[] {
  const out: { kind: RootKind; field: string; pos: number }[] = [];
  for (const m of src.matchAll(/func\s*\(\s*\w+\s+\*(query|mutation|subscription)Resolver\s*\)\s*(\w+)\s*\(/g)) {
    out.push({ kind: OP_KIND[m[1]!]!, field: lowerFirst(m[2]!), pos: m.index! });
  }
  return out;
}

/** Hot Chocolate naming: GetOrdersAsync → orders. */
export function hotChocolateFieldName(method: string): string {
  return lowerFirst(method.replace(/Async$/, "").replace(/^Get(?=[A-Z])/, ""));
}

/** .NET Hot Chocolate: methods of [QueryType] / [ExtendObjectType("Query")] / `class Query` classes. */
export function csResolverFields(src: string): { kind: RootKind; field: string; pos: number }[] {
  const out: { kind: RootKind; field: string; pos: number }[] = [];
  const classRe =
    /(?:\[(Query|Mutation|Subscription)Type\][\s\S]{0,200}?|\[ExtendObjectType\(\s*(?:typeof\(\s*|OperationTypeNames\.|nameof\(\s*|")?(Query|Mutation|Subscription)\b[^\]]*\][\s\S]{0,200}?)?\bclass\s+(\w+)[^{]*\{/g;
  for (const m of src.matchAll(classRe)) {
    const kind = (m[1] ?? m[2] ?? (ROOT_TYPES.has(m[3]!) ? m[3] : null)) as RootKind | null;
    if (!kind) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(src, open);
    const ok = depthOnePositions(src, open, close);
    const block = src.slice(open + 1, close);
    const methodRe = /\bpublic\s+(?:(?:static|async|virtual|override)\s+)*[\w<>\[\],.?\s]+?\s+([A-Z]\w*)\s*(?:<[^>]*>)?\s*\(/g;
    for (const mm of block.matchAll(methodRe)) {
      const pos = open + 1 + mm.index!;
      if (!ok.has(pos)) continue;
      out.push({ kind, field: hotChocolateFieldName(mm[1]!), pos: open + 1 + mm.index! + mm[0].indexOf(mm[1]!) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- per-file scan

const GRAPHQL_FILE = /\.(graphql|graphqls|gql)$/;
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export function scanGraphql(file: string, text: string): { operations: GqlOperation[]; fields: GqlField[] } {
  const operations: GqlOperation[] = [];
  const fields: GqlField[] = [];
  const addDoc = (body: string, offset: number, binding?: string) => {
    const d = parseGraphql(body);
    for (const o of d.operations)
      operations.push({ file, line: lineAt(text, offset + o.pos), kind: o.kind, name: o.name, rootFields: o.rootFields, fields: o.fields, binding });
    for (const f of d.rootFields) fields.push({ file, line: lineAt(text, offset + f.pos), kind: f.kind, field: f.field, source: "sdl" });
  };
  if (GRAPHQL_FILE.test(file)) addDoc(text, 0);
  else if (JS_FILE.test(file)) {
    for (const lit of extractGqlLiterals(text)) addDoc(lit.body, lit.offset, lit.binding);
    for (const r of jsResolverFields(text)) fields.push({ file, line: lineAt(text, r.pos), kind: r.kind, field: r.field, source: "resolver" });
  } else if (file.endsWith(".go")) {
    for (const r of goResolverFields(text)) fields.push({ file, line: lineAt(text, r.pos), kind: r.kind, field: r.field, source: "resolver" });
  } else if (file.endsWith(".cs")) {
    for (const r of csResolverFields(text)) fields.push({ file, line: lineAt(text, r.pos), kind: r.kind, field: r.field, source: "resolver" });
  }
  return { operations, fields };
}
