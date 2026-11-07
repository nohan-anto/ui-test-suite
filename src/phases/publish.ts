/** `uitest publish`: post a finished test run's report to the Jira story as a comment, with screenshots attached. */
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildJiraComment, type CommentImage } from "../artifacts/jira-comment.ts";
import type { CaseResult, RunMeta } from "../artifacts/report.ts";
import type { Config } from "../config/schema.ts";
import type { Asker } from "../qa/interactive.ts";
import type { FetchFn } from "../sources/jira/client.ts";
import { JiraPublisher } from "../sources/jira/publish.ts";
import { writeText } from "../util/index.ts";
import { runPaths } from "./paths.ts";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export interface PublishOptions {
  ticket: string;
  runId: string;
  testRunId: string;
  /** Issue to comment on (default: the ticket). */
  to?: string;
  dryRun?: boolean;
  asker: Asker;
  fetchFn?: FetchFn;
}

export interface EvidenceFile extends CommentImage {
  path: string;
}

/**
 * Screenshots for each case: files the agent listed, plus images in the evidence dir named after the case
 * (TC-001-step3.png). Carried-over results take their files from the test run they came from.
 * Attachment names carry the test run id so different runs never collide on the issue.
 */
export function collectEvidence(runDir: string, testRunId: string, results: CaseResult[], mode: Config["jira"]["publish"]["attach"]): EvidenceFile[] {
  if (mode === "none") return [];
  const out = new Map<string, EvidenceFile>();
  for (const r of results) {
    if (mode === "failures" && r.reply.status !== "fail" && r.reply.status !== "blocked") continue;
    const source = r.fromTestRun ?? testRunId;
    const dir = join(runDir, "test-runs", source, "evidence");
    const names = [...r.reply.evidence.map((e) => basename(e))];
    if (existsSync(dir)) names.push(...readdirSync(dir).filter((f) => f.startsWith(`${r.testCase.id}-`) || f.startsWith(`${r.testCase.id}.`)));
    for (const n of names) {
      const path = join(dir, n);
      if (!IMAGE.test(n) || !existsSync(path)) continue;
      const name = `uitest-${source}-${n}`;
      out.set(name, { caseId: r.testCase.id, name, path });
    }
  }
  return [...out.values()];
}

export async function runPublish(cfg: Config, opts: PublishOptions) {
  const pub = cfg.jira.publish;
  if (!pub.enabled && !opts.dryRun) {
    throw new Error("Publishing is off. Set jira.publish.enabled: true in uitest.config.yaml (it needs a Jira token allowed to add comments and attachments), or use --dry-run to preview.");
  }
  const paths = runPaths(cfg, opts.ticket, opts.runId, opts.testRunId);
  const saved = (await Bun.file(paths.results).json().catch(() => null)) as { meta: RunMeta; results: CaseResult[] } | CaseResult[] | null;
  if (!saved || Array.isArray(saved)) throw new Error(`Test run ${opts.testRunId} has no finished results (${paths.results}).`);

  const issue = (opts.to ?? opts.ticket).toUpperCase();
  const images = collectEvidence(paths.runDir, opts.testRunId, saved.results, pub.attach);
  const reportName = pub.attachReport ? `uitest-${opts.testRunId}-test-report.md` : undefined;
  const body = buildJiraComment(saved.meta, saved.results, { testRunId: opts.testRunId, images, reportName });

  const previewPath = join(paths.testRunDir, "jira-comment.txt");
  await writeText(previewPath, body);
  const files = [...images.map((i) => i.name), ...(reportName ? [reportName] : [])];
  opts.asker.info(`Comment for ${issue}: ${body.length} characters (preview: ${previewPath}).\nAttachments (${files.length}): ${files.join(", ") || "none"}`);
  if (opts.dryRun) return { issue, body, images, previewPath, posted: false as const };

  const logPath = join(paths.testRunDir, "published.json");
  const log = (await Bun.file(logPath).json().catch(() => [])) as { issue: string; commentId: string; at: string }[];
  const already = log.find((l) => l.issue === issue);
  const question = already
    ? `Test run ${opts.testRunId} was already posted to ${issue} at ${already.at}. Post it again?`
    : `Post this report as a comment on ${issue}${files.length ? ` with ${files.length} attachment(s)` : ""}?`;
  if (!(await opts.asker.confirm(question))) return { issue, body, images, previewPath, posted: false as const };

  const jira = new JiraPublisher(cfg.jira.baseUrl, pub.email || cfg.jira.email, pub.token || cfg.jira.token, opts.fetchFn);
  const existing = await jira.attachmentNames(issue);
  let uploaded = 0;
  for (const img of images) {
    if (existing.has(img.name)) continue;
    await jira.attach(issue, img.path, img.name);
    uploaded++;
  }
  if (reportName && !existing.has(reportName)) {
    await jira.attach(issue, paths.report, reportName);
    uploaded++;
  }
  const { id } = await jira.comment(issue, body);
  log.push({ issue, commentId: id, at: new Date().toISOString() });
  await writeText(logPath, JSON.stringify(log, null, 2));
  return { issue, body, images, previewPath, posted: true as const, commentId: id, uploaded };
}
