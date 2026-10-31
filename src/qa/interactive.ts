/** Terminal Q&A. The interface lets tests and non-TTY runs swap in a scripted answerer. */
import * as p from "@clack/prompts";
import type { Question } from "../phases/protocol.ts";

export interface Asker {
  ask(q: Question): Promise<string>;
  confirm(message: string): Promise<boolean>;
  info(message: string): void;
}

const OTHER = "__other__";

export class TerminalAsker implements Asker {
  async ask(q: Question): Promise<string> {
    p.note(q.why || "", `${q.id}: ${q.question}`);
    let answer: string | symbol;
    if (q.options.length) {
      answer = await p.select({
        message: q.question,
        options: [...q.options.map((o) => ({ value: o, label: o })), { value: OTHER, label: "Other (type an answer)" }],
      });
      if (answer === OTHER) answer = await p.text({ message: "Your answer" });
    } else {
      answer = await p.text({ message: q.question, validate: (v) => (v?.trim() ? undefined : "An answer is required") });
    }
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(130);
    }
    return String(answer).trim();
  }

  async confirm(message: string): Promise<boolean> {
    const r = await p.confirm({ message });
    if (p.isCancel(r)) process.exit(130);
    return r;
  }

  info(message: string) {
    p.log.info(message);
  }
}

/** Answers from a fixed map / default; used by tests and `--answers file.json`. */
export class ScriptedAsker implements Asker {
  readonly asked: Question[] = [];
  constructor(
    private readonly answers: Record<string, string> = {},
    private readonly fallback = "No preference",
    private readonly confirmAll = true,
  ) {}
  async ask(q: Question) {
    this.asked.push(q);
    return this.answers[q.id] ?? this.answers[q.question] ?? this.fallback;
  }
  async confirm() {
    return this.confirmAll;
  }
  info() {}
}
