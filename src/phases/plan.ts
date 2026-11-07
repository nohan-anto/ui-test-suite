/** Phase 1: gather context, then loop with the agent (asking the user every question) until test cases are approved. */
import { join } from "node:path";
import type { AgentAdapter } from "../agents/types.ts";
import { answersForPrompt, renderQuestions } from "../artifacts/questions.ts";
import { renderTestCases } from "../artifacts/testcases.ts";
import type { Config } from "../config/schema.ts";
import { mcpServersFor } from "../mcp/servers.ts";
import type { Asker } from "../qa/interactive.ts";
import { writeText } from "../util/index.ts";
import { buildContext, type ContextDeps, type ContextManifest } from "./context.ts";
import { loadPrompt, runPaths, type RunPaths } from "./paths.ts";
import { PlanReplySchema, type PlanReply, type QA } from "./protocol.ts";
import { runAgentJson } from "./run-agent.ts";
import { formatUsage, UsageMeter } from "../agents/usage.ts";

export interface PlanOptions {
  ticket: string;
  runId: string;
  agent: AgentAdapter;
  asker: Asker;
  deps: ContextDeps;
}

export function buildPlanPrompt(cfg: Config, paths: RunPaths, manifest: ContextManifest, qas: QA[], draft?: PlanReply): string {
  const lines = [
    `# Ticket ${manifest.ticket}: ${manifest.title}`,
    "",
    manifest.isEpic ? `This is an **epic** with child issues: ${manifest.children.join(", ") || "(none)"}. Cover every child.` : "",
    "## Context bundle (read these files first)",
    "",
    ...manifest.files.map((f) => `- ${join(paths.contextDir, f)}`),
    "",
    "## Local repositories (read-only)",
    "",
    ...(manifest.repos.length
      ? manifest.repos.map((r) => `- **${r.name}** (${r.role}): ${r.path}${r.note ? ` — ⚠️ ${r.note}` : ""}`)
      : ["- (none configured)"]),
    "",
    "## Application under test",
    "",
    `- Base URL: ${cfg.browser.appBaseUrl}`,
    `- Allowed origins: ${(cfg.browser.allowedOrigins.length ? cfg.browser.allowedOrigins : [new URL(cfg.browser.appBaseUrl).origin]).join(", ")}`,
    `- The user is already signed in via SSO in an open Chrome tab${cfg.browser.tabMatch ? ` matching "${cfg.browser.tabMatch}"` : ""}. Use that tab; do not sign in.`,
    "",
    answersForPrompt(qas),
  ];
  if (draft?.testCases.length) {
    lines.push("## Your previous draft", "", "```json", JSON.stringify(draft.testCases, null, 2), "```", "");
  }
  lines.push(
    qas.length
      ? "Incorporate the answers above. Ask further questions only if something is still ambiguous."
      : "Read the context, explore the code and UI as needed, then return your questions (and a draft if useful).",
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

export async function runPlan(cfg: Config, opts: PlanOptions) {
  const paths = runPaths(cfg, opts.ticket, opts.runId);
  const { manifest } = await buildContext(cfg, opts.ticket, paths.contextDir, opts.deps);
  const systemPrompt = await loadPrompt("plan");
  const servers = mcpServersFor(cfg, { workspace: paths.runDir, observeOnly: cfg.browser.planObserveOnly });
  const workDirs = [paths.runDir, ...manifest.repos.map((r) => r.path)];

  const qas: QA[] = [];
  let reply: PlanReply | undefined;
  let feedbackRounds = 0;
  const meter = new UsageMeter();

  for (let round = 1; round <= cfg.agent.maxQuestionRounds; round++) {
    opts.asker.info(`Planning round ${round} with ${opts.agent.id}…`);
    reply = await runAgentJson(
      opts.agent,
      {
        prompt: buildPlanPrompt(cfg, paths, manifest, qas, reply),
        systemPrompt,
        mcpServers: servers,
        workDirs,
        mode: "plan",
        timeoutMs: cfg.agent.timeoutSec * 1000,
        model: cfg.agent.model,
        extraArgs: cfg.agent.extraArgs,
      },
      PlanReplySchema,
      join(paths.transcriptsDir, `plan-round${round}`),
      { meter, label: `round ${round}` },
    );
    if (cfg.agent.showUsage) opts.asker.info(`AI usage, round ${round}: ${formatUsage(meter.total(`round ${round}`))}`);

    if (reply.questions.length) {
      opts.asker.info(`The agent has ${reply.questions.length} question(s).`);
      for (const q of reply.questions) qas.push({ round, question: q, answer: await opts.asker.ask(q) });
      await writeText(paths.questions, renderQuestions(opts.ticket, qas));
      continue;
    }
    if (!reply.testCases.length) {
      throw new Error("The agent returned neither questions nor test cases.");
    }

    opts.asker.info(
      `${reply.summary}\n\n` + reply.testCases.map((c) => `  ${c.id} [${c.priority}] ${c.title}`).join("\n"),
    );
    if (await opts.asker.confirm(`Accept these ${reply.testCases.length} test cases?`)) break;
    feedbackRounds++;
    const feedback = await opts.asker.ask({
      id: `FEEDBACK-${feedbackRounds}`,
      question: "What should change in the test cases?",
      why: "You did not accept the draft.",
      options: [],
    });
    qas.push({ round, question: { id: `FEEDBACK-${feedbackRounds}`, question: "Changes requested by the user", why: "", options: [] }, answer: feedback });
    if (round === cfg.agent.maxQuestionRounds) throw new Error("Reached agent.maxQuestionRounds without an accepted plan.");
  }

  if (!reply?.testCases.length || reply.questions.length) {
    throw new Error(`Planning did not converge within ${cfg.agent.maxQuestionRounds} rounds; see ${paths.questions}`);
  }
  await writeText(paths.questions, renderQuestions(opts.ticket, qas));
  await writeText(
    paths.testCases,
    renderTestCases({ ticket: opts.ticket, title: manifest.title, summary: reply.summary, cases: reply.testCases }),
  );
  if (cfg.agent.showUsage) {
    await writeText(join(paths.runDir, "usage.json"), JSON.stringify({ agent: opts.agent.id, model: cfg.agent.model, total: meter.total(), calls: meter.entries }, null, 2));
  }
  return { paths, manifest, reply, qas, usage: meter };
}
