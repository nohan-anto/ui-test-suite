import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config/load.ts";
import { buildContext } from "../src/phases/context.ts";
import { normalisePath, pathsMatch, scanHttp } from "../src/repos/rest.ts";
import { fixtureFetch } from "../src/sources/fixtures.ts";
import { JiraClient } from "../src/sources/jira/client.ts";
import { makeGitRepo, type RepoChange } from "./helpers.ts";

const routes = (file: string, text: string) => scanHttp(file, text).routes.map((r) => `${r.method ?? "ANY"} ${r.path}`);
const calls = (file: string, text: string) => scanHttp(file, text).calls.map((c) => `${c.method ?? "ANY"} ${c.path}`);

describe("REST extraction", () => {
  test("ASP.NET controllers and minimal APIs", () => {
    const controller = `[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
  [HttpGet("{id}")]
  public Task<Order> Get(int id) => null;
  [HttpPost]
  public IActionResult Create() => Ok();
  [HttpDelete("/admin/orders/{id}")]
  public IActionResult Purge(int id) => Ok();
}`;
    expect(routes("OrdersController.cs", controller)).toEqual(["GET api/Orders/{id}", "POST api/Orders", "DELETE /admin/orders/{id}"]);
    const minimal = `var orders = app.MapGroup("/orders");\norders.MapGet("/{id:int}", (int id) => db.Find(id));\napp.MapPost("/payments", Pay);`;
    expect(routes("Program.cs", minimal)).toEqual(["GET /orders/{id:int}", "POST /payments"]);
    expect(calls("Client.cs", `var res = await _httpClient.GetAsync($"{_baseUrl}/customers/{id}");`)).toEqual(["GET {_baseUrl}/customers/{id}"]);
  });

  test("Go: gin groups, net/http 1.22 patterns, gorilla methods; client calls", () => {
    const src = `r := gin.Default()
api := r.Group("/api")
v1 := api.Group("/v1")
v1.GET("/orders/:id", getOrder)
mux.HandleFunc("POST /payments/{id}", pay)
m.HandleFunc("/users/{id}", user).Methods("PUT")
url := fmt.Sprintf("%s/customers/%s", c.baseURL, id)
resp, err := http.Get(c.base + "/inventory/" + sku)`;
    expect(routes("main.go", src)).toEqual(["GET /api/v1/orders/:id", "POST /payments/{id}", "PUT /users/{id}"]);
    expect(calls("main.go", src)).toEqual(["ANY %s/customers/%s", "GET /inventory/{p}"]);
  });

  test("Node: Express, NestJS, fetch/axios/RESTDataSource calls; imports and route lines are not calls", () => {
    const src = `import x from './a/b';
router.get('/orders/:id', handler);
const r = await fetch(\`\${ORDERS_URL}/orders/\${id}\`, { method: 'GET' });
class OrdersAPI extends RESTDataSource { getOrder(id) { return this.get(\`orders/\${encodeURIComponent(id)}\`); } }
const res = await api.post('/api/v1/checkout', body, { headers: { 'Content-Type': 'application/json' } });`;
    expect(routes("server.ts", src)).toEqual(["GET /orders/:id"]);
    expect(calls("server.ts", src)).toEqual(["GET ${ORDERS_URL}/orders/${id}", "GET orders/${encodeURIComponent(id)}", "POST /api/v1/checkout"]);
    const nest = `@Controller('orders')\nexport class OrdersController {\n  @Get(':id')\n  find() {}\n  @Post()\n  create() {}\n}`;
    expect(routes("orders.controller.ts", nest)).toEqual(["GET orders/:id", "POST orders"]);
  });

  test("Spring and FastAPI", () => {
    const spring = `@RestController\n@RequestMapping("/orders")\npublic class OrderController {\n  @GetMapping("/{id}")\n  public Order get() { return null; }\n}`;
    expect(routes("OrderController.java", spring)).toEqual(["GET /orders/{id}"]);
    expect(routes("app.py", `@router.get("/items/{item_id}")\nasync def read(item_id: int): ...`)).toEqual(["GET /items/{item_id}"]);
  });

  test("path matching ignores base paths and parameter syntax", () => {
    expect(normalisePath("{_baseUrl}/Customers/{id}?x=1")).toBe("/customers/*");
    expect(pathsMatch("${BASE}/orders/${id}", "api/[controller]/{id}".replace("[controller]", "orders"))).toBe(true);
    expect(pathsMatch("orders/${x}", "/api/v1/orders/:id")).toBe(true);
    expect(pathsMatch("/api/orders", "/api/users")).toBe(false);
    expect(pathsMatch("/{id}", "/x/{id}")).toBe(false); // no literal segment in common
    expect(pathsMatch("/api/orders/*", "/v1/orders/*")).toBe(false);
  });
});

