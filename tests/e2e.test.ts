import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter } from "../src/agents/mock.ts";
import { parseConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { runPlan } from "../src/phases/plan.ts";
import { runPublish } from "../src/phases/publish.ts";
import { regenerateReport, runTests } from "../src/phases/test.ts";
import { ScriptedAsker } from "../src/qa/interactive.ts";
import { fixtureFetch } from "../src/sources/fixtures.ts";
import { GitLabClient } from "../src/sources/gitlab/client.ts";
import { JiraClient } from "../src/sources/jira/client.ts";
import { exec } from "../src/util/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
let work: string;
let cfg: Config;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "uitest-e2e-"));
  const repo = join(work, "web-ui");
  mkdirSync(join(repo, "src/components"), { recursive: true });
  mkdirSync(join(repo, "src/pages/profile"), { recursive: true });
  await Bun.write(join(repo, "src/components/AddressForm.tsx"), `export function AddressForm() { return fetch("/api/v1/addresses"); }\n`);
  await Bun.write(join(repo, "src/pages/profile/addresses.tsx"), `import { AddressForm } from "../../components/AddressForm";\nexport default AddressForm;\n`);
  // Neutralise global git config that can block or prompt (commit signing, hooks, autocrlf rewrites).
  const isolated = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t"];
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "--no-verify", "-m", "DEMO-2 add AddressForm"]]) {
    const r = await exec(["git", "-C", repo, ...isolated, ...args], { timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}${r.timedOut ? ", timed out" : ""}): ${r.stderr}`);
  }
  cfg = parseConfig(`
agent: { provider: mock }
browser: { appBaseUrl: "https://app.example.com" }
jira: { baseUrl: "https://demo.atlassian.net", email: "a@b.c", token: "jira-secret-123" }
gitlab: { token: "gl-secret-456" }
repos:
  - { name: web-ui, path: ${JSON.stringify(repo)}, role: ui, gitlabProject: demo/web-ui }
indexing: { cacheDir: ${JSON.stringify(join(work, "cache"))} }
output: { dir: ${JSON.stringify(join(work, "runs"))} }
`, {}); // empty env: tests must not pick up the developer's .env (e.g. UITEST_SHOW_USAGE)
}, 60_000); // git on Windows (antivirus, credential helpers) can be slow

afterAll(() => {
  // Windows can briefly keep handles open on files a child process touched; retry, and never fail the suite on cleanup.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${work}: ${(e as Error).message}`);
  }
});

