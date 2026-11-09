import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config/schema.ts";

export const PROMPTS_DIR = resolve(import.meta.dir, "../../prompts");

export interface RunPaths {
  runDir: string;
  contextDir: string;
  transcriptsDir: string;
  testCases: string;
  questions: string;
  /** Things to consider, from `uitest chat` / the pre-test prompt. */
  notes: string;
  /** Transcript of `uitest chat` conversations. */
  chat: string;
  /** Copy of the most recent test run's report. */
  latestReport: string;
  /** One directory per `uitest test` execution, so re-runs keep history. */
  testRunDir: string;
  evidenceDir: string;
  report: string;
  results: string;
}

/**
 * Layout: runs/<TICKET>/<runId>/{context/, test-cases.md, questions.md, test-report.md,
 *         test-runs/<testRunId>/{evidence/, results.json, test-report.md}}
 */
export function runPaths(cfg: Config, ticket: string, runId: string, testRunId = "latest"): RunPaths {
  const runDir = resolve(cfg.output.dir, ticket, runId);
  const testRunDir = join(runDir, "test-runs", testRunId);
  return {
    runDir,
    contextDir: join(runDir, "context"),
    transcriptsDir: join(runDir, "transcripts"),
    testCases: join(runDir, "test-cases.md"),
    questions: join(runDir, "questions.md"),
    notes: join(runDir, "notes.md"),
    chat: join(runDir, "chat.md"),
    latestReport: join(runDir, "test-report.md"),
    testRunDir,
    evidenceDir: join(testRunDir, "evidence"),
    report: join(testRunDir, "test-report.md"),
    results: join(testRunDir, "results.json"),
  };
}

export function latestTestRunId(paths: RunPaths): string | null {
  const dir = join(paths.runDir, "test-runs");
  if (!existsSync(dir)) return null;
  return readdirSync(dir).sort().at(-1) ?? null;
}

/** Most recent run id for a ticket (run ids are sortable timestamps). */
export function latestRunId(cfg: Config, ticket: string): string | null {
  const dir = resolve(cfg.output.dir, ticket);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return runs.at(-1) ?? null;
}

export async function loadPrompt(name: "plan" | "test" | "chat"): Promise<string> {
  return Bun.file(join(PROMPTS_DIR, `${name}.md`)).text();
}
