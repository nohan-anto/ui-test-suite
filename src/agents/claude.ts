import { join } from "node:path";
import { toMcpJson } from "../mcp/servers.ts";
import { CliAdapter } from "./cli-adapter.ts";
import type { AgentRequest, Invocation } from "./types.ts";

/** Claude Code: `claude -p` headless mode. */
export class ClaudeAdapter extends CliAdapter {
  readonly id = "claude";
  protected requiredFlags = ["--print", "--output-format", "--mcp-config", "--add-dir", "--allowedTools"];

  constructor(bin = "claude") {
    super(bin);
  }

  buildInvocation(req: AgentRequest, tmp: string): Invocation {
    const mcpPath = join(tmp, "mcp.json");
    const systemPath = join(tmp, "system-prompt.md");
    const allowed = ["Read", "Grep", "Glob", ...req.mcpServers.map((s) => `mcp__${s.name}`)];
    const cmd = [
      this.bin,
      "-p",
      "--output-format", "json",
      "--mcp-config", mcpPath,
      "--strict-mcp-config",
      "--append-system-prompt-file", systemPath,
      "--allowedTools", allowed.join(","),
      "--disallowedTools", "Write,Edit,NotebookEdit,Bash",
    ];
    for (const d of req.workDirs.slice(1)) cmd.push("--add-dir", d);
    if (req.model) cmd.push("--model", req.model);
    cmd.push(...(req.extraArgs ?? []));
    return {
      cmd,
      stdin: req.prompt,
      files: {
        [mcpPath]: JSON.stringify(toMcpJson(req.mcpServers, "claude"), null, 2),
        [systemPath]: req.systemPrompt,
      },
    };
  }

  protected override parseOutput(stdout: string) {
    try {
      const j = JSON.parse(stdout);
      if (j.is_error) throw new Error(`claude reported error: ${j.result ?? j.subtype}`);
      return { text: String(j.result ?? ""), raw: j };
    } catch (e) {
      if ((e as Error).message.startsWith("claude reported")) throw e;
      return { text: stdout, raw: stdout };
    }
  }
}
