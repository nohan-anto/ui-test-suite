/** Phase 2: run each approved test case in the signed-in Chrome tab, then write test-report.md. */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../agents/types.ts";
import { answersForPrompt } from "../artifacts/questions.ts";
import { renderReport, type CaseResult, type RunMeta } from "../artifacts/report.ts";
import { parseTestCases } from "../artifacts/testcases.ts";
import { preflight } from "../browser/preflight.ts";
import type { Config } from "../config/schema.ts";
import { mcpServersFor } from "../mcp/servers.ts";
import type { Asker } from "../qa/interactive.ts";
import { writeText } from "../util/index.ts";
import type { ContextManifest } from "./context.ts";
import { loadPrompt, runPaths, type RunPaths } from "./paths.ts";
import { TestReplySchema, type QA, type TestCase, type TestReply } from "./protocol.ts";
import { runAgentJson } from "./run-agent.ts";

export interface TestOptions {
  ticket: string;
  runId: string;
  testRunId: string;
  agent: AgentAdapter;
  asker: Asker;
  only?: string[];
  skipPreflight?: boolean;
}

export function buildTestPrompt(cfg: Config, paths: RunPaths, tc: TestCase, qas: QA[]): string {
  const origins = cfg.browser.allowedOrigins.length ? cfg.browser.allowedOrigins : [new URL(cfg.browser.appBaseUrl).origin];
  return [
    `# Execute ${tc.id}: ${tc.title}`,
    "",
    `- App base URL: ${cfg.browser.appBaseUrl}`,
    `- Signed-in tab: the open tab whose URL contains "${cfg.browser.tabMatch ?? new URL(cfg.browser.appBaseUrl).host}"`,
    `- Allowed origins: ${origins.join(", ")}`,
    `- Evidence directory (save screenshots here): ${paths.evidenceDir}`,
    "",
    "## Test case",
    "",
    "```json",
    JSON.stringify(tc, null, 2),
    "```",
    "",
    "Steps are numbered from 1 in the order above; report one entry per step.",
    "",
    answersForPrompt(qas),
  ].join("\n");
}

const MAX_CLARIFY = 2;

async function runCase(cfg: Config, paths: RunPaths, tc: TestCase, opts: TestOptions, systemPrompt: string): Promise<CaseResult> {
  const started = Date.now();
  const servers = mcpServersFor(cfg, { workspace: paths.evidenceDir });
  const qas: QA[] = [];
  let reply: TestReply | undefined;
  try {
    for (let round = 1; round <= MAX_CLARIFY + 1; round++) {
      reply = await runAgentJson(
        opts.agent,
        {
          prompt: buildTestPrompt(cfg, paths, tc, qas),
          systemPrompt,
          mcpServers: servers,
          workDirs: [paths.runDir],
          mode: "test",
          timeoutMs: cfg.agent.timeoutSec * 1000,
          model: cfg.agent.model,
          extraArgs: cfg.agent.extraArgs,
        },
        TestReplySchema,
        join(paths.testRunDir, "transcripts", `${tc.id}-round${round}`),
      );
      if (reply.status !== "blocked" || !reply.questions.length || round > MAX_CLARIFY) break;
      opts.asker.info(`${tc.id} is blocked on ${reply.questions.length} question(s).`);
      for (const q of reply.questions) qas.push({ round, question: q, answer: await opts.asker.ask(q) });
    }
    return { testCase: tc, reply: { ...reply!, id: tc.id }, durationMs: Date.now() - started };
  } catch (e) {
    return {
      testCase: tc,
      reply: { id: tc.id, status: "blocked", steps: [], notes: "", consoleErrors: [], failedRequests: [], evidence: [], questions: [] },
      durationMs: Date.now() - started,
      error: (e as Error).message,
    };
  }
}

async function readManifest(paths: RunPaths): Promise<ContextManifest | null> {
  const f = Bun.file(join(paths.contextDir, "manifest.json"));
  return (await f.exists()) ? ((await f.json()) as ContextManifest) : null;
}

export function buildMeta(cfg: Config, opts: { ticket: string; agent: string }, title: string, manifest: ContextManifest | null, startedAt: string): RunMeta {
  return {
    ticket: opts.ticket,
    title,
    environment: cfg.browser.appBaseUrl,
    agent: opts.agent,
    model: cfg.agent.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    mergeRequests: (manifest?.mergeRequests ?? []).map((m) => ({ ref: m.ref, state: m.state, sha: m.sha })),
    repos: (manifest?.repos ?? []).map((r) => ({ name: r.name, head: r.head, note: r.note })),
  };
}

export async function runTests(cfg: Config, opts: TestOptions) {
  const paths = runPaths(cfg, opts.ticket, opts.runId, opts.testRunId);
  if (!existsSync(paths.testCases)) throw new Error(`No test cases at ${paths.testCases}. Run "uitest plan ${opts.ticket}" first.`);
  const doc = parseTestCases(await Bun.file(paths.testCases).text());
  const cases = opts.only?.length ? doc.cases.filter((c) => opts.only!.includes(c.id)) : doc.cases;
  if (!cases.length) throw new Error("No test cases selected.");

  if (!opts.skipPreflight) {
    const pf = await preflight(cfg);
    if (!pf.ok) throw new Error(`Browser preflight failed:\n  ${pf.problems.join("\n  ")}`);
    opts.asker.info(pf.tab ? `Using signed-in tab: ${pf.tab.title} (${pf.tab.url})` : `Browser mode: ${pf.mode}`);
  }

  mkdirSync(paths.evidenceDir, { recursive: true });
  const systemPrompt = await loadPrompt("test");
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  for (const tc of cases) {
    if (tc.tags.includes("destructive") && !(await opts.asker.confirm(`${tc.id} "${tc.title}" is tagged destructive. Run it?`))) {
      results.push({
        testCase: tc,
        reply: { id: tc.id, status: "skipped", steps: [], notes: "Skipped: destructive case not confirmed by user.", consoleErrors: [], failedRequests: [], evidence: [], questions: [] },
        durationMs: 0,
      });
      continue;
    }
    opts.asker.info(`Running ${tc.id}: ${tc.title}`);
    const r = await runCase(cfg, paths, tc, opts, systemPrompt);
    opts.asker.info(`${tc.id} → ${r.reply.status}${r.error ? ` (${r.error})` : ""}`);
    results.push(r);
    await writeText(paths.results, JSON.stringify(results, null, 2)); // persist progress after every case
  }

  const meta = buildMeta(cfg, { ticket: opts.ticket, agent: opts.agent.id }, doc.title, await readManifest(paths), startedAt);
  await writeText(paths.results, JSON.stringify({ meta, results }, null, 2));
  const report = renderReport(meta, results, "evidence");
  await writeText(paths.report, report);
  // Top-level copy points into this test run's evidence directory.
  await writeText(paths.latestReport, renderReport(meta, results, `test-runs/${opts.testRunId}/evidence`));
  return { paths, meta, results };
}

/** Rebuild test-report.md from saved results.json. */
export async function regenerateReport(cfg: Config, ticket: string, runId: string, testRunId: string) {
  const paths = runPaths(cfg, ticket, runId, testRunId);
  const saved = (await Bun.file(paths.results).json()) as { meta: RunMeta; results: CaseResult[] } | CaseResult[];
  if (Array.isArray(saved)) throw new Error("results.json is from an unfinished run; re-run `uitest test` to complete it.");
  await writeText(paths.report, renderReport(saved.meta, saved.results, "evidence"));
  await writeText(paths.latestReport, renderReport(saved.meta, saved.results, `test-runs/${testRunId}/evidence`));
  return paths.latestReport;
}