test("plan → test → report, fully offline", async () => {
  const agent = new MockAdapter();
  const asker = new ScriptedAsker({ Q1: "Standard user" });
  const deps = {
    jira: new JiraClient(cfg.jira.baseUrl, cfg.jira.email, cfg.jira.token, fixtureFetch(FIXTURES, "jira")),
    gitlab: new GitLabClient(cfg.gitlab.baseUrl, cfg.gitlab.token, fixtureFetch(FIXTURES, "gitlab")),
    log: () => {},
  };

  const plan = await runPlan(cfg, { ticket: "DEMO-1", runId: "r1", agent, asker, deps });

  // context bundle
  expect(plan.manifest.isEpic).toBe(true);
  expect(plan.manifest.children).toEqual(["DEMO-2"]);
  expect(plan.manifest.mergeRequests.map((m) => m.ref)).toEqual(["demo/web-ui!7"]);
  const story = await Bun.file(join(plan.paths.contextDir, "story.md")).text();
  expect(story).toContain("## Acceptance Criteria");
  expect(story).toContain("1. User can add a new address");
  const impact = await Bun.file(join(plan.paths.contextDir, "impact.md")).text();
  expect(impact).toContain("src/components/AddressForm.tsx");
  expect(impact).toContain("`/profile/addresses`"); // reached via importer page
  expect(impact).toContain("not fetched locally"); // MR sha doesn't exist in the temp repo
  // secrets never land in the bundle or prompts
  for (const call of agent.calls) expect(call.prompt).not.toContain("jira-secret-123");

  // Q&A loop
  expect(asker.asked.map((q) => q.id)).toEqual(["Q1"]);
  expect(agent.calls).toHaveLength(2);
  expect(agent.calls[1]!.prompt).toContain("**Q1** (Which user role should the scenarios run as?): Standard user");
  expect(agent.calls[0]!.workDirs).toContain(cfg.repos[0]!.path);
  expect(await Bun.file(plan.paths.questions).text()).toContain("**Answer:** Standard user");
  expect(await Bun.file(plan.paths.testCases).text()).toContain("## TC-002: Validation message on empty input [mock-fail]");

  // test phase
  const run = await runTests(cfg, { ticket: "DEMO-1", runId: "r1", testRunId: "t1", agent, asker, skipPreflight: true });
  expect(run.results.map((r) => r.reply.status)).toEqual(["pass", "fail"]);
  const report = await Bun.file(run.paths.latestReport).text();
  expect(report).toContain("**Result: FAILED** · 1 passed · 1 failed");
  expect(report).toContain("demo/web-ui!7 [merged]");
  expect(report).toContain("No validation message appeared");
  expect(report).toContain("| AC-2 | TC-002 | ❌ fail |");

  // --only: runs one case, the report still covers every case (the other carried over from t1)
  const only = await runTests(cfg, { ticket: "DEMO-1", runId: "r1", testRunId: "t2", agent, asker, only: ["TC-001"], skipPreflight: true });
  expect(only.results).toHaveLength(1);
  expect(only.all.map((r) => [r.testCase.id, r.reply.status, r.fromTestRun])).toEqual([
    ["TC-001", "pass", undefined],
    ["TC-002", "fail", "t1"],
  ]);
  expect(await regenerateReport(cfg, "DEMO-1", "r1", "t2")).toBe(run.paths.latestReport);
  const merged = await Bun.file(run.paths.latestReport).text();
  expect(merged).toContain("**Result: FAILED** · 1 passed · 1 failed");
  expect(merged).toContain("❌ fail ↩ t1");

  // --failed: re-runs only TC-002 (still failing)
  const calls = agent.calls.length;
  const again = await runTests(cfg, { ticket: "DEMO-1", runId: "r1", testRunId: "t3", agent, asker, failed: true, skipPreflight: true });
  expect(again.results.map((r) => r.testCase.id)).toEqual(["TC-002"]);
  expect(agent.calls.length - calls).toBe(1);
  expect(again.all.find((r) => r.testCase.id === "TC-001")?.fromTestRun).toBe("t2");

  // after a fix (simulated by editing test-cases.md), --failed turns the report green
  const tcFile = run.paths.testCases;
  await Bun.write(tcFile, (await Bun.file(tcFile).text()).replaceAll(" [mock-fail]", ""));
  const fixed = await runTests(cfg, { ticket: "DEMO-1", runId: "r1", testRunId: "t4", agent, asker, failed: true, skipPreflight: true });
  expect(fixed.results.map((r) => [r.testCase.id, r.reply.status])).toEqual([["TC-002", "pass"]]);
  expect(await Bun.file(run.paths.latestReport).text()).toContain("**Result: PASSED** · 2 passed");
  await expect(runTests(cfg, { ticket: "DEMO-1", runId: "r1", testRunId: "t5", agent, asker, failed: true, skipPreflight: true })).rejects.toThrow(
    "Nothing to re-run",
  );

  // publish: comment + screenshots on the story (fake Jira records the requests)
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  await Bun.write(join(run.paths.runDir, "test-runs", "t2", "evidence", "TC-001-step1.png"), png); // TC-001's result is carried from t2
  await Bun.write(join(run.paths.runDir, "test-runs", "t4", "evidence", "TC-002-step2.png"), png);
  const requests: { method: string; url: string; body?: unknown }[] = [];
  const fakeJira = async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url, body: init?.body });
    if (url.includes("fields=attachment")) return Response.json({ fields: { attachment: [{ filename: "uitest-t2-TC-001-step1.png" }] } });
    if (url.endsWith("/comment")) return Response.json({ id: "10001" });
    return Response.json([{ id: "1" }]);
  };
  const pubOpts = { ticket: "DEMO-1", runId: "r1", testRunId: "t4", asker, fetchFn: fakeJira };
  await expect(runPublish(cfg, pubOpts)).rejects.toThrow("Publishing is off");

  const dry = await runPublish(cfg, { ...pubOpts, dryRun: true });
  expect(requests).toHaveLength(0);
  expect(dry.images.map((i) => i.name).sort()).toEqual(["uitest-t2-TC-001-step1.png", "uitest-t4-TC-002-step2.png"]);
  expect(dry.body).toContain("(/) *PASSED*");
  expect(dry.body).toContain("|TC-001|Happy path renders the new screen|P1|(/) pass (from t2)|");
  expect(dry.body).toContain("!uitest-t4-TC-002-step2.png|thumbnail!");

  cfg.jira.publish.enabled = true;
  const posted = await runPublish(cfg, pubOpts);
  expect(posted.posted && posted.commentId).toBe("10001");
  // the t2 screenshot was already on the issue: only the new screenshot and the report are uploaded
  expect(requests.filter((r) => r.url.endsWith("/attachments"))).toHaveLength(2);
  const comment = requests.find((r) => r.url.endsWith("/rest/api/2/issue/DEMO-1/comment"))!;
  expect(JSON.parse(String(comment.body)).body).toContain("!uitest-t2-TC-001-step1.png|thumbnail!");
  expect(await Bun.file(join(run.paths.runDir, "test-runs", "t4", "published.json")).text()).toContain("10001");

  // AI usage: off by default (no column, no usage.json); on → per-case column, run total, usage.json
  expect(await Bun.file(join(run.paths.testRunDir, "usage.json")).exists()).toBe(false);
  expect(await Bun.file(run.paths.report).text()).not.toContain("AI usage");
  cfg.agent.showUsage = true;
  const metered = await runTests(cfg, { ticket: "DEMO-1", runId: "r1", testRunId: "t6", agent, asker, only: ["TC-001"], skipPreflight: true });
  expect(metered.usage.total()).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: 0.001 });
  const usageReport = await Bun.file(metered.paths.report).text();
  expect(usageReport).toContain("- **AI usage (this run):** 1.0k in · 200 out · $0.0010 over 1 agent call(s)");
  expect(usageReport).toContain("| ✅ pass | 0s | 1.0k in · 200 out · $0.0010 |");
  expect(usageReport).toContain("↩ t4 | 0s | — |"); // carried-over case: its usage belongs to an earlier run
  expect(await Bun.file(join(metered.paths.testRunDir, "usage.json")).text()).toContain('"label": "TC-001"');
  cfg.agent.showUsage = false;
}, 120_000);