let work: string;
const makeRepo = (name: string, files: Record<string, string>, change?: RepoChange) => makeGitRepo(work, name, files, change);

async function impactFor(repos: { name: string; path: string; role: string }[]) {
  const cfg = parseConfig(`
browser: { appBaseUrl: "https://app.example.com" }
jira: { baseUrl: "https://demo.atlassian.net", email: "a@b.c", token: "t" }
repos:
${repos.map((r) => `  - { name: ${r.name}, path: ${JSON.stringify(r.path)}, role: ${r.role} }`).join("\n")}
indexing: { cacheDir: ${JSON.stringify(join(work, `cache-${repos[0]!.name}`))} }
`);
  const ctxDir = join(work, `ctx-${repos[0]!.name}`);
  await buildContext(cfg, "DEMO-1", ctxDir, {
    jira: new JiraClient(cfg.jira.baseUrl, "a", "t", fixtureFetch(join(import.meta.dir, "fixtures"), "jira")),
    gitlab: null,
    log: () => {},
  });
  return Bun.file(join(ctxDir, "impact.md")).text();
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "uitest-rest-"));
});
afterAll(() => {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
});

test("UI → GraphQL gateway → REST .NET downstream: a service change reaches the screen", async () => {
  const ui = await makeRepo("ui-a", {
    "src/graphql/orders.ts": "export const GET_ORDER = gql`\n  query GetOrder($id: ID!) {\n    order(id: $id) { id total }\n  }\n`;\n",
    "src/pages/orders/[id].tsx": "import { GET_ORDER } from '../../graphql/orders';\nexport default function Order() { useQuery(GET_ORDER); }\n",
  });
  const gateway = await makeRepo("gql-gateway", {
    "src/schema.graphql": "type Query {\n  order(id: ID!): Order\n}\n",
    "src/datasources/orders-api.ts": [
      "export class OrdersAPI extends RESTDataSource {",
      "  async getOrderById(id: string) {",
      "    return this.get(`orders/${encodeURIComponent(id)}`);",
      "  }",
      "}",
      "",
    ].join("\n"),
    "src/resolvers.ts": [
      "export const resolvers = {",
      "  Query: {",
      "    order: (_, { id }, { dataSources }) => dataSources.ordersApi.getOrderById(id),",
      "  },",
      "};",
      "",
    ].join("\n"),
  });
  const controller = [
    "[ApiController]",
    '[Route("api/[controller]")]',
    "public class OrdersController : ControllerBase",
    "{",
    '    [HttpGet("{id}")]',
    "    public async Task<OrderDto> GetById(string id)",
    "    {",
    "        return await _svc.LoadOrderAsync(id);",
    "    }",
    "",
    "    [HttpGet]",
    "    public IActionResult ListAll() { return Ok(); }",
    "}",
    "",
  ].join("\n");
  const service = (body: string) =>
    ["public class OrderService", "{", "    public async Task<OrderDto> LoadOrderAsync(string id)", "    {", "        var o = await _repo.Find(id);", body, "        return Map(o);", "    }", "}", ""].join("\n");
  const dotnet = await makeRepo(
    "orders-dotnet",
    { "Controllers/OrdersController.cs": controller, "Services/OrderService.cs": service("        // no discount") },
    { message: "DEMO-2 apply discount", files: { "Services/OrderService.cs": service("        o.Total = Discount(o);") } },
  );

  const impact = await impactFor([
    { name: "ui-a", path: ui, role: "ui" },
    { name: "gql-gateway", path: gateway, role: "gateway" },
    { name: "orders-dotnet", path: dotnet, role: "downstream" },
  ]);
  expect(impact).toContain("## REST impact chains");
  expect(impact).toContain("### GET api/Orders/{id} — changed in orders-dotnet: Controllers/OrdersController.cs:5 (downstream)");
  expect(impact).toContain("**Reached via:** `LoadOrderAsync()` (orders-dotnet: Services/OrderService.cs:3)");
  expect(impact).toContain("**Gateway:** `Query.order (resolver, calls GET orders/${encodeURIComponent(id)})` — gql-gateway: src/resolvers.ts:3");
  expect(impact).toContain("**UI:** `query GetOrder` — ui-a: src/graphql/orders.ts:2 → screens `/orders/:id`");
  expect(impact).not.toContain("ListAll");
  expect(impact).not.toContain("### GET api/Orders —");
}, 120_000);

