/** Terminal Q&A. The interface lets tests and non-TTY runs swap in a scripted answerer. */
import * as p from "@clack/prompts";
import type { Question } from "../phases/protocol.ts";

export interface AskOptions {
  /** Accept an empty answer (Enter to skip). */
  allowEmpty?: boolean;
}

export interface Choice<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Asker {
  ask(q: Question, opts?: AskOptions): Promise<string>;
  /** Pick one option. `id` names the menu (for scripted answers); Esc returns `escape` when given. */
  select<T extends string>(id: string, message: string, choices: Choice<T>[], escape?: T): Promise<T>;
  /** Pick several options (at least one). */
  multiselect<T extends string>(id: string, message: string, choices: Choice<T>[]): Promise<T[]>;
  confirm(message: string): Promise<boolean>;
  info(message: string): void;
}

const OTHER = "__other__";

export class TerminalAsker implements Asker {
  async ask(q: Question, opts: AskOptions = {}): Promise<string> {
    if (q.why) p.note(q.why, `${q.id}: ${q.question}`);
    let answer: string | symbol;
    if (q.options.length) {
      answer = await p.select({
        message: q.question,
        options: [...q.options.map((o) => ({ value: o, label: o })), { value: OTHER, label: "Other (type an answer)" }],
      });
      if (answer === OTHER) answer = await p.text({ message: "Your answer" });
    } else {
      answer = await p.text({ message: q.question, validate: (v) => (v?.trim() || opts.allowEmpty ? undefined : "An answer is required") });
    }
    if (p.isCancel(answer) && opts.allowEmpty) return "";
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(130);
    }
    return String(answer ?? "").trim();
  }

  async select<T extends string>(_id: string, message: string, choices: Choice<T>[], escape?: T): Promise<T> {
    const r = await p.select<T>({ message, options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) as any });
    if (p.isCancel(r)) {
      if (escape !== undefined) return escape;
      p.cancel("Cancelled.");
      process.exit(130);
    }
    return r as T;
  }

  async multiselect<T extends string>(_id: string, message: string, choices: Choice<T>[]): Promise<T[]> {
    const r = await p.multiselect<T>({ message, options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) as any, required: true });
    if (p.isCancel(r)) return [];
    return r as T[];
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

/**
 * Answers from a fixed map / default; used by tests and `--answers file.json`.
 * A value may be a list, consumed one answer per call (for menus shown more than once).
 * Menus with no scripted answer pick the escape value, else the first choice.
 */
export class ScriptedAsker implements Asker {
  readonly asked: Question[] = [];
  readonly menus: string[] = [];
  constructor(
    private readonly answers: Record<string, string | string[]> = {},
    private readonly fallback = "No preference",
    private readonly confirmAll = true,
  ) {}
  private take(key: string): string | undefined {
    const v = this.answers[key];
    return Array.isArray(v) ? v.shift() : v;
  }
  async ask(q: Question, opts: AskOptions = {}) {
    this.asked.push(q);
    return this.take(q.id) ?? this.take(q.question) ?? (opts.allowEmpty ? "" : this.fallback);
  }
  async select<T extends string>(id: string, _message: string, choices: Choice<T>[], escape?: T): Promise<T> {
    this.menus.push(id);
    const a = this.take(id);
    if (a !== undefined) {
      const c = choices.find((c) => c.value === a);
      if (!c) throw new Error(`Scripted answer "${a}" for menu ${id} is not one of: ${choices.map((c) => c.value).join(", ")}`);
      return c.value;
    }
    return escape ?? choices[0]!.value;
  }
  async multiselect<T extends string>(id: string, _message: string, choices: Choice<T>[]): Promise<T[]> {
    this.menus.push(id);
    const a = this.take(id);
    return a === undefined ? choices.map((c) => c.value) : (a.split(",").map((s) => s.trim()) as T[]).filter((v) => choices.some((c) => c.value === v));
  }
  async confirm() {
    return this.confirmAll;
  }
  info() {}
}
