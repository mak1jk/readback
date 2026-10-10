// Codex CLI rollout adapter: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl → Session.
// Ported from the design prototype's codex-parser.js (tested against real rollouts).
import type { ContextItem, RawRow, Session, ToolStep, Turn } from '../model';
import { lines } from '../lib/lines';

const CTX_PREFIXES: [string, string][] = [
  ['# AGENTS.md', 'AGENTS.md'],
  ['<environment_context>', 'Environment'],
  ['# Context from my IDE setup', 'IDE context'],
  ['<user_instructions>', 'Instructions'],
];

interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export function parseCodexJsonl(input: string | Uint8Array, fileName = ''): Session | null {
  const rows: RawRow[] = [];
  let li = 0;
  for (const l of lines(input)) {
    li++;
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (!o || typeof o !== 'object') continue;
      Object.defineProperty(o, '__line', { value: li, enumerable: false });
      rows.push(o);
    } catch {
      /* skip malformed line */
    }
  }
  if (!rows.length) return null;

  const S: Session = {
    id: '', agent: 'codex', title: '', file: fileName, cwd: '', repo: '', branch: '', model: '', cli: '', provider: '',
    started: NaN, ended: NaN, tokens: null, contextWindow: null, turns: [],
    counts: { tools: 0, reasoning: 0, messages: 0, failed: 0 },
  };
  let turn: Turn | null = null;
  const calls: Record<string, ToolStep> = {};
  const byId: Record<string, Turn> = {};
  // Tool calls waiting for the token_count that reports the request which produced them.
  let pend: ToolStep[] = [];
  let lastTotal: Usage | null = null;
  let prevTotal: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

  const ts = (r: RawRow) => new Date(r.timestamp).getTime();
  const newTurn = (t: number): Turn => {
    turn = { id: 't' + S.turns.length, start: t, end: t, aborted: false, prompt: '', promptRows: [], context: [], steps: [], tokens: null, rows: [] };
    S.turns.push(turn);
    return turn;
  };
  const closeTurn = () => {
    if (turn && lastTotal) {
      turn.tokens = {
        input: lastTotal.input_tokens - prevTotal.input_tokens,
        cached: lastTotal.cached_input_tokens - prevTotal.cached_input_tokens,
        output: lastTotal.output_tokens - prevTotal.output_tokens,
        reasoning: (lastTotal.reasoning_output_tokens || 0) - (prevTotal.reasoning_output_tokens || 0),
      };
      prevTotal = lastTotal;
    }
  };
  const textOf = (c: unknown): string =>
    Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('\n') : typeof c === 'string' ? c : '';

  const handle = (r: RawRow) => {
    const p = r.payload || {};
    const t = ts(r);
    if (!Number.isNaN(t)) {
      if (Number.isNaN(S.started) || t < S.started) S.started = t;
      if (Number.isNaN(S.ended) || t > S.ended) S.ended = t;
    }
    if (r.type === 'session_meta') {
      S.id = p.id || p.session_id || '';
      S.cwd = p.cwd || '';
      S.cli = p.cli_version || '';
      S.provider = p.model_provider || '';
      S.repo = ((p.git && p.git.repository_url) || '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
      S.branch = (p.git && p.git.branch) || '';
      return;
    }
    if (r.type === 'turn_context') {
      if (p.model && !S.model) S.model = p.model;
      return;
    }
    if (r.type === 'compacted') {
      (turn || newTurn(t)).steps.push({ kind: 'compaction', t, text: 'Context compacted', raw: [r] });
      return;
    }
    if (r.type === 'event_msg') {
      if (p.type === 'task_started') {
        const cur = turn as Turn | null;
        if (!cur || cur.steps.length || cur.turnId) {
          closeTurn();
          newTurn(t);
        }
        const nt = turn as unknown as Turn;
        nt.turnId = p.turn_id;
        if (p.turn_id) byId[p.turn_id] = nt;
        if (p.model_context_window) S.contextWindow = p.model_context_window;
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        const tt = byId[p.turn_id] || turn;
        if (tt) {
          tt.end = Math.max(tt.end, t);
          if (p.type === 'turn_aborted') tt.aborted = true;
        }
      } else if (p.type === 'token_count' && p.info) {
        if (p.info.total_token_usage) lastTotal = p.info.total_token_usage;
        if (p.info.model_context_window) S.contextWindow = p.info.model_context_window;
        const u = p.info.last_token_usage;
        if (u && pend.length) {
          const usage = {
            input: u.input_tokens || 0, cached: u.cached_input_tokens || 0, output: u.output_tokens || 0, reasoning: u.reasoning_output_tokens || 0,
            window: p.info.model_context_window || S.contextWindow, shared: pend.length,
          };
          pend.forEach((x) => (x.usage = usage));
          pend = [];
        }
      }
      return;
    }
    if (r.type !== 'response_item') return;
    const open = turn as Turn | null;
    if (p.type === 'message' && p.role === 'user' && open && (open.steps.length || open.turnId)) {
      closeTurn();
      newTurn(t);
    }
    const cur: Turn = turn || newTurn(t);
    cur.end = Math.max(cur.end, t);

    if (p.type === 'message' && p.role === 'user') {
      let tx = textOf(p.content);
      const req = tx.indexOf('## My request for Codex:');
      if (req >= 0) {
        cur.context.push({ label: 'IDE context', text: tx.slice(0, req).trim(), raw: [r] });
        tx = tx.slice(req + 24).trim();
      }
      const pre = CTX_PREFIXES.find(([k]) => tx.trim().startsWith(k));
      if (pre) {
        cur.context.push({ label: pre[1], text: tx, raw: [r] });
        return;
      }
      if (/^\s*This session is being continued/.test(tx)) {
        cur.context.push({ label: 'Resumed session summary', text: tx, raw: [r] });
        return;
      }
      cur.prompt = cur.prompt ? cur.prompt + '\n\n' + tx : tx;
      cur.promptRows.push(r);
      if (!S.title && tx.trim()) S.title = tx.trim().split('\n')[0].slice(0, 120);
    } else if (p.type === 'message' && p.role === 'assistant') {
      cur.steps.push({ kind: 'message', t, text: textOf(p.content), raw: [r] });
      S.counts.messages++;
    } else if (p.type === 'reasoning') {
      const sum = ((p.summary || []) as { text?: string }[]).map((s) => s.text).filter(Boolean);
      if (sum.length) {
        cur.steps.push({ kind: 'reasoning', t, text: sum.join('\n\n'), raw: [r] });
        S.counts.reasoning++;
      }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let args: any = {};
      try {
        args = JSON.parse(p.arguments || '{}');
      } catch {
        args = { raw: p.arguments };
      }
      if (p.type === 'local_shell_call' && p.action) args = { ...p.action, ...args };
      let cmd: unknown = '';
      let detail = '';
      if (p.type === 'custom_tool_call') {
        cmd = p.name;
        detail = p.input || '';
      } else if (p.name === 'update_plan') {
        cmd = 'update_plan';
        detail = ((args.plan || []) as { status?: string; step: string }[]).map((s) => '[' + (s.status || '') + '] ' + s.step).join('\n');
      } else {
        cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command || args.path || args.raw || JSON.stringify(args);
      }
      const step: ToolStep = {
        kind: 'tool', t, name: p.name || p.type, cmd: String(cmd), detail, workdir: args.workdir || '', args,
        output: '', exit: null, wall: null, done: null, raw: [r],
      };
      cur.steps.push(step);
      pend.push(step);
      if (p.call_id) calls[p.call_id] = step;
      S.counts.tools++;
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const st = calls[p.call_id];
      if (!st) return;
      let out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      try {
        const j = JSON.parse(out);
        if (j && typeof j.output === 'string') {
          out = j.output;
          if (j.metadata) {
            st.exit = j.metadata.exit_code;
            st.wall = j.metadata.duration_seconds;
          }
        }
      } catch {
        /* plain-text output */
      }
      const m = out.match(/^Exit code: (-?\d+)\nWall time: ([\d.]+) seconds\n(?:Total output lines: \d+\n)?Output:\n?/);
      if (m) {
        st.exit = +m[1];
        st.wall = +m[2];
        out = out.slice(m[0].length);
      }
      st.output = out;
      st.done = t;
      st.raw.push(r);
      if (st.exit && st.exit !== 0) S.counts.failed++;
    }
  };

  for (const r of rows) {
    handle(r);
    if (turn) (turn as Turn).rows.push(r);
  }
  closeTurn();
  const lt = lastTotal as Usage | null;
  if (lt) {
    S.tokens = { input: lt.input_tokens, cached: lt.cached_input_tokens, output: lt.output_tokens, reasoning: lt.reasoning_output_tokens || 0, total: lt.total_tokens };
  }
  S.turns = S.turns.filter((t) => t.prompt || t.steps.length || t.context.length);
  // Merge leading context-only turns into the next prompt turn.
  const merged: Turn[] = [];
  let carry: Turn[] = [];
  for (const t of S.turns) {
    if (!t.prompt && !t.steps.length) {
      carry.push(t);
      continue;
    }
    carry.forEach((c) => {
      t.context = (c.context as ContextItem[]).concat(t.context);
      t.rows = c.rows.concat(t.rows);
      t.start = Math.min(t.start, c.start);
    });
    carry = [];
    merged.push(t);
  }
  S.turns = merged;
  if (Number.isNaN(S.started)) S.started = S.ended = 0;
  if (!S.title) S.title = fileName || 'Untitled session';
  return S;
}
