import type { AgentAdapter, AgentRequest, AgentResponse } from "./types.ts";

/**
 * Deterministic offline agent for tests and dry runs.
 * Plan mode: asks one question on the first round, then returns two test cases.
 * Test mode: passes every case except those whose title contains "[mock-fail]".
 */
export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly calls: AgentRequest[] = [];

  async doctor() {
    return { ok: true, version: "mock", messages: [] };
  }

  async run(req: AgentRequest): Promise<AgentResponse> {
    this.calls.push(req);
    const reply = req.mode === "plan" ? this.plan(req.prompt) : this.test(req.prompt);
    const text = `Mock agent reply.\n\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;
    return { text, raw: reply };
  }

  private plan(prompt: string) {
    if (!prompt.includes("## Answers from the user")) {
      return {
        summary: "Need clarification before finalising scenarios.",
        questions: [
          {
            id: "Q1",
            question: "Which user role should the scenarios run as?",
            why: "The story does not state the role and permissions differ per role.",
            options: ["Admin", "Standard user"],
          },
        ],
        testCases: [],
      };
    }
    return {
      summary: "Two scenarios covering the happy path and validation.",
      questions: [],
      testCases: [
        {
          id: "TC-001",
          title: "Happy path renders the new screen",
          priority: "P1",
          tracesTo: ["AC-1"],
          tags: [],
          preconditions: ["User is signed in"],
          testData: [],
          steps: ["Open the app base URL", "Navigate to the feature page"],
          expected: ["The feature page shows the heading from the story"],
        },
        {
          id: "TC-002",
          title: "Validation message on empty input [mock-fail]",
          priority: "P2",
          tracesTo: ["AC-2"],
          tags: [],
          preconditions: ["User is on the feature page"],
          testData: ["Empty input"],
          steps: ["Leave the field empty", "Click Save"],
          expected: ["An inline validation error is shown"],
        },
      ],
    };
  }

  private test(prompt: string) {
    const id = prompt.match(/\bTC-\d{3,}\b/)?.[0] ?? "TC-000";
    const fail = prompt.includes("[mock-fail]");
    return {
      id,
      status: fail ? "fail" : "pass",
      steps: [
        { n: 1, actual: "Step completed", ok: true },
        { n: 2, actual: fail ? "No validation message appeared" : "Step completed", ok: !fail },
      ],
      notes: fail ? "Expected inline error was not rendered." : "",
      consoleErrors: fail ? ["TypeError: cannot read properties of undefined (mock)"] : [],
      failedRequests: [],
      evidence: [],
    };
  }
}
