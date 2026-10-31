import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../util/index.ts";
import type { AgentAdapter, AgentRequest, AgentResponse, DoctorResult, Invocation } from "./types.ts";

/** Shared plumbing for adapters that shell out to an agent CLI. Subclasses only build the command line. */
export abstract class CliAdapter implements AgentAdapter {
  abstract readonly id: string;
  constructor(protected readonly bin: string) {}

  /** Flags this adapter relies on; doctor() warns if `--help` does not mention them. */
  protected abstract requiredFlags: string[];
  abstract buildInvocation(req: AgentRequest, tmp: string): Invocation;
  /** Extract the agent's final text from CLI stdout. */
  protected parseOutput(stdout: string): { text: string; raw: unknown } {
    return { text: stdout, raw: stdout };
  }

  async doctor(): Promise<DoctorResult> {
    const v = await exec([this.bin, "--version"], { timeoutMs: 20_000 });
    if (v.code !== 0) return { ok: false, messages: [`${this.bin} not runnable: ${v.stderr.trim() || "not found"}`] };
    const help = await exec([this.bin, ...this.helpArgs()], { timeoutMs: 20_000 });
    const text = help.stdout + help.stderr;
    const missing = this.requiredFlags.filter((f) => !text.includes(f));
    return {
      ok: missing.length === 0,
      version: v.stdout.trim().split("\n")[0],
      messages: missing.length ? [`CLI help does not mention: ${missing.join(", ")} — adapter may need updating`] : [],
    };
  }

  protected helpArgs(): string[] {
    return ["--help"];
  }

  async run(req: AgentRequest): Promise<AgentResponse> {
    const tmp = mkdtempSync(join(tmpdir(), `uitest-${this.id}-`));
    try {
      const inv = this.buildInvocation(req, tmp);
      for (const [p, c] of Object.entries(inv.files)) await Bun.write(p, c);
      const r = await exec(inv.cmd, { cwd: req.workDirs[0], timeoutMs: req.timeoutMs, stdin: inv.stdin });
      if (r.timedOut) throw new Error(`${this.id} timed out after ${Math.round(req.timeoutMs / 1000)}s`);
      if (r.code !== 0) throw new Error(`${this.id} exited ${r.code}: ${(r.stderr || r.stdout).slice(-2000)}`);
      if (inv.outputFile) {
        const f = Bun.file(inv.outputFile);
        if (await f.exists()) return { text: await f.text(), raw: r.stdout };
      }
      return this.parseOutput(r.stdout);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
