import { join } from "node:path";
import { toMcpJson } from "../mcp/servers.ts";
import { CliAdapter } from "./cli-adapter.ts";
import type { AgentRequest, Invocation } from "./types.ts";

/** GitHub Copilot CLI: `copilot -p` programmatic mode. */
export class CopilotAdapter extends CliAdapter {
  readonly id = "copilot";
  protected requiredFlags = ["--prompt", "--additional-mcp-config", "--allow-tool", "--add-dir"];

  constructor(bin = "copilot") {
    super(bin);
  }

  buildInvocation(req: AgentRequest, tmp: string): Invocation {
    const mcpPath = join(tmp, "mcp.json");
    // Copilot has no system-prompt flag in -p mode; prepend it. The prompt itself stays small
    // because large context lives in files the agent reads.
    const prompt = `${req.systemPrompt}\n\n---\n\n${req.prompt}`;
    const cmd = [this.bin, "-p", prompt, "--additional-mcp-config", `@${mcpPath}`, "--no-color"];
    for (const s of req.mcpServers) cmd.push("--allow-tool", s.name);
    cmd.push("--deny-tool", "write", "--deny-tool", "shell");
    for (const d of req.workDirs) cmd.push("--add-dir", d);
    if (req.model) cmd.push("--model", req.model);
    cmd.push(...(req.extraArgs ?? []));
    return { cmd, files: { [mcpPath]: JSON.stringify(toMcpJson(req.mcpServers, "copilot"), null, 2) } };
  }
}
