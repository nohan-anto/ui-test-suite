/**
 * `uitest chat`: talk to the agent about a plan. Ask what it will test and how (routes, data, screens), or tell it
 * what to consider. Things to consider are saved to notes.md and given to every test case; requested plan changes
 * are applied to test-cases.md after confirmation.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../agents/types.ts";
import { formatUsage, UsageMeter } from "../agents/usage.ts";
import { mergeNotes, readNotes, renderNotes } from "../artifacts/notes.ts";
import { parseTestCases, renderTestCases, type TestCasesDoc } from "../artifacts/testcases.ts";
import type { Config } from "../config/schema.ts";
import { mcpServersFor } from "../mcp/servers.ts";
import type { Asker } from "../qa/interactive.ts";
import { writeText } from "../util/index.ts";
import type { ContextManifest } from "./context.ts";
import { loadPrompt, runPaths, type RunPaths } from "./paths.ts";
import { ChatReplySchema, type TestCase } from "./protocol.ts";
import { runAgentJson } from "./run-agent.ts";

export interface ChatOptions {
  ticket: string;
  runId: string;
  agent: AgentAdapter;
  asker: Asker;
  /** Stop after this many messages (safety net for scripted runs). */
  maxTurns?: number;
}

export interface ChatTurn {
  user: string;
  agent: string;
}

const HISTORY = 10;
const EXIT = /^\s*(\/?(exit|quit|done|bye)|q)\s*$/i;

export function buildChatPrompt(paths: RunPaths, manifest: ContextManifest | null, testCasesMd: string, notes: string[], history: ChatTurn[], message: string): string {
  return [
    `# Chat about the test plan for ${manifest?.ticket ?? "the ticket"}${manifest?.title ? `: ${manifest.title}` : ""}`,
    "",
    `Context bundle (read these as needed): ${paths.contextDir}`,
    ...(manifest?.files ?? []).map((f) => `- ${f}`),
    ...(manifest?.repos.length ? ["", "Local repositories:", ...manifest.repos.map((r) => `- ${r.name} (${r.role}): ${r.path}`)] : []),
    "",
    "## Current test cases (test-cases.md)",
    "",
    testCasesMd.trim(),
    "",
    "## Things to consider so far (notes.md)",
    "",
    ...(notes.length ? notes.map((n) => `- ${n}`) : ["_none yet_"]),
    "",
    ...(history.length
      ? ["## Conversation so far", "", ...history.slice(-HISTORY).flatMap((t) => [`**User:** ${t.user}`, "", `**You:** ${t.agent}`, ""])]
      : []),
    "## The user's message",
    "",
    message,
  ].join("\n");
}

/** Short description of what changed between two case lists. */
export function describeCaseChanges(before: TestCase[], after: TestCase[]): string[] {
  const b = new Map(before.map((c) => [c.id, c]));
  const a = new Map(after.map((c) => [c.id, c]));
  const out: string[] = [];
  for (const c of after) {
    const old = b.get(c.id);
    if (!old) out.push(`+ ${c.id}: ${c.title} (new)`);
    else {
      const fields = (Object.keys(c) as (keyof TestCase)[]).filter((k) => JSON.stringify(c[k]) !== JSON.stringify(old[k]));
      if (fields.length) out.push(`~ ${c.id}: ${c.title} (changed: ${fields.join(", ")})`);
    }
  }
  for (const c of before) if (!a.has(c.id)) out.push(`- ${c.id}: ${c.title} (removed)`);
  return out;
}

async function appendChat(path: string, ticket: string, turn: ChatTurn & { at: string }) {
  const f = Bun.file(path);
  const prev = (await f.exists()) ? await f.text() : `# Chat: ${ticket}\n`;
  await writeText(path, `${prev}\n## ${turn.at}\n\n**You:** ${turn.user}\n\n**Agent:** ${turn.agent}\n`);
}

export async function runChat(cfg: Config, opts: ChatOptions) {
  const paths = runPaths(cfg, opts.ticket, opts.runId);
  if (!existsSync(paths.testCases)) throw new Error(`No test cases at ${paths.testCases}. Run "uitest plan ${opts.ticket}" first.`);
  const manifestFile = Bun.file(join(paths.contextDir, "manifest.json"));
  const manifest = (await manifestFile.exists()) ? ((await manifestFile.json()) as ContextManifest) : null;
  const systemPrompt = await loadPrompt("chat");
  const servers = mcpServersFor(cfg, { workspace: paths.runDir, observeOnly: cfg.browser.planObserveOnly });
  const workDirs = [paths.runDir, ...(manifest?.repos ?? []).map((r) => r.path)];
  const meter = new UsageMeter();
  const history: ChatTurn[] = [];
  let notes = await readNotes(paths.notes);
  let applied = 0;

  opts.asker.info(
    `Chatting with ${opts.agent.id} about ${opts.ticket} (plan ${opts.runId}).\n` +
      `Ask what it will test and how (e.g. "which route does TC-002 use?"), or tell it what to consider (test data, accounts, focus).\n` +
      `Press Enter on an empty line, or type exit, to finish.`,
  );
  for (let turn = 1; turn <= (opts.maxTurns ?? 50); turn++) {
    const message = await opts.asker.ask({ id: `CHAT-${turn}`, question: "You", why: "", options: [] }, { allowEmpty: true });
    if (!message || EXIT.test(message)) break;

    const doc: TestCasesDoc = parseTestCases(await Bun.file(paths.testCases).text());
    const reply = await runAgentJson(
      opts.agent,
      {
        prompt: buildChatPrompt(paths, manifest, await Bun.file(paths.testCases).text(), notes, history, message),
        systemPrompt,
        mcpServers: servers,
        workDirs,
        mode: "chat",
        timeoutMs: cfg.agent.timeoutSec * 1000,
        model: cfg.agent.model,
        extraArgs: cfg.agent.extraArgs,
      },
      ChatReplySchema,
      join(paths.transcriptsDir, `chat-${new Date().toISOString().replace(/[:.]/g, "-")}`),
      { meter, label: `chat ${turn}` },
    );
    opts.asker.info(`${opts.agent.id}: ${reply.answer}${cfg.agent.showUsage ? `\n(AI usage: ${formatUsage(meter.total(`chat ${turn}`))})` : ""}`);

    const added = mergeNotes(notes, reply.notes).slice(notes.length);
    if (added.length) {
      notes = [...notes, ...added];
      await writeText(paths.notes, renderNotes(opts.ticket, notes));
      opts.asker.info(`Saved to notes.md (used by every test case):\n${added.map((n) => `  • ${n}`).join("\n")}`);
    }

    if (reply.testCases?.length) {
      const changes = describeCaseChanges(doc.cases, reply.testCases);
      if (changes.length && (await opts.asker.confirm(`Apply these changes to test-cases.md?\n${changes.map((c) => `  ${c}`).join("\n")}`))) {
        await writeText(paths.testCases, renderTestCases({ ...doc, cases: reply.testCases }));
        applied++;
        opts.asker.info("test-cases.md updated.");
      }
    }

    history.push({ user: message, agent: reply.answer });
    await appendChat(paths.chat, opts.ticket, { user: message, agent: reply.answer, at: new Date().toISOString().slice(0, 19).replace("T", " ") });
  }
  return { paths, notes, turns: history.length, applied, usage: meter };
}
