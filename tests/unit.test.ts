import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/agents/claude.ts";
import { CodexAdapter } from "../src/agents/codex.ts";
import { CopilotAdapter } from "../src/agents/copilot.ts";
import { extractJson, parseAgentJson } from "../src/agents/json-extract.ts";
import type { AgentRequest } from "../src/agents/types.ts";
import { renderReport, summarise, type CaseResult } from "../src/artifacts/report.ts";
import { parseTestCases, renderTestCases } from "../src/artifacts/testcases.ts";
import { chromeArgs, chromeCandidates } from "../src/browser/launch.ts";
import { pickTab, signInProblem } from "../src/browser/preflight.ts";
import { interpolateEnv, parseConfig } from "../src/config/load.ts";
import { toCodexOverrides, toMcpJson } from "../src/mcp/servers.ts";
import { PlanReplySchema, type TestCase } from "../src/phases/protocol.ts";
import { normaliseEndpoint } from "../src/repos/impact.ts";
import { fileBasedRoute, scanSource } from "../src/repos/indexer.ts";
import { extractMrRefs, extractShortMrRefs, sameProject } from "../src/sources/gitlab/collect.ts";
import { adfToMarkdown } from "../src/sources/jira/adf-to-md.ts";

const minimalConfig = `
browser: { appBaseUrl: https://app.example.com, tabMatch: app.example.com }
jira: { baseUrl: https://x.atlassian.net, email: a@b.c, token: "\${T}" }
`;

describe("config", () => {
  test("interpolates env and applies defaults", () => {
    const cfg = parseConfig(minimalConfig, { T: "secret-token" });
    expect(cfg.jira.token).toBe("secret-token");
    expect(cfg.agent.provider).toBe("copilot");
    expect(cfg.browser.loggedInCheck.notUrlContains).toEqual(["onelogin.com"]);
    expect(cfg.gitlab.baseUrl).toBe("https://gitlab.com");
  });
  test("missing env var becomes empty string", () => {
    expect(interpolateEnv({ a: "${NOPE}" }, {})).toEqual({ a: "" });
  });
});

describe("ADF → Markdown", () => {
  test("paragraphs, marks, lists, code", () => {
    const md = adfToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "AC" }] },
        { type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "strong" }] }, { type: "text", text: " and " }, { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x" } }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let a = 1" }] },
      ],
    });
    expect(md).toContain("### AC");
    expect(md).toContain("**bold** and [link](https://x)");
    expect(md).toContain("- one");
    expect(md).toContain("```ts\nlet a = 1\n```");
  });
  test("tables", () => {
    const cell = (t: string) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
    const md = adfToMarkdown({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [cell("h1"), cell("h2")] }, { type: "tableRow", content: [cell("a"), cell("b")] }] }] });
    expect(md).toBe("| h1 | h2 |\n| --- | --- |\n| a | b |");
  });
});

describe("MR link extraction", () => {
  test("full URLs with nested groups, deduped", () => {
    const text = "see https://gitlab.com/a/b/c/-/merge_requests/12 and https://gitlab.com/a/b/c/-/merge_requests/12#note_1, https://gitlab.com/x/y/-/merge_requests/3/diffs";
    expect(extractMrRefs(text, "https://gitlab.com")).toEqual([{ project: "a/b/c", iid: 12 }, { project: "x/y", iid: 3 }]);
  });
  test("nested groups: case-insensitive matching and dedupe", () => {
    const text = "https://gitlab.com/Platform/Web/web-ui/-/merge_requests/7 and https://gitlab.com/platform/web/web-ui/-/merge_requests/7";
    expect(extractMrRefs(text, "https://gitlab.com")).toEqual([{ project: "Platform/Web/web-ui", iid: 7 }]);
    expect(sameProject("Platform/Web/web-ui", "platform/web/web-ui/")).toBe(true);
    expect(sameProject("platform/web/web-ui.git", "platform/web/web-ui")).toBe(true);
    expect(sameProject("platform/web/web-ui", "platform/web-ui")).toBe(false);
  });
  test("ignores other hosts", () => {
    expect(extractMrRefs("https://gitlab.example.org/a/b/-/merge_requests/1", "https://gitlab.com")).toEqual([]);
  });
  test("short refs", () => {
    expect(extractShortMrRefs("fixed in group/web-ui!42.")).toEqual([{ project: "group/web-ui", iid: 42 }]);
  });
});

const sampleCases: TestCase[] = [
  { id: "TC-001", title: "Add address", priority: "P1", tracesTo: ["AC-1", "DEMO-2"], tags: ["destructive"], preconditions: ["Signed in"], testData: [], steps: ["Open profile", "Click **Add address**"], expected: ["Form opens"] },
  { id: "TC-002", title: "Bad postcode", priority: "P2", tracesTo: [], tags: [], preconditions: [], testData: ["Postcode: 123"], steps: ["Type 123"], expected: ["Error shown", "Save disabled"] },
];

