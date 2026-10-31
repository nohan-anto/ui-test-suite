import type { QA } from "../phases/protocol.ts";

export function renderQuestions(ticket: string, qas: QA[]): string {
  const out = [`# Clarifications: ${ticket}`, "", "Questions the agent asked instead of assuming, with your answers.", ""];
  if (!qas.length) out.push("_No questions were asked._");
  let round = -1;
  for (const qa of qas) {
    if (qa.round !== round) {
      round = qa.round;
      out.push(`## Round ${round}`, "");
    }
    out.push(`### ${qa.question.id}: ${qa.question.question}`, "");
    if (qa.question.why) out.push(`_Why:_ ${qa.question.why}`, "");
    out.push(`**Answer:** ${qa.answer}`, "");
  }
  return out.join("\n");
}

/** Format prior Q&A for inclusion in the next agent prompt. */
export function answersForPrompt(qas: QA[]): string {
  if (!qas.length) return "";
  return [
    "## Answers from the user",
    "",
    ...qas.map((qa) => `- **${qa.question.id}** (${qa.question.question}): ${qa.answer}`),
    "",
  ].join("\n");
}
