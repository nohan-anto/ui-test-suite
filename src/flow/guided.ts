/**
 * `uitest` with no command: one guided, menu-driven flow so nobody has to remember commands.
 *
 *   ticket → plan (or reuse the latest) → menu ⇄ chat / view / edit / re-plan
 *                                          └→ Chrome running? → signed in? → which cases? → start → results
 *                                                                                        ⇄ re-run failed / chat / publish
 * Every step before the run can go back to the menu (also with Esc).
 */
import { readFileSync } from "node:fs";
import type { AgentAdapter } from "../agents/types.ts";
import { formatUsage } from "../agents/usage.ts";
import { readNotes } from "../artifacts/notes.ts";
import { parseTestCases } from "../artifacts/testcases.ts";
import { launchChrome, type LaunchResult } from "../browser/launch.ts";
import { preflight, type PreflightResult } from "../browser/preflight.ts";
import type { Config } from "../config/schema.ts";
import { runChat } from "../phases/chat.ts";
import type { ContextDeps } from "../phases/context.ts";
import { latestRunId, runPaths } from "../phases/paths.ts";
import { runPlan } from "../phases/plan.ts";
import { runPublish } from "../phases/publish.ts";
import { latestCompletedTestRun, runTests } from "../phases/test.ts";
import type { Asker, Choice } from "../qa/interactive.ts";
import { timestamp } from "../util/index.ts";

export interface GuidedDeps {
  agent: AgentAdapter;
  asker: Asker;
  contextDeps: () => ContextDeps;
  browser?: { check(): Promise<PreflightResult>; launch(): Promise<LaunchResult> };
  /** New run ids (sortable). */
  newId?: () => string;
}

type Step = "menu" | "browser" | "select" | "exit";
const TICKET = /^[A-Z][A-Z0-9_]+-\d+$/;

