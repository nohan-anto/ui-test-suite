import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig } from "../src/config/load.ts";
import { buildContext } from "../src/phases/context.ts";
import { parseFileDiff, parseMultiFileDiff, sdlFieldNamesInLines, touchedItems } from "../src/repos/diff.ts";
import { csResolverFields, goResolverFields, hotChocolateFieldName, jsResolverFields, parseGraphql, scanGraphql } from "../src/repos/graphql.ts";
import { fixtureFetch } from "../src/sources/fixtures.ts";
import { JiraClient } from "../src/sources/jira/client.ts";
import { exec } from "../src/util/index.ts";

describe("GraphQL parsing", () => {
  test("operations: aliases, args with objects, directives, fragments, inline fragments", () => {
    const d = parseGraphql(`
      query GetOrders($s: Status) {
        list: orders(filter: { status: $s }) @connection(key: "o") { id ...Bits ... on Order { status } }
        me { id }
      }
      fragment Bits on Order { total }
      mutation { updateAddress(input: { a: 1 }) { id } }
    `);
    expect(d.operations.map((o) => [o.kind, o.name, o.rootFields])).toEqual([
      ["Query", "GetOrders", ["orders", "me"]],
      ["Mutation", "(anonymous)", ["updateAddress"]],
    ]);
    expect(d.operations[0]!.fields).toContain("status");
  });
  test("SDL root fields, ignoring descriptions, directives and non-root types", () => {
    const d = parseGraphql(`
      """Root""" type Query @key(fields: "id") {
        "the orders" orders(first: Int = 10, filter: F): [Order!]! @deprecated(reason: "x")
        me: User
      }
      extend type Mutation { cancel(id: ID!): Boolean }
      type Order { query: String status: S }
      schema { query: Query }
    `);
    expect(d.rootFields.map((f) => `${f.kind}.${f.field}`)).toEqual(["Query.orders", "Query.me", "Mutation.cancel"]);
    expect(d.operations).toEqual([]);
  });
  test("JS resolver maps only take depth-1 keys", () => {
    const src = `export default { Query: { orders: async () => ({ nested: 1 }), me(_, a) { const x = { y: 1 }; } }, Order: { status: () => 1 } }`;
    expect(jsResolverFields(src).map((f) => f.field)).toEqual(["orders", "me"]);
  });
  test("Go gqlgen and .NET Hot Chocolate resolvers", () => {
    expect(goResolverFields("func (r *mutationResolver) CancelOrder(ctx context.Context) (bool, error) {")[0]).toMatchObject({ kind: "Mutation", field: "cancelOrder" });
    const cs = `[ExtendObjectType(OperationTypeNames.Query)]\npublic class OrderQueries {\n  public Task<Order> GetOrderByIdAsync(int id) { var o = new { A = 1 }; return null; }\n  private int X() => 1;\n}`;
    expect(csResolverFields(cs).map((f) => `${f.kind}.${f.field}`)).toEqual(["Query.orderById"]);
    expect(hotChocolateFieldName("Getaway")).toBe("getaway");
  });
  test("gql literal binding is captured", () => {
    const ops = scanGraphql("q.ts", "export const ORDERS_BY_CUSTOMER: DocumentNode = gql`query X { ordersByCustomer { id } }`;").operations;
    expect(ops[0]!.binding).toBe("ORDERS_BY_CUSTOMER");
  });
});

describe("diff helpers", () => {
  test("hunk ranges and touched items", () => {
    const c = parseFileDiff("@@ -10,2 +10,3 @@\n-a\n+b\n+c\n@@ -40 +41,0 @@\n-x\n");
    expect(c.ranges).toEqual([[10, 12], [41, 41]]);
    const items = [{ line: 1 }, { line: 9 }, { line: 20 }, { line: 41 }];
    expect(touchedItems(items, c.ranges as [number, number][])).toEqual([{ line: 9 }, { line: 41 }]);
    expect(parseFileDiff("").ranges).toBe("all");
  });
  test("multi-file diffs and SDL field names", () => {
    const m = parseMultiFileDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/s.graphql b/s.graphql\n+++ b/s.graphql\n@@ -3,0 +4 @@\n+  status: OrderStatus!\n");
    expect([...m.keys()]).toEqual(["x.ts", "s.graphql"]);
    expect(sdlFieldNamesInLines(m.get("s.graphql")!.added)).toEqual(["status"]);
  });
});

// ---------------------------------------------------------------- three-repo chain

let work: string;
async function makeRepo(name: string, files: Record<string, string>, change?: { files: Record<string, string>; message: string }) {
  const repo = join(work, name);
  const iso = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t"];
  const write = async (fs: Record<string, string>) => {
    for (const [p, c] of Object.entries(fs)) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      await Bun.write(join(repo, p), c);
    }
  };
  const git = (...a: string[]) => exec(["git", "-C", repo, ...iso, ...a], { timeoutMs: 30_000 });
  mkdirSync(repo, { recursive: true });
  await git("init", "-q");
  await write(files);
  await git("add", ".");
  await git("commit", "-q", "--no-verify", "-m", "initial");
  if (change) {
    await write(change.files);
    await git("add", ".");
    await git("commit", "-q", "--no-verify", "-m", change.message);
  }
  return repo;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "uitest-gql-"));
});
afterAll(() => {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
});

