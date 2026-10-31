#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { AGENT_IDS, createAgent } from "./agents/registry.ts";
import { preflight } from "./browser/preflight.ts";
import { DEFAULT_CONFIG_FILE, loadConfig } from "./config/load.ts";
import type { Config } from "./config/schema.ts";
import { ScriptedAsker, TerminalAsker, type Asker } from "./qa/interactive.ts";
import { isGitRepo } from "./repos/git.ts";
import { getIndex } from "./repos/indexer.ts";
import { fixtureFetch } from "./sources/fixtures.ts";
import { GitLabClient } from "./sources/gitlab/client.ts";
import { JiraClient } from "./sources/jira/client.ts";
import { latestRunId, latestTestRunId, runPaths } from "./phases/paths.ts";
import { runPlan } from "./phases/plan.ts";
import { regenerateReport, runTests } from "./phases/test.ts";
import { timestamp } from "./util/index.ts";

const program = new Command()
  .name("uitest")
  .description("Plan and run UI tests for a Jira ticket with any AI agent + Chrome")
  .option("-c, --config <file>", "config file", DEFAULT_CONFIG_FILE);

async function cfgFrom(opts: { agent?: string }): Promise<Config> {
  const cfg = await loadConfig(program.opts().config);
  if (opts.agent) cfg.agent.provider = opts.agent;
  return cfg;
}

async function askerFrom(answersFile?: string): Promise<Asker> {
  if (!answersFile) return new TerminalAsker();
  return new ScriptedAsker(await Bun.file(answersFile).json());
}

function clients(cfg: Config, fixtures?: string) {
  const jira = new JiraClient(cfg.jira.baseUrl, cfg.jira.email, cfg.jira.token, fixtures ? fixtureFetch(fixtures, "jira") : fetch);
  const gitlab =
    cfg.gitlab.token || fixtures
      ? new GitLabClient(cfg.gitlab.baseUrl, cfg.gitlab.token, fixtures ? fixtureFetch(fixtures, "gitlab") : fetch)
      : null;
  return { jira, gitlab };
}

function fail(e: unknown): never {
  p.log.error((e as Error).message);
  process.exit(1);
}

program
  .command("init")
  .description("create uitest.config.yaml and .env from the examples")
  .action(async () => {
    const root = resolve(import.meta.dir, "..");
    for (const [src, dst] of [["uitest.config.example.yaml", DEFAULT_CONFIG_FILE], [".env.example", ".env"]] as const) {
      if (existsSync(dst)) p.log.warn(`${dst} exists, leaving it alone`);
      else {
        await Bun.write(dst, Bun.file(resolve(root, src)));
        p.log.success(`created ${dst}`);
      }
    }
    p.log.info("Edit both files, then run: uitest doctor");
  });

program
  .command("doctor")
  .description("check agent CLI, Chrome, Jira, GitLab and repos")
  .option("--agent <id>", `override agent (${AGENT_IDS.join("|")})`)
  .action(async (o) => {
    const cfg = await cfgFrom(o).catch(fail);
    let ok = true;
    const report = (good: boolean, msg: string) => {
      ok &&= good;
      good ? p.log.success(msg) : p.log.error(msg);
    };

    const agent = createAgent(cfg.agent.provider, cfg.agent.bin);
    const d = await agent.doctor();
    report(d.ok, `agent ${agent.id}: ${d.version ?? "?"} ${d.messages.join("; ")}`);

    const pf = await preflight(cfg);
    report(pf.ok, pf.mode === "autoConnect" ? "chrome: autoConnect mode (verified by agent at run time)" : pf.ok ? `chrome: ${pf.browser}, tab ${pf.tab?.url}` : `chrome: ${pf.problems.join(" ")}`);

    const { jira, gitlab } = clients(cfg);
    await jira.myself().then((m) => report(true, `jira: signed in as ${m.displayName}`), (e) => report(false, `jira: ${e.message}`));
    if (gitlab) await gitlab.user().then((u) => report(true, `gitlab: signed in as ${u.username}`), (e) => report(false, `gitlab: ${e.message}`));
    else p.log.warn("gitlab: no token configured, MR lookup disabled");

    for (const r of cfg.repos) report(await isGitRepo(r.path), `repo ${r.name}: ${r.path}`);
    if (cfg.jira.rovo.enabled) p.log.info("rovo: enabled — the agent CLI will prompt for Atlassian OAuth on first use");
    process.exit(ok ? 0 : 1);
  });

