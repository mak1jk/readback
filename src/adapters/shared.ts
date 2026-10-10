import type { AgentId, RawRow, Session, Tokens, ToolStep, Turn } from '../model';
import { lines } from '../lib/lines';

export const decode = (input: string | Uint8Array) => typeof input === 'string' ? input : new TextDecoder().decode(input);
export const time = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
export function jsonRows(input: string | Uint8Array): RawRow[] {
  const rows: RawRow[] = [];
  let li = 0;
  for (const line of lines(input)) {
    li++;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      Object.defineProperty(row, '__line', { value: li, enumerable: false });
      rows.push(row);
    } catch { /* partial last line in a live session */ }
  }
  return rows;
}
export function textOf(value: any): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);
  if (typeof value.text === 'string') return value.text;
  if (value.functionResponse) return textOf(value.functionResponse.response);
  if (value.output !== undefined) return textOf(value.output);
  if (value.content !== undefined) return textOf(value.content);
  if (value.type === 'image' || value.inlineData || value.fileData) return '[Image attachment]';
  if (value.functionCall) return '';
  return JSON.stringify(value, null, 2);
}
export function argumentsOf(value: any): Record<string, any> {
  if (typeof value === 'string') {
    try { return argumentsOf(JSON.parse(value)); } catch { return { input: value }; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const emptyTokens = (): Tokens => ({ input: 0, cached: 0, output: 0, reasoning: 0 });

/** Shared model construction; format-specific interpretation stays in each adapter. */
export class SessionBuilder {
  session: Session;
  turn: Turn | null = null;
  calls = new Map<string, ToolStep>();
  private usages = new Map<string, Tokens>();
  constructor(agent: AgentId, file: string) {
    this.session = { id: file, agent, title: '', file, cwd: '', repo: '', branch: '', model: '', cli: '', provider: '', started: 0, ended: 0, contextWindow: null, tokens: null, counts: { tools: 0, reasoning: 0, messages: 0, failed: 0 }, turns: [] };
  }
  touch(t: number, row?: RawRow): Turn {
    if (!this.turn) this.prompt('', t, []);
    const turn = this.turn!;
    if (t) {
      turn.start = turn.start ? Math.min(turn.start, t) : t;
      turn.end = Math.max(turn.end, t);
      this.session.started = this.session.started ? Math.min(this.session.started, t) : t;
      this.session.ended = Math.max(this.session.ended, t);
    }
    if (row && !turn.rows.includes(row)) turn.rows.push(row);
    return turn;
  }
  prompt(text: string, t: number, raw: RawRow[]): Turn {
    this.turn = { id: 't' + this.session.turns.length, start: t, end: t, aborted: false, prompt: text, promptRows: raw, context: [], steps: [], tokens: null, rows: [...raw] };
    this.session.turns.push(this.turn);
    this.touch(t);
    if (!this.session.title && text.trim()) this.session.title = text.trim().split('\n')[0].slice(0, 120);
    return this.turn;
  }
  step(kind: 'message' | 'reasoning' | 'compaction', text: string, t: number, row: RawRow) {
    if (text.trim()) this.touch(t, row).steps.push({ kind, text, t, raw: [row] });
  }
  tool(id: string, name: string, input: any, t: number, row: RawRow): ToolStep {
    const existing = this.calls.get(id);
    if (existing) return existing;
    const args = argumentsOf(input);
    const command = args.cmd ?? args.command;
    const cmd = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : String(args.file_path ?? args.filePath ?? args.path ?? args.pattern ?? args.query ?? args.url ?? '');
    const st: ToolStep = { kind: 'tool', t, name, cmd, args, detail: '', workdir: args.workdir || args.cwd || this.session.cwd, output: '', exit: null, wall: null, done: null, raw: [row] };
    this.touch(t, row).steps.push(st);
    this.calls.set(id, st);
    return st;
  }
  result(id: string, output: any, t: number, row: RawRow, failed?: boolean, exit?: number) {
    const st = this.calls.get(id);
    if (!st) {
      this.step('message', 'Tool result (call unavailable):\n' + textOf(output), t, row);
      return;
    }
    st.output = textOf(output);
    st.done = t || null;
    st.error = failed;
    st.exit = typeof exit === 'number' ? exit : null;
    st.raw.push(row);
    this.touch(t, row);
  }
  usage(id: string, value: Tokens) {
    const old = this.usages.get(id) || emptyTokens();
    this.usages.set(id, value);
    const turn = this.turn;
    this.session.tokens ||= emptyTokens();
    if (turn) turn.tokens ||= emptyTokens();
    for (const k of ['input', 'cached', 'output', 'reasoning'] as const) {
      const delta = Math.max(0, value[k] || 0) - old[k];
      this.session.tokens[k] += delta;
      if (turn?.tokens) turn.tokens[k] += delta;
    }
  }
  finish(): Session | null {
    const s = this.session;
    s.turns = s.turns.filter((t) => t.prompt || t.steps.length);
    if (!s.turns.length) return null;
    s.title ||= s.file || 'Continued session';
    for (const turn of s.turns) for (const step of turn.steps) {
      if (step.kind === 'tool') {
        s.counts.tools++;
        if (step.error || (step.exit != null && step.exit !== 0)) s.counts.failed++;
      } else if (step.kind === 'reasoning') s.counts.reasoning++;
      else if (step.kind === 'message') s.counts.messages++;
    }
    return s;
  }
}