export async function runGuided(cfg: Config, deps: GuidedDeps, ticketArg?: string) {
  const { asker, agent } = deps;
  const newId = deps.newId ?? timestamp;
  const browser = deps.browser ?? { check: () => preflight(cfg), launch: () => launchChrome(cfg.browser) };

  // 1. Ticket
  let ticket = ticketArg?.toUpperCase() ?? "";
  while (!TICKET.test(ticket)) {
    if (ticket) asker.info(`"${ticket}" doesn't look like a Jira key (e.g. CIS-601).`);
    ticket = (await asker.ask({ id: "TICKET", question: "Which Jira ticket? (e.g. CIS-601)", why: "", options: [] })).trim().toUpperCase();
  }

  // 2. Plan: reuse the latest or make a new one
  let runId = latestRunId(cfg, ticket);
  if (runId) {
    const n = safeCount(cfg, ticket, runId);
    const pick = await asker.select("PLAN", `${ticket} already has a plan (${runId}${n === null ? "" : `, ${n} test cases`}).`, [
      { value: "reuse", label: "Use that plan" },
      { value: "new", label: "Make a new plan", hint: "fetches Jira/GitLab again and asks the agent" },
    ]);
    if (pick === "new") runId = null;
  }
  if (!runId) runId = await plan(cfg, deps, ticket, newId());

  // 3. Menu ⇄ testing
  let step: Step = "menu";
  let selection: { only?: string[]; failed?: boolean } = {};
  let tested = 0;
  while (step !== "exit") {
    const paths = runPaths(cfg, ticket, runId);
    if (step === "menu") {
      const cases = parseTestCases(await Bun.file(paths.testCases).text()).cases;
      const notes = await readNotes(paths.notes);
      const last = await latestCompletedTestRun(paths);
      const lastLine = last ? `, last test run ${last.testRunId}: ${summary(last.results)}` : "";
      const choice = await asker.select(
        "MENU",
        `${ticket} · plan ${runId} · ${cases.length} test cases · ${notes.length} note(s)${lastLine}. What next?`,
        [
          { value: "test", label: "Start testing →", hint: "Chrome, sign-in, choose cases" },
          { value: "chat", label: "Chat with the agent", hint: "ask about routes/screens, give test data" },
          { value: "view", label: "View the test cases" },
          { value: "edit", label: "Edit test-cases.md by hand" },
          { value: "replan", label: "Make a new plan" },
          { value: "exit", label: "Exit" },
        ],
        "exit",
      );
      if (choice === "exit") step = "exit";
      else if (choice === "test") step = "browser";
      else if (choice === "chat") await chat(cfg, deps, ticket, runId);
      else if (choice === "view") asker.info(viewCases(cases, notes, paths.testCases));
      else if (choice === "edit") await editByHand(asker, paths.testCases);
      else if (choice === "replan") runId = await plan(cfg, deps, ticket, newId());
      continue;
    }

    if (step === "browser") {
      step = (await signedIn(cfg, asker, browser)) ? "select" : "menu";
      continue;
    }

    // step === "select": which cases, final go, run, results
    const doc = parseTestCases(await Bun.file(paths.testCases).text());
    const last = await latestCompletedTestRun(paths);
    const failedIds = (last?.results ?? []).filter((r) => r.reply.status === "fail" || r.reply.status === "blocked").map((r) => r.testCase.id);
    const choices: Choice[] = [{ value: "all", label: `All ${doc.cases.length} test cases` }];
    if (failedIds.length) choices.push({ value: "failed", label: `Only the ${failedIds.length} failed/blocked from the last run`, hint: failedIds.join(", ") });
    choices.push({ value: "pick", label: "Choose cases…" }, { value: "back", label: "← Back to the menu" });
    const which = await asker.select("CASES", "Which test cases?", choices, "back");
    if (which === "back") {
      step = "menu";
      continue;
    }
    selection = which === "failed" ? { failed: true } : {};
    if (which === "pick") {
      const ids = await asker.multiselect(
        "PICK",
        "Select cases (space to toggle, enter to confirm)",
        doc.cases.map((c) => ({ value: c.id, label: `${c.id} ${c.title}`, hint: c.tags.includes("destructive") ? "destructive" : c.priority })),
      );
      if (!ids.length) continue;
      selection = { only: ids };
    }
    const count = selection.only?.length ?? (selection.failed ? failedIds.length : doc.cases.length);
    const go = await asker.select("START", `Start the test run (${count} case${count === 1 ? "" : "s"}) in the signed-in tab?`, [
      { value: "start", label: "Start test" },
      { value: "cases", label: "← Choose different cases" },
      { value: "back", label: "← Back to the menu" },
    ], "back");
    if (go === "cases") continue;
    if (go === "back") {
      step = "menu";
      continue;
    }

    const run = await runTests(cfg, { ticket, runId, testRunId: newId(), agent, asker, ...selection, skipPreflight: true });
    tested++;
    const bad = run.all.filter((r) => r.reply.status === "fail" || r.reply.status === "blocked");
    asker.info(
      `Result: ${summary(run.all)} → ${run.paths.latestReport}` +
        (cfg.agent.showUsage ? `\nAI usage, this run: ${formatUsage(run.usage.total())} over ${run.usage.calls()} agent call(s)` : ""),
    );
    step = await afterRun(cfg, deps, ticket, runId, bad.length);
  }
  return { ticket, runId, tested };
}

function summary(results: { reply: { status: string } }[]): string {
  const c = (s: string) => results.filter((r) => r.reply.status === s).length;
  return `${c("pass")} passed · ${c("fail")} failed · ${c("blocked")} blocked · ${c("skipped")} skipped`;
}

function safeCount(cfg: Config, ticket: string, runId: string): number | null {
  try {
    return parseTestCases(readFileSync(runPaths(cfg, ticket, runId).testCases, "utf8")).cases.length;
  } catch {
    return null;
  }
}

async function plan(cfg: Config, deps: GuidedDeps, ticket: string, runId: string): Promise<string> {
  deps.asker.info(`Planning ${ticket}: fetching the story, MRs and code, then the agent drafts test cases and asks you questions.`);
  const r = await runPlan(cfg, { ticket, runId, agent: deps.agent, asker: deps.asker, deps: deps.contextDeps() });
  deps.asker.info(`${r.reply.testCases.length} test cases → ${r.paths.testCases}` + (cfg.agent.showUsage ? `\nAI usage, planning: ${formatUsage(r.usage.total())}` : ""));
  return runId;
}

async function chat(cfg: Config, deps: GuidedDeps, ticket: string, runId: string) {
  const r = await runChat(cfg, { ticket, runId, agent: deps.agent, asker: deps.asker });
  deps.asker.info(`Back to the menu. ${r.notes.length} note(s) saved${r.applied ? `, test cases updated ${r.applied} time(s)` : ""}.`);
}