test("downstream subgraph change is traced through the gateway to UI screens", async () => {
  const ui = await makeRepo("web-ui", {
    "src/graphql/orders.ts": "import { gql } from '@apollo/client';\nexport const GET_ORDERS = gql`\n  query GetOrders {\n    customerOrders { id status }\n  }\n`;\n",
    "src/pages/orders/index.tsx": "import { GET_ORDERS } from '../../graphql/orders';\nexport default function Orders() { useQuery(GET_ORDERS); }\n",
    "src/graphql/profile.ts": "export const ME = gql`query Me { me { id } }`;\n",
  });
  const gateway = await makeRepo("bff", {
    "src/schema.graphql": "type Query {\n  customerOrders: [Order!]!\n  me: User\n}\n",
    "src/subgraph-queries.ts": "export const ORDERS_BY_CUSTOMER = gql`query OBC($id: ID!) { ordersByCustomer(customerId: $id) { id status } }`;\n",
    "src/resolvers.ts": [
      "import { ORDERS_BY_CUSTOMER } from './subgraph-queries';",
      "export const resolvers = {",
      "  Query: {",
      "    me: (_, __, ctx) => ctx.user,",
      "    customerOrders: async (_, __, ctx) => {",
      "      return ctx.orders.request(ORDERS_BY_CUSTOMER, { id: ctx.user.id });",
      "    },",
      "  },",
      "};",
      "",
    ].join("\n"),
  });
  const goSub = await makeRepo(
    "orders-go",
    {
      "graph/schema.graphqls": "type Query {\n  ordersByCustomer(customerId: ID!): [Order!]!\n  order(id: ID!): Order\n}\n\ntype Order {\n  id: ID!\n}\n",
      "graph/schema.resolvers.go": "package graph\n\nfunc (r *queryResolver) Order(ctx context.Context, id string) (*model.Order, error) {\n\treturn nil, nil\n}\n\nfunc (r *queryResolver) OrdersByCustomer(ctx context.Context, customerID string) ([]*model.Order, error) {\n\treturn nil, nil\n}\n",
    },
    {
      message: "DEMO-2 add order status",
      files: {
        "graph/schema.graphqls": "type Query {\n  ordersByCustomer(customerId: ID!): [Order!]!\n  order(id: ID!): Order\n}\n\ntype Order {\n  id: ID!\n  status: OrderStatus!\n}\n",
        "graph/schema.resolvers.go": "package graph\n\nfunc (r *queryResolver) Order(ctx context.Context, id string) (*model.Order, error) {\n\treturn nil, nil\n}\n\nfunc (r *queryResolver) OrdersByCustomer(ctx context.Context, customerID string) ([]*model.Order, error) {\n\tfilterByStatus()\n\treturn nil, nil\n}\n",
      },
    },
  );
  const netSub = await makeRepo("users-dotnet", {
    "Users/Queries.cs": "[QueryType]\npublic static class UserQueries\n{\n    public static User GetMe() => null;\n}\n",
  });

  const cfg = parseConfig(`
browser: { appBaseUrl: "https://app.example.com" }
jira: { baseUrl: "https://demo.atlassian.net", email: "a@b.c", token: "t" }
repos:
  - { name: web-ui, path: ${JSON.stringify(ui)}, role: ui }
  - { name: bff, path: ${JSON.stringify(gateway)}, role: gateway }
  - { name: orders-go, path: ${JSON.stringify(goSub)}, role: downstream }
  - { name: users-dotnet, path: ${JSON.stringify(netSub)}, role: downstream }
indexing: { cacheDir: ${JSON.stringify(join(work, "cache"))} }
`);
  const ctxDir = join(work, "ctx");
  await buildContext(cfg, "DEMO-1", ctxDir, {
    jira: new JiraClient(cfg.jira.baseUrl, "a", "t", fixtureFetch(join(import.meta.dir, "fixtures"), "jira")),
    gitlab: null,
    log: () => {},
  });
  const impact = await Bun.file(join(ctxDir, "impact.md")).text();

  // The Go resolver body for ordersByCustomer changed (not `order`, thanks to line ranges)
  expect(impact).toContain("### Query.ordersByCustomer (resolver) — changed in orders-go: graph/schema.resolvers.go");
  expect(impact).not.toContain("### Query.order (resolver)");
  // → gateway resolver that sends the subgraph query (found via the imported ORDERS_BY_CUSTOMER binding)
  expect(impact).toMatch(/\*\*Gateway:\*\* `Query\.customerOrders \(resolver, sends query OBC\)` — bff: src\/resolvers\.ts:5/);
  // → UI operation and the screen that renders it
  expect(impact).toContain("**UI:** `query GetOrders` — web-ui: src/graphql/orders.ts:3 → screens `/orders`");
  expect(impact).not.toContain("query Me");
  // Non-root SDL change: new Order.status field is selected by the UI query
  expect(impact).toContain("`status` (orders-go: graph/schema.graphqls) → `query GetOrders`");
  // Index summaries show the .NET subgraph's Hot Chocolate field
  expect(await Bun.file(join(ctxDir, "repos", "users-dotnet.md")).text()).toContain("`Query.me` — Users/Queries.cs:4 (resolver)");
}, 120_000);
