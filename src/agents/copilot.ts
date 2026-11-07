import { join } from "node:path";
import { toMcpJson } from "../mcp/servers.ts";
import { CliAdapter } from "./cli-adapter.ts";
import type { AgentRequest, Invocation } from "./types.ts";
import { copilotUsage } from "./usage.ts";

/** GitHub Copilot CLI: `copilot -p` programmatic mode. */
export class CopilotAdapter extends CliAdapter {
  readonly id = "copilot";
  protected requiredFlags = ["--prompt", "--additional-mcp-config", "--allow-tool", "--add-dir"];

  constructor(bin = "copilot") {
    super(bin);
  }

  /** Copilot prints an end-of-session usage summary (premium requests, tokens per model); parsed best-effort. */
  protected override parseUsage(stdout: string, stderr: string) {
    return copilotUsage(stdout, stderr);
  }

  buildInvocation(req: AgentRequest, tmp: string): Invocation {
    const mcpPath = join(tmp, "mcp.json");
    const taskPath = join(tmp, "task.md");
    // Copilot takes the prompt as an argument and has no system-prompt flag. Passing a long multi-line
    // argument is fragile (cmd.exe on Windows), so the full instructions go in a file the agent reads first.
    const prompt = `Read the file ${taskPath} and follow its instructions exactly. Your final reply must end with the JSON block it describes.`;
    const cmd = [this.bin, "-p", prompt, "--additional-mcp-config", `@${mcpPath}`, "--no-color"];
    for (const s of req.mcpServers) cmd.push("--allow-tool", s.name);
    cmd.push("--deny-tool", "write", "--deny-tool", "shell");
    for (const d of [tmp, ...req.workDirs]) cmd.push("--add-dir", d);
    if (req.model) cmd.push("--model", req.model);
    cmd.push(...(req.extraArgs ?? []));
    return {
      cmd,
      files: {
        [mcpPath]: JSON.stringify(toMcpJson(req.mcpServers, "copilot"), null, 2),
        [taskPath]: `${req.systemPrompt}\n\n---\n\n${req.prompt}`,
      },
    };
  }
}