describe("test-cases.md", () => {
  test("render → parse round-trip", () => {
    const md = renderTestCases({ ticket: "DEMO-1", title: "Addresses", summary: "Summary text", cases: sampleCases });
    const doc = parseTestCases(md);
    expect(doc.ticket).toBe("DEMO-1");
    expect(doc.summary).toBe("Summary text");
    expect(doc.cases).toEqual(sampleCases);
  });
  test("hand edits are picked up", () => {
    const md = renderTestCases({ ticket: "DEMO-1", title: "A", summary: "", cases: sampleCases }).replace("1. Type 123", "1. Type 123\n2. Press Tab");
    expect(parseTestCases(md).cases[1]!.steps).toEqual(["Type 123", "Press Tab"]);
  });
  test("invalid case is reported", () => {
    const md = renderTestCases({ ticket: "D-1", title: "A", summary: "", cases: [sampleCases[1]!] }).replace("1. Type 123", "- _none_");
    expect(() => parseTestCases(md)).toThrow(/TC-002: steps/);
  });
});

describe("report", () => {
  const results: CaseResult[] = [
    { testCase: sampleCases[0]!, reply: { id: "TC-001", status: "pass", steps: [{ n: 1, actual: "ok", ok: true }], notes: "", consoleErrors: [], failedRequests: [], evidence: ["TC-001-step2.png"], questions: [] }, durationMs: 1200 },
    { testCase: sampleCases[1]!, reply: { id: "TC-002", status: "fail", steps: [{ n: 1, actual: "no error", ok: false }], notes: "bug", consoleErrors: ["TypeError"], failedRequests: ["POST /api/x → 500"], evidence: [], questions: [] }, durationMs: 3000 },
  ];
  test("summary counts and failure detail", () => {
    expect(summarise(results)).toEqual({ pass: 1, fail: 1, blocked: 0, skipped: 0 });
    const md = renderReport({ ticket: "DEMO-1", title: "A", environment: "https://app", agent: "mock", startedAt: "s", finishedAt: "f", mergeRequests: [], repos: [] }, results);
    expect(md).toContain("**Result: FAILED** · 1 passed · 1 failed");
    expect(md).toContain("| 1 | Type 123 | no error |");
    expect(md).toContain("![TC-001-step2.png](evidence/TC-001-step2.png)");
    expect(md).toContain("| AC-1 | TC-001 | ✅ pass |");
    expect(md).toContain("| (untraced) | TC-002 | ❌ fail |");
  });
});