program
  .command("index [repo]")
  .description("build or refresh the lexical index for configured repos")
  .option("--force", "rebuild even if HEAD is unchanged")
  .action(async (name: string | undefined, o) => {
    const cfg = await cfgFrom({}).catch(fail);
    const repos = name ? cfg.repos.filter((r) => r.name === name) : cfg.repos;
    if (!repos.length) fail(new Error(name ? `No repo named ${name}` : "No repos configured"));
    for (const r of repos) {
      const { index, cached } = await getIndex(r, { exclude: cfg.indexing.exclude, cacheDir: cfg.indexing.cacheDir, force: o.force });
      p.log.success(`${r.name}: ${cached ? "up to date" : "indexed"} — ${index.files.length} files, ${index.routes.length} routes, ${index.components.length} components`);
    }
  });

program
  .command("plan <ticket>")
  .description("phase 1: gather context and plan test cases (asks you questions)")
  .option("--agent <id>", `override agent (${AGENT_IDS.join("|")})`)
  .option("--answers <file>", "answer questions from a JSON file {questionId: answer} instead of the terminal")
  .option("--fixtures <dir>", "serve Jira/GitLab from recorded fixtures (offline)")
  .action(async (ticket: string, o) => {
    const cfg = await cfgFrom(o).catch(fail);
    ticket = ticket.toUpperCase();
    p.intro(`uitest plan ${ticket} — agent: ${cfg.agent.provider}`);
    const asker = await askerFrom(o.answers);
    try {
      const { paths, reply } = await runPlan(cfg, {
        ticket,
        runId: timestamp(),
        agent: createAgent(cfg.agent.provider, cfg.agent.bin),
        asker,
        deps: { ...clients(cfg, o.fixtures), log: (m) => p.log.step(m) },
      });
      p.outro(`${reply.testCases.length} test cases → ${paths.testCases}\nReview/edit it, then run: uitest test ${ticket}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("test <ticket>")
  .description("phase 2: run the planned test cases in your signed-in Chrome tab")
  .option("--agent <id>", `override agent (${AGENT_IDS.join("|")})`)
  .option("--run <id>", "plan run id (default: latest)")
  .option("--only <ids>", "comma-separated test case ids, e.g. TC-001,TC-003")
  .option("--answers <file>", "answer questions from a JSON file instead of the terminal")
  .option("--skip-preflight", "do not check Chrome before running (e.g. with the mock agent)")
  .action(async (ticket: string, o) => {
    const cfg = await cfgFrom(o).catch(fail);
    ticket = ticket.toUpperCase();
    const runId = o.run ?? latestRunId(cfg, ticket);
    if (!runId) fail(new Error(`No plan found for ${ticket}. Run "uitest plan ${ticket}" first.`));
    p.intro(`uitest test ${ticket} (plan ${runId}) — agent: ${cfg.agent.provider}`);
    try {
      const { paths, results } = await runTests(cfg, {
        ticket,
        runId,
        testRunId: timestamp(),
        agent: createAgent(cfg.agent.provider, cfg.agent.bin),
        asker: await askerFrom(o.answers),
        only: o.only?.split(",").map((s: string) => s.trim().toUpperCase()),
        skipPreflight: o.skipPreflight,
      });
      const failed = results.filter((r) => r.reply.status === "fail" || r.reply.status === "blocked").length;
      p.outro(`${results.length - failed}/${results.length} passed or skipped → ${paths.latestReport}`);
      process.exit(failed ? 2 : 0);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("report <ticket>")
  .description("regenerate test-report.md from saved results")
  .option("--run <id>", "plan run id (default: latest)")
  .action(async (ticket: string, o) => {
    const cfg = await cfgFrom({}).catch(fail);
    ticket = ticket.toUpperCase();
    const runId = o.run ?? latestRunId(cfg, ticket);
    if (!runId) fail(new Error(`No runs for ${ticket}`));
    const testRunId = latestTestRunId(runPaths(cfg, ticket, runId));
    if (!testRunId) fail(new Error(`No test runs under plan ${runId}`));
    p.log.success(`wrote ${await regenerateReport(cfg, ticket, runId, testRunId).catch(fail)}`);
  });

await program.parseAsync();
