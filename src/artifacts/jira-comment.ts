/** Test results → a Jira comment (wiki markup) with screenshots shown inline from the issue's attachments. */
import type { CaseResult, RunMeta } from "./report.ts";
import { summarise } from "./report.ts";

/** Jira's comment limit is 32 767 characters; leave room for the footer. */
export const MAX_COMMENT_CHARS = 30_000;

const ICON = { pass: "(/)", fail: "(x)", blocked: "(!)", skipped: "(off)" } as const;

/** Escape characters that start wiki markup (tables, links, images, macros, text effects). */
export const wikiEscape = (s: string) => s.replace(/\r?\n/g, " ").replace(/([|{}\[\]!*_^~+#\\-])/g, "\\$1");

export interface CommentImage {
  caseId: string;
  /** File name as attached to the issue. */
  name: string;
}

export function buildJiraComment(
  meta: RunMeta,
  results: CaseResult[],
  opts: { testRunId: string; images: CommentImage[]; reportName?: string },
): string {
  const c = summarise(results);
  const verdict = c.fail || c.blocked ? `${ICON.fail} *FAILED*` : results.length ? `${ICON.pass} *PASSED*` : "*NO TESTS RUN*";
  const head = [
    `h3. UI test report: ${wikiEscape(meta.title)}`,
    `${verdict} · ${c.pass} passed · ${c.fail} failed · ${c.blocked} blocked · ${c.skipped} skipped · ${results.length} total`,
    "",
    `*Environment:* ${wikiEscape(meta.environment)} · *Agent:* ${wikiEscape(meta.agent)}${meta.model ? ` (${wikiEscape(meta.model)})` : ""} · *Test run:* ${wikiEscape(opts.testRunId)} · *Finished:* ${wikiEscape(meta.finishedAt)}`,
  ];
  if (meta.mergeRequests.length) {
    head.push(`*Merge requests:* ${meta.mergeRequests.map((m) => wikiEscape(`${m.ref} [${m.state}]${m.sha ? ` @${m.sha.slice(0, 8)}` : ""}`)).join(", ")}`);
  }
  head.push("", "||ID||Title||Priority||Status||");
  for (const r of results) {
    const from = r.fromTestRun ? ` (from ${wikiEscape(r.fromTestRun)})` : "";
    head.push(`|${r.testCase.id}|${wikiEscape(r.testCase.title)}|${r.testCase.priority}|${ICON[r.reply.status]} ${r.reply.status}${from}|`);
  }

  const imagesFor = (id: string) => opts.images.filter((i) => i.caseId === id).map((i) => `!${i.name}|thumbnail!`);
  const sections: string[] = [];
  for (const r of results) {
    const bad = r.reply.status === "fail" || r.reply.status === "blocked";
    const imgs = imagesFor(r.testCase.id);
    if (!bad && !imgs.length) continue;
    const s = ["", `h4. ${ICON[r.reply.status]} ${r.testCase.id}: ${wikiEscape(r.testCase.title)}`];
    if (bad) {
      if (r.error) s.push(`*Error:* ${wikiEscape(r.error)}`);
      s.push("*Expected:*", ...r.testCase.expected.map((e) => `* ${wikiEscape(e)}`));
      const failed = r.reply.steps.filter((st) => !st.ok);
      if (failed.length) {
        s.push("||Step||Action||Actual||");
        for (const st of failed) s.push(`|${st.n}|${wikiEscape(r.testCase.steps[st.n - 1] ?? "")}|${wikiEscape(st.actual)}|`);
      }
      if (r.reply.notes) s.push(`*Notes:* ${wikiEscape(r.reply.notes)}`);
      if (r.reply.consoleErrors.length) s.push("*Console errors:*", ...r.reply.consoleErrors.map((e) => `* {{${e.replace(/[{}]/g, "")}}}`));
      if (r.reply.failedRequests.length) s.push("*Failed requests:*", ...r.reply.failedRequests.map((e) => `* {{${e.replace(/[{}]/g, "")}}}`));
    }
    if (imgs.length) s.push(imgs.join(" "));
    sections.push(s.join("\n"));
  }

  const footer = ["", opts.reportName ? `_Full report attached: [^${opts.reportName}]. Posted by uitest._` : "_Posted by uitest._"];
  let body = [...head, ...sections, ...footer].join("\n");
  if (body.length > MAX_COMMENT_CHARS) {
    // Keep the summary table; drop per-case details from the end until it fits.
    const kept = [...sections];
    const note = "\n\n_Some case details were left out to fit Jira's comment limit; see the attached report._";
    while (kept.length && [...head, ...kept, note, ...footer].join("\n").length > MAX_COMMENT_CHARS) kept.pop();
    body = [...head, ...kept, note, ...footer].join("\n").slice(0, MAX_COMMENT_CHARS);
  }
  return body;
}