test("all-REST: UI → Express BFF → Go downstream, plus a changed UI call", async () => {
  const ui = await makeRepo(
    "ui-b",
    {
      "src/api/orders.ts": "export const getOrder = (id) => api.get(`/api/orders/${id}`);\n",
      "src/api/payments.ts": "export const pay = (b) => api.post('/api/payments', b);\n",
      "src/pages/orders/[id].tsx": "import { getOrder } from '../../api/orders';\nexport default function O() { getOrder(1); }\n",
      "src/pages/checkout.tsx": "import { pay } from '../api/payments';\nexport default function C() { pay({}); }\n",
    },
    { message: "DEMO-2 send idempotency key", files: { "src/api/payments.ts": "export const pay = (b) => api.post('/api/payments', b, { headers: { 'Idempotency-Key': k() } });\n" } },
  );
  const bff = await makeRepo("rest-bff", {
    "src/routes/orders.ts": [
      "router.get('/api/orders/:id', async (req, res) => {",
      "  const r = await fetch(`${ORDERS_URL}/v1/orders/${req.params.id}`);",
      "  res.json(await r.json());",
      "});",
      "router.post('/api/payments', async (req, res) => {",
      "  const r = await fetch(`${PAY_URL}/v1/payments`, { method: 'POST' });",
      "  res.json(await r.json());",
      "});",
      "",
    ].join("\n"),
  });
  const handler = (body: string) => ["package main", "", "func getOrder(c *gin.Context) {", '\tid := c.Param("id")', body, "}", ""].join("\n");
  const go = await makeRepo(
    "orders-go",
    {
      "main.go": ["package main", "", "func main() {", "\tr := gin.Default()", '\tv1 := r.Group("/v1")', '\tv1.GET("/orders/:id", getOrder)', '\tv1.POST("/payments", pay)', "}", ""].join("\n"),
      "handlers.go": handler("\tc.JSON(200, load(id))"),
    },
    { message: "DEMO-2 include currency", files: { "handlers.go": handler("\tc.JSON(200, withCurrency(load(id)))") } },
  );

  const impact = await impactFor([
    { name: "ui-b", path: ui, role: "ui" },
    { name: "rest-bff", path: bff, role: "gateway" },
    { name: "orders-go", path: go, role: "downstream" },
  ]);
  // Go handler change → its route → the BFF route calling it → the UI call → the screen
  expect(impact).toContain("### GET /v1/orders/:id — changed in orders-go: main.go:6 (downstream)");
  expect(impact).toContain("**Reached via:** `getOrder()` (orders-go: handlers.go:3)");
  expect(impact).toContain("**Gateway:** `GET /api/orders/:id (BFF route, calls ANY ${ORDERS_URL}/v1/orders/${req.params.id})` — rest-bff: src/routes/orders.ts:1");
  expect(impact).toContain("**UI:** `calls GET /api/orders/${id}` — ui-b: src/api/orders.ts:1 → screens `/orders/:id`");
  expect(impact).not.toContain("POST /v1/payments —");
  // UI change → the BFF endpoint it hits, on the screen that uses it
  expect(impact).toContain("### calls POST /api/payments — changed in ui-b: src/api/payments.ts:1 (ui)");
  expect(impact).toContain("**Gateway:** `POST /api/payments` — rest-bff: src/routes/orders.ts:5");
  expect(impact).toContain("**UI:** `calls POST /api/payments` — ui-b: src/api/payments.ts:1 → screens `/checkout`");
}, 120_000);
