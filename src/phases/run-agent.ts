import type { z } from "zod";
import { parseAgentJson } from "../agents/json-extract.ts";
import type { AgentAdapter, AgentRequest } from "../agents/types.ts";
import { writeText } from "../util/index.ts";

/** Run the agent and validate its JSON reply; on a bad reply, retry once with the validation error. */
export async function runAgentJson<T>(
  agent: AgentAdapter,
  req: AgentRequest,
  schema: z.ZodType<T>,
  transcriptPath?: string,
): Promise<T> {
  let prompt = req.prompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await agent.run({ ...req, prompt });
    if (transcriptPath) await writeText(`${transcriptPath}.attempt${attempt}.md`, `# Prompt\n\n${prompt}\n\n# Reply\n\n${res.text}\n`);
    const parsed = parseAgentJson(res.text, schema);
    if (parsed.ok) return parsed.value;
    if (attempt === 2) throw new Error(`Agent reply was not valid after retry: ${parsed.error}`);
    prompt = `${req.prompt}\n\n## Your previous reply was invalid\n\n${parsed.error}\n\nReply again, ending with one valid fenced json block in the required shape.`;
  }
  throw new Error("unreachable");
}
