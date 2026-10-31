import { join } from "node:path";
import { toCodexOverrides } from "../mcp/servers.ts";
import { CliAdapter } from "./cli-adapter.ts";
import type { AgentRequest, Invocation } from "./types.ts";

/** OpenAI Codex CLI: `codex exec` non-interactive mode. Prompt goes via stdin ("-"), final message via -o file. */
export class CodexAdapter extends CliAdapter {
  readonly id = "codex";
  protected requiredFlags = ["--sandbox", "--output-last-message", "--add-dir", "--skip-git-repo-check"];

  constructor(bin = "codex") {
    super(bin);
  }

  protected override helpArgs() {
    return ["exec", "--help"];
  }

  buildInvocation(req: AgentRequest, tmp: string): Invocation {
    const out = join(tmp, "last-message.txt");
    const cmd = [
      this.bin,
      "exec",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--cd", req.workDirs[0]!,
      "--output-last-message", out,
      "-c", 'approval_policy="never"',
      ...toCodexOverrides(req.mcpServers),
    ];
    for (const d of req.workDirs.slice(1)) cmd.push("--add-dir", d);
    if (req.model) cmd.push("--model", req.model);
    cmd.push(...(req.extraArgs ?? []), "-");
    // Codex has no system-prompt flag for exec; prepend it.
    return { cmd, stdin: `${req.systemPrompt}\n\n---\n\n${req.prompt}`, files: {}, outputFile: out };
  }
}
