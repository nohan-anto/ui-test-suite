/** JSON contracts between the orchestrator and any agent. Every adapter's reply is validated against these. */
import { z } from "zod";

export const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string().default(""),
  options: z.array(z.string()).default([]),
});
export type Question = z.infer<typeof QuestionSchema>;

export const TestCaseSchema = z.object({
  id: z.string().regex(/^TC-\d{3,}$/),
  title: z.string(),
  priority: z.enum(["P1", "P2", "P3"]).default("P2"),
  tracesTo: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  testData: z.array(z.string()).default([]),
  steps: z.array(z.string()).min(1),
  expected: z.array(z.string()).min(1),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const PlanReplySchema = z.object({
  summary: z.string().default(""),
  assumptionsAvoided: z.array(z.string()).default([]),
  questions: z.array(QuestionSchema).default([]),
  testCases: z.array(TestCaseSchema).default([]),
});
export type PlanReply = z.infer<typeof PlanReplySchema>;

export const StepResultSchema = z.object({
  n: z.number().int(),
  actual: z.string(),
  ok: z.boolean(),
});

export const TestReplySchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "fail", "blocked", "skipped"]),
  steps: z.array(StepResultSchema).default([]),
  notes: z.string().default(""),
  consoleErrors: z.array(z.string()).default([]),
  failedRequests: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  questions: z.array(QuestionSchema).default([]),
});
export type TestReply = z.infer<typeof TestReplySchema>;

export interface QA {
  round: number;
  question: Question;
  answer: string;
}