export function viewCases(cases: ReturnType<typeof parseTestCases>["cases"], notes: string[], file: string): string {
  const lines = cases.map((c) => {
    const data = c.testData.length ? `\n      data: ${c.testData.join("; ")}` : "";
    return `  ${c.id} [${c.priority}]${c.tags.length ? ` (${c.tags.join(", ")})` : ""} ${c.title}${data}`;
  });
  const n = notes.length ? `\n\nThings to consider:\n${notes.map((x) => `  • ${x}`).join("\n")}` : "";
  return `${lines.join("\n")}${n}\n\nFull details: ${file}`;
}

async function editByHand(asker: Asker, file: string) {
  for (;;) {
    await asker.ask({ id: "EDITED", question: `Edit ${file} and save it, then press Enter here`, why: "", options: [] }, { allowEmpty: true });
    try {
      const n = parseTestCases(await Bun.file(file).text()).cases.length;
      asker.info(`test-cases.md is valid (${n} cases).`);
      return;
    } catch (e) {
      const again = await asker.select("EDIT-INVALID", `${(e as Error).message}\nFix it?`, [
        { value: "again", label: "I'll fix it, check again" },
        { value: "back", label: "← Back to the menu (the test run will fail until it's fixed)" },
      ], "back");
      if (again === "back") return;
    }
  }
}

/** Chrome running → launch offer → "are you signed in?" → verified. false = back to the menu. */
async function signedIn(cfg: Config, asker: Asker, browser: NonNullable<GuidedDeps["browser"]>): Promise<boolean> {
  const app = cfg.browser.appBaseUrl;
  for (;;) {
    const pf = await browser.check();
    const unreachable = pf.mode === "browserUrl" && !pf.browser;
    if (unreachable) {
      const c = await asker.select("CHROME", `Chrome isn't running with remote debugging on ${cfg.browser.browserUrl}.`, [
        { value: "launch", label: "Launch Chrome for me", hint: `debug profile ${cfg.browser.profileDir}` },
        { value: "check", label: "I started it myself, check again" },
        { value: "back", label: "← Back to the menu" },
      ], "back");
      if (c === "back") return false;
      if (c === "launch") {
        const l = await browser.launch();
        asker.info(l.message);
        if (!l.ok) continue;
      }
      continue;
    }

    const where = pf.tab ? `the tab "${pf.tab.title}" (${pf.tab.url})` : `Chrome (auto-connect)`;
    const problems = pf.problems.length ? `\n${pf.problems.join("\n")}` : "";
    const c = await asker.select(
      "SIGNED-IN",
      pf.ok ? `Chrome is ready: ${where}. Are you signed in to ${app} there?` : `Chrome is running, but it's not ready yet:${problems}\nOpen ${app} in that window and sign in through OneLogin.`,
      [
        ...(pf.ok ? [{ value: "yes", label: "Yes, I'm signed in" }] : []),
        { value: "check", label: pf.ok ? "Not yet: I'll sign in, then check again" : "Done, check again" },
        { value: "back", label: "← Back to the menu" },
      ],
      "back",
    );
    if (c === "back") return false;
    if (c === "yes") return true;
  }
}

async function afterRun(cfg: Config, deps: GuidedDeps, ticket: string, runId: string, failures: number): Promise<Step> {
  for (;;) {
    const choices: Choice[] = [];
    if (failures) choices.push({ value: "rerun", label: `Re-run the ${failures} failed/blocked case(s)` });
    choices.push({ value: "chat", label: "Chat with the agent", hint: "e.g. give the right test data before a re-run" });
    if (cfg.jira.publish.enabled) choices.push({ value: "publish", label: `Post the report to ${ticket} in Jira` });
    choices.push({ value: "menu", label: "← Back to the menu" }, { value: "exit", label: "Exit" });
    const c = await deps.asker.select("AFTER", "What next?", choices, "menu");
    if (c === "rerun") return "browser"; // re-check the tab (sessions expire), then the case picker offers "failed"
    if (c === "chat") await chat(cfg, deps, ticket, runId);
    if (c === "publish") {
      const paths = runPaths(cfg, ticket, runId);
      const last = await latestCompletedTestRun(paths);
      if (last) {
        const r = await runPublish(cfg, { ticket, runId, testRunId: last.testRunId, asker: deps.asker });
        deps.asker.info(r.posted ? `Posted to ${r.issue}.` : "Not posted.");
      }
    }
    if (c === "menu") return "menu";
    if (c === "exit") return "exit";
  }
}