describe("agent JSON parsing", () => {
  test("takes the last valid fenced block", () => {
    expect(extractJson('x ```json\n{"a":1}\n``` y ```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  test("falls back to bare object", () => {
    expect(extractJson('Result: {"a": {"b": 1}} done')).toEqual({ a: { b: 1 } });
  });
  test("schema errors are readable", () => {
    const r = parseAgentJson('```json\n{"testCases":[{"id":"bad"}]}\n```', PlanReplySchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("testCases.0.id");
  });
});

const TMP = join("tmp", "x");
const req: AgentRequest = {
  prompt: "PROMPT",
  systemPrompt: "SYSTEM",
  mcpServers: [{ name: "chrome-devtools", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], env: {}, headers: {} }],
  workDirs: ["/run", "/repo/a"],
  mode: "plan",
  timeoutMs: 1000,
  model: "m1",
};

describe("adapters build the right command lines", () => {
  test("claude", () => {
    const inv = new ClaudeAdapter().buildInvocation(req, TMP);
    expect(inv.cmd.slice(0, 4)).toEqual(["claude", "-p", "--output-format", "json"]);
    expect(inv.cmd).toContain("--strict-mcp-config");
    expect(inv.cmd.join(" ")).toContain("--allowedTools Read,Grep,Glob,mcp__chrome-devtools");
    expect(inv.cmd.join(" ")).toContain("--add-dir /repo/a");
    expect(inv.cmd).not.toContain("/run"); // cwd, not --add-dir
    expect(inv.stdin).toBe("PROMPT");
    expect(inv.files[join(TMP, "system-prompt.md")]).toBe("SYSTEM");
    expect(JSON.parse(inv.files[join(TMP, "mcp.json")]!).mcpServers["chrome-devtools"].command).toBe("npx");
  });
  test("codex", () => {
    const inv = new CodexAdapter().buildInvocation(req, TMP);
    expect(inv.cmd.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(inv.cmd.join(" ")).toContain("--sandbox read-only --cd /run");
    expect(inv.cmd).toContain('mcp_servers.chrome-devtools.command="npx"');
    expect(inv.cmd.at(-1)).toBe("-");
    expect(inv.stdin).toStartWith("SYSTEM");
    expect(inv.outputFile).toBe(join(TMP, "last-message.txt"));
  });
  test("copilot", () => {
    const inv = new CopilotAdapter().buildInvocation(req, TMP);
    expect(inv.cmd[1]).toBe("-p");
    expect(inv.cmd.join(" ")).toContain(`--additional-mcp-config @${join(TMP, "mcp.json")}`);
    expect(inv.cmd[2]).toContain(join(TMP, "task.md"));
    expect(inv.files[join(TMP, "task.md")]).toStartWith("SYSTEM");
    expect(inv.cmd.join(" ")).toContain("--allow-tool chrome-devtools");
    expect(inv.cmd.join(" ")).toContain("--deny-tool write");
    expect(JSON.parse(inv.files[join(TMP, "mcp.json")]!).mcpServers["chrome-devtools"].type).toBe("local");
  });
  test("mcp translations", () => {
    expect(toMcpJson([{ name: "r", url: "https://r", args: [], env: {}, headers: {} }], "claude").mcpServers.r.type).toBe("http");
    expect(toCodexOverrides([{ name: "r", url: "https://r", args: [], env: {}, headers: {} }])).toEqual(["-c", 'mcp_servers.r.url="https://r"']);
  });
});

describe("indexer", () => {
  test("file-based routes", () => {
    expect(fileBasedRoute("pages/orders/[id].tsx")).toBe("/orders/:id");
    expect(fileBasedRoute("src/app/(shop)/cart/page.tsx")).toBe("/cart");
    expect(fileBasedRoute("app/layout.tsx")).toBeNull();
    expect(fileBasedRoute("pages/index.tsx")).toBe("/");
    expect(fileBasedRoute("pages/api/x.ts")).toBeNull();
  });
  test("scans routes, endpoints, flags", () => {
    const src = `
      <Route path="/profile/addresses" element={<A/>} />
      const routes = [{ path: 'orders/:id', component: X }];
      fetch("/api/v1/addresses/" + id);
      if (isEnabled("address-v2")) {}
      import x from "./config.json"; const c = { path: "./config.json" };
    `;
    const s = scanSource("src/App.tsx", src);
    expect(s.routes.map((r) => r.path)).toEqual(["/profile/addresses", "orders/:id"]);
    expect(s.routes[0]!.line).toBe(2);
    expect(s.apiEndpoints.map((a) => a.name)).toEqual(["/api/v1/addresses/"]);
    expect(s.featureFlags.map((f) => f.name)).toEqual(["address-v2"]);
  });
  test("endpoint normalisation", () => {
    expect(normaliseEndpoint("/api/orders/{id}")).toBe(normaliseEndpoint("/api/orders/:orderId"));
    expect(normaliseEndpoint("/api/orders/${id}/")).toBe("/api/orders/*");
  });
});

describe("browser preflight helpers", () => {
  const cfg = parseConfig(minimalConfig, { T: "x" }).browser;
  test("picks the matching page tab and detects SSO page", () => {
    const tabs = [
      { id: "1", type: "service_worker", title: "", url: "https://app.example.com/sw.js" },
      { id: "2", type: "page", title: "Mail", url: "https://mail.example.org" },
      { id: "3", type: "page", title: "App", url: "https://app.example.com/home" },
    ];
    expect(pickTab(tabs, cfg)?.id).toBe("3");
    expect(signInProblem({ id: "4", type: "page", title: "", url: "https://acme.onelogin.com/login" }, cfg)).toContain("Sign in");
    expect(signInProblem(tabs[2]!, cfg)).toBeNull();
  });
});

describe("chrome launch", () => {
  test("finds Chrome per OS", () => {
    const win = chromeCandidates("win32", { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(win).toHaveLength(2);
    expect(win.every((c) => c.endsWith("chrome.exe"))).toBe(true);
    expect(chromeCandidates("darwin")[0]).toContain("Google Chrome.app");
    expect(chromeCandidates("linux")).toContain("google-chrome");
  });

  test("uses the configured port, expanded profile dir and app URL", () => {
    const cfg = parseConfig(minimalConfig.replace("browser: {", "browser: { browserUrl: \"http://127.0.0.1:9333\","), { T: "x" }).browser;
    const args = chromeArgs(cfg);
    expect(args[0]).toBe("--remote-debugging-port=9333");
    expect(args[1]).toMatch(/^--user-data-dir=.*\.uitest-chrome$/);
    expect(args[1]).not.toContain("~");
    expect(args.at(-1)).toBe(cfg.appBaseUrl);
  });
});

describe("docs", () => {
  test("docs/PROJECT.md header version matches package.json", async () => {
    const root = join(import.meta.dir, "..");
    const pkg = await Bun.file(join(root, "package.json")).json();
    const doc = await Bun.file(join(root, "docs", "PROJECT.md")).text();
    const header = doc.match(/\| App version \|[^\n]*\n\|[^\n]*\n\| ([^|]+?) \|/);
    expect(header?.[1]).toBe(pkg.version);
  });
});
