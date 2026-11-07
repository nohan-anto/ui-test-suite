import type { TestCase, TestReply } from "../phases/protocol.ts";

export interface CaseResult {
  testCase: TestCase;
  reply: TestReply;
  durationMs: number;
  error?: string;
  /** Set when this result was carried over from an earlier test run (not re-run this time). */
  fromTestRun?: string;
}

export interface RunMeta {
  ticket: string;
  title: string;
  environment: string;
  agent: string;
  model?: string | null;
  startedAt: string;
  finishedAt: string;
  mergeRequests: { ref: string; state: string; sha?: string | null }[];
  repos: { name: string; head: string; note?: string }[];
}

const ICON: Record<TestReply["status"], string> = { pass: "✅", fail: "❌", blocked: "⛔", skipped: "⏭️" };
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function summarise(results: CaseResult[]) {
  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  for (const r of results) counts[r.reply.status]++;
  return counts;
}

/**
 * `evidenceBase`: evidence dir of this test run, relative to the report.
 * `evidenceFor`: evidence dir of an earlier test run (for carried-over results), relative to the report.
 */
export function renderReport(
  meta: RunMeta,
  results: CaseResult[],
  evidenceBase = "evidence",
  evidenceFor: (testRunId: string) => string = (id) => `../${id}/evidence`,
): string {
  const c = summarise(results);
  const carried = results.filter((r) => r.fromTestRun);
  const verdict = c.fail || c.blocked ? "FAILED" : results.length ? "PASSED" : "NO TESTS RUN";
  const out = [
    `# Test report: ${meta.ticket} — ${meta.title}`,
    "",
    `**Result: ${verdict}** · ${c.pass} passed · ${c.fail} failed · ${c.blocked} blocked · ${c.skipped} skipped · ${results.length} total`,
    "",
    "## Run",
    "",
    `- **Environment:** ${meta.environment}`,
    `- **Agent:** ${meta.agent}${meta.model ? ` (${meta.model})` : ""}`,
    `- **Started:** ${meta.startedAt}`,
    `- **Finished:** ${meta.finishedAt}`,
  ];
  if (carried.length) {
    out.push(
      `- **Re-run:** ${results.length - carried.length} case(s) ran in this test run; ${carried.length} result(s) carried over from earlier runs (marked ↩).`,
    );
  }
  if (meta.mergeRequests.length)
    out.push(`- **Merge requests:** ${meta.mergeRequests.map((m) => `${m.ref} [${m.state}]${m.sha ? ` @${m.sha.slice(0, 8)}` : ""}`).join(", ")}`);
  for (const r of meta.repos) out.push(`- **Repo ${r.name}:** HEAD ${r.head.slice(0, 8)}${r.note ? ` — ${r.note}` : ""}`);

  out.push("", "## Summary", "", "| ID | Title | Priority | Status | Duration |", "| --- | --- | --- | --- | --- |");
  for (const r of results) {
    out.push(
      `| ${r.testCase.id} | ${esc(r.testCase.title)} | ${r.testCase.priority} | ${ICON[r.reply.status]} ${r.reply.status}${r.fromTestRun ? ` ↩ ${r.fromTestRun}` : ""} | ${(r.durationMs / 1000).toFixed(0)}s |`,
    );
  }

  const failed = results.filter((r) => r.reply.status === "fail" || r.reply.status === "blocked");
  if (failed.length) {
    out.push("", "## Failures and blocked cases", "");
    for (const r of failed) {
      out.push(`### ${ICON[r.reply.status]} ${r.testCase.id}: ${r.testCase.title}`, "");
      if (r.error) out.push(`**Error:** ${r.error}`, "");
      out.push("**Expected**", "", ...r.testCase.expected.map((e) => `- ${e}`), "");
      const bad = r.reply.steps.filter((s) => !s.ok);
      if (bad.length) {
        out.push("**Failed steps**", "", "| Step | Action | Actual |", "| --- | --- | --- |");
        for (const s of bad) out.push(`| ${s.n} | ${esc(r.testCase.steps[s.n - 1] ?? "")} | ${esc(s.actual)} |`);
        out.push("");
      }
      if (r.reply.notes) out.push(`**Notes:** ${r.reply.notes}`, "");
      if (r.reply.consoleErrors.length) out.push("**Console errors**", "", ...r.reply.consoleErrors.map((e) => `- \`${e}\``), "");
      if (r.reply.failedRequests.length) out.push("**Failed requests**", "", ...r.reply.failedRequests.map((e) => `- \`${e}\``), "");
    }
  }

  out.push("", "## Case details", "");
  for (const r of results) {
    out.push(`### ${ICON[r.reply.status]} ${r.testCase.id}: ${r.testCase.title}`, "");
    if (r.reply.steps.length) {
      out.push("| # | Step | Actual | OK |", "| --- | --- | --- | --- |");
      for (const s of r.reply.steps) out.push(`| ${s.n} | ${esc(r.testCase.steps[s.n - 1] ?? "")} | ${esc(s.actual)} | ${s.ok ? "✅" : "❌"} |`);
      out.push("");
    }
    if (r.fromTestRun) out.push(`_Carried over from test run ${r.fromTestRun}; not re-run._`, "");
    if (r.reply.evidence.length) {
      const base = r.fromTestRun ? evidenceFor(r.fromTestRun) : evidenceBase;
      out.push("**Evidence**", "", ...r.reply.evidence.map((e) => (/\.(png|jpe?g|webp)$/i.test(e) ? `![${e}](${base}/${e})` : `- ${e}`)), "");
    }
  }

  const traces = new Map<string, CaseResult[]>();
  for (const r of results) for (const t of r.testCase.tracesTo.length ? r.testCase.tracesTo : ["(untraced)"]) {
    traces.set(t, [...(traces.get(t) ?? []), r]);
  }
  out.push("## Traceability", "", "| Requirement | Test cases | Status |", "| --- | --- | --- |");
  for (const [req, rs] of traces) {
    const worst = rs.some((r) => r.reply.status === "fail") ? "fail" : rs.some((r) => r.reply.status === "blocked") ? "blocked" : rs.every((r) => r.reply.status === "skipped") ? "skipped" : "pass";
    out.push(`| ${esc(req)} | ${rs.map((r) => r.testCase.id).join(", ")} | ${ICON[worst]} ${worst} |`);
  }
  out.push("");
  return out.join("\n");
}
