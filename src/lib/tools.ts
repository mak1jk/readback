// Normalized view of a tool call: unwraps code-mode scripts (`tools.exec_command({...})`), output
// envelopes and truncation notices, estimates output size, and builds structured views of grep
// results, file viewers and patches.
import type { CallUsage, ToolStep } from '../model';
import JSON5 from 'json5';
import { K, baseCmd, dur } from './format';
import { COL, langOfPath, overlay, tokLine, type ColSeg, type Tok } from './highlight';

const SHELL_NAMES = new Set(['shell_command', 'local_shell_call', 'shell', 'exec_command', 'bash', 'run_shell_command']);
export const isShellName = (name: string) => SHELL_NAMES.has(name.split('__').pop()!.toLowerCase());

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const unent = (s: string) => String(s).replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ENT[m]);

/** The balanced `{...}` object literal starting at `i`, honoring quotes. */
function objAt(s: string, i: number): string | null {
  let d = 0;
  let q: string | null = null;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (!d) return s.slice(i, j + 1);
    }
  }
  return null;
}

export interface CmdPart {
  t: string;
  /** Operator joining this part to the previous one (`&&`, `||`, `|`, `;`). */
  prev: string;
  /** Label of an `echo '--- label ---'` divider, if this part is one. */
  label: string | null;
}

/** Split a shell command on `&&`, `||`, `|`, `;` and newlines (quote-aware; heredocs stay whole). */
export function splitCmd(s: string): CmdPart[] {
  if (s.includes('<<') || /(?:^|[;\n]\s*)(?:for|while|until|if|case|function)\b/.test(s)) return [{ t: s.trim(), prev: '', label: null }];
  const parts: { t: string; prev: string }[] = [];
  let cur = '';
  let q: string | null = null;
  let prev = '';
  let depth = 0;
  const push = (op: string) => {
    const t = cur.trim();
    if (t) parts.push({ t, prev });
    if (t || op) prev = op || prev;
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q !== "'") {
      cur += c + (s[++i] || '');
      continue;
    }
    if (q) {
      cur += c;
      if (c === q && (q === "'" || s[i - 1] !== '\\')) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '{') depth++;
    if (c === ')' || c === '}') depth = Math.max(0, depth - 1);
    if (depth) { cur += c; continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(two);
      i++;
      continue;
    }
    if (c === '|' || c === ';' || c === '\n') {
      push(c === '\n' ? ';' : c);
      continue;
    }
    cur += c;
  }
  push('');
  return parts.map((p) => {
    const m = p.t.match(/^(?:printf|echo)\b[\s\S]*?['"]?\s*[-=]{2,}\s*(.+?)\s*[-=]{2,}\s*['"]?\s*$/);
    return { ...p, label: m ? m[1] : null };
  });
}

export const shWords = (s: string) => (s.match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g) || []).map((w) => (/^['"]/.test(w) ? w.slice(1, -1) : w));

const ARGF = new Set(['-C', '-A', '-B', '-m', '-g', '-t', '-T', '-f', '-M', '-j', '--glob', '--type', '--type-not', '--context', '--max-count', '--after-context', '--before-context', '--max-columns', '--threads']);

/** Combined regex of the patterns passed to rg/grep in the command, to highlight hits. */
function grepRe(parts: CmdPart[]): RegExp | null {
  const pats: string[] = [];
  let ci = false;
  parts.forEach((p) => {
    const w = shWords(p.t);
    let i = 1;
    if (w[0] === 'git' && w[1] === 'grep') i = 2;
    else if (!/^(rg|grep|egrep)$/.test(w[0] || '')) return;
    for (; i < w.length; i++) {
      const a = w[i];
      if (a === '-e' || a === '--regexp') {
        pats.push(w[++i]);
        continue;
      }
      if (/^(-i|--ignore-case|-S|--smart-case)$/.test(a)) ci = true;
      if (a.startsWith('-')) {
        if (ARGF.has(a)) i++;
        continue;
      }
      pats.push(a);
      break;
    }
  });
  const list = pats.filter(Boolean);
  if (!list.length) return null;
  try {
    return new RegExp(list.map((x) => '(?:' + x + ')').join('|'), ci ? 'gi' : 'g');
  } catch {
    return null;
  }
}

export interface CmdLine {
  op: string;
  segs: ColSeg[];
  indent: number;
}

export interface NormTool {
  name: string;
  cmd: string;
  /** One-line command for list rows (dividers dropped). */
  short: string;
  /** Human-readable action; original command/arguments are preserved below. */
  title: string;
  subject: string;
  fields: { label: string; value: string }[];
  status: 'Failed' | 'Completed' | 'Result received' | 'Awaiting result';
  base: string;
  workdir: string;
  detail: string;
  /** Code-mode script the agent ran to make the call(s). */
  script: string;
  output: string;
  wall: number | null;
  exit: number | null;
  trunc: { tokens: number; lines: number | null } | null;
  parts: CmdPart[];
  cmdLines: CmdLine[];
  re: RegExp | null;
  usage: CallUsage | null;
  limits: string;
  /** Estimated tokens of output (~4 chars per token). */
  outTok: number;
  outLines: number;
  sx?: Struct | null;
}

const NT = new WeakMap<ToolStep, NormTool>();

export function normTool(st: ToolStep): NormTool {
  const hit = NT.get(st);
  if (hit) return hit;
  let name = st.name;
  const command = st.args?.cmd ?? st.args?.command;
  let cmd = String(st.cmd || (Array.isArray(command) ? command.join(' ') : command) || '');
  let workdir = st.workdir || '';
  let detail = st.detail || '';
  let script = '';
  let output = String(st.output || '');
  let wall = st.wall;
  let exit = st.exit;
  let error = st.error === true;
  let trunc: NormTool['trunc'] = null;
  const calls: { tool: string; a: any }[] = [];
  const re = /tools\.(\w+)\(\s*\{/g;
  let m: RegExpMatchArray | null;
  let cm: RegExpExecArray | null;
  while ((cm = re.exec(detail))) {
    const o = objAt(detail, cm.index + cm[0].length - 1);
    let a = null;
    if (o) {
      try {
        a = JSON5.parse(o);
      } catch {
        /* not plain JSON */
      }
    }
    calls.push({ tool: cm[1], a });
  }
  if (calls.length) {
    script = unent(detail);
    detail = '';
    cmd = unent(calls.map((c) => (c.a && (c.a.cmd || c.a.command) ? [].concat(c.a.cmd || c.a.command).join(' ') : c.tool + (c.a ? ' ' + JSON.stringify(c.a) : ''))).join('\n'));
    const wd = calls.find((c) => c.a && c.a.workdir);
    if (wd) workdir = wd.a.workdir;
    if (calls.every((c) => isShellName(c.tool))) name = 'shell_command';
  } else if (/&(amp|gt|lt);/.test(cmd)) cmd = unent(cmd);
  const t0 = output.trim();
  if (t0[0] === '[') {
    try {
      const j = JSON.parse(t0);
      if (Array.isArray(j) && j.length && j.every((p) => p && typeof p.text === 'string')) output = j.map((p) => p.text).join('');
    } catch {
      /* plain text */
    }
  }
  m = output.match(/^Script (completed|failed|errored)[^\n]*\n(?:Wall time:? ([\d.]+) seconds?\n)?(?:Output:\n)?/i);
  if (m) {
    if (m[2] && wall == null) wall = +m[2];
    if (!/completed/i.test(m[1])) error = true;
    output = output.slice(m[0].length);
  }
  output = output.replace(/^\n+/, '');
  m = output.match(/^Warning: truncated output \(original token count: (\d+)\)\n(?:Total output lines: (\d+)\n)?/);
  if (m) {
    trunc = { tokens: +m[1], lines: m[2] ? +m[2] : null };
    output = output.slice(m[0].length).replace(/^\n+/, '');
  }
  if (/&(amp|gt|lt|quot);/.test(output) && !/[<>]/.test(output)) output = unent(output);
  // Read transport envelopes without evaluating anything in the stored command or script.
  const readableResult = (value: any): string => {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(readableResult).join('\n');
    if (typeof value !== 'object') return String(value);
    if (typeof value.text === 'string') return value.text;
    if (value.status === 'fulfilled' && value.value) return readableResult(value.value);
    if (value.content && Array.isArray(value.content)) return readableResult(value.content);
    if (typeof value.output === 'string' && ('exit_code' in value || 'wall_time_seconds' in value || 'chunk_id' in value || 'session_id' in value)) {
      if (typeof value.exit_code === 'number' && (exit == null || value.exit_code !== 0)) exit = value.exit_code;
      if (typeof value.wall_time_seconds === 'number' && wall == null) wall = value.wall_time_seconds;
      return value.output;
    }
    return JSON.stringify(value, null, 2);
  };
  try { output = readableResult(JSON.parse(output)); } catch {
    // Code mode can print one envelope per line. Preserve any line that isn't JSON.
    if (output.includes('\n')) output = output.split('\n').map((line) => {
      try { return readableResult(JSON.parse(line)); } catch { return line; }
    }).join('\n');
  }
  output = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const A = Object.assign({}, st.args || {}, ...calls.map((c) => c.a || {}));
  const limits = [A.max_output_tokens ? 'max ' + K(A.max_output_tokens) + ' tok' : '', A.yield_time_ms ? 'yield ' + dur(A.yield_time_ms) : '', A.timeout_ms ? 'timeout ' + dur(A.timeout_ms) : ''].filter(Boolean).join(' · ');
  const outTok = Math.round(output.length / 4);
  const outLines = output ? output.split('\n').length : 0;
  const parts = splitCmd(cmd);
  const real = parts.filter((p) => !p.label);
  const cmdLines = parts.map((p, i) => ({
    op: i === 0 ? '$' : p.prev,
    segs: p.label ? [{ t: '# ' + p.label, c: 'var(--faint)' }] : tokLine(p.t, 'sh', null).segs.map((g) => ({ t: g.t, c: COL[g.k] || 'var(--fg-2)' })),
    indent: p.prev === '|' && i ? 18 : 0,
  }));
  const short = real.length ? real.map((p, i) => (i ? ' ' + p.prev + ' ' : '') + p.t).join('').replace(/\s+/g, ' ') : cmd;
  const bareName = name.split('__').pop()!.toLowerCase();
  const human = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const labels: Record<string, string> = { read: 'Read file', read_file: 'Read file', read_many_files: 'Read files', write: 'Write file', write_file: 'Write file', edit: 'Edit file', replace: 'Edit file', apply_patch: 'Apply file changes', glob: 'Find files', grep: 'Search files', search_file_content: 'Search files', list_directory: 'List folder', webfetch: 'Read web page', web_fetch: 'Read web page', websearch: 'Search the web', web_search: 'Search the web', task: 'Delegate task', agent: 'Delegate task', update_plan: 'Update plan', view_image: 'View image' };
  const first = shWords(real[0]?.t || cmd);
  const base = baseCmd(real.length ? real[0].t : cmd);
  const shellTitles: Record<string, string> = { rg: first.includes('--files') ? 'List files' : 'Search files', grep: 'Search files', cat: 'Read files', sed: 'Inspect or edit text', head: 'Read first lines', tail: 'Read last lines', ls: 'List folder', pwd: 'Show working folder', find: 'Find files', git: 'Git ' + (first[1] || 'command'), npm: 'Run npm ' + first.slice(1, 3).join(' '), pnpm: 'Run pnpm ' + first.slice(1, 3).join(' '), cargo: 'Run cargo ' + (first[1] || ''), python3: 'Run Python', python: 'Run Python', node: 'Run JavaScript', curl: 'Request URL' };
  const action = isShellName(name) ? shellTitles[base] || 'Run ' + (base || 'command') : labels[bareName] || human(name.replace(/^mcp__/, '').replace(/__/g, ' · '));
  const description = typeof A.description === 'string' ? A.description : '';
  const title = description || action + (real.length > 1 ? ` · ${real.length} commands` : '');
  const subject = isShellName(name) ? short : String(A.file_path ?? A.filePath ?? A.path ?? A.pattern ?? A.query ?? A.url ?? (cmd !== name ? cmd : '') ?? '');
  const fields = Object.entries(A)
    .filter(([k]) => !['cmd', 'command', 'workdir', 'cwd', 'description', 'code', 'max_output_tokens', 'yield_time_ms', 'timeout_ms'].includes(k))
    .map(([k, value]) => ({ label: human(k), value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value) }));
  const status: NormTool['status'] = error || (exit != null && exit !== 0) ? 'Failed' : st.done != null || exit === 0 ? 'Completed' : output ? 'Result received' : 'Awaiting result';
  const n: NormTool = {
    name, cmd, short, title, subject, fields, status, base, workdir, detail, script, output, wall, exit, trunc, parts, cmdLines,
    re: grepRe(real), usage: st.usage || null, limits, outTok, outLines,
  };
  NT.set(st, n);
  return n;
}

// ---- Structured output views ----

export interface FileLine {
  ln?: number | string;
  text?: string;
  match?: boolean;
  mark?: '+' | '-';
  gap?: boolean;
  hunk?: boolean;
  segs?: ColSeg[];
}
export type SBlock =
  | { type: 'section'; label: string; files: number; hits: number }
  | { type: 'gap'; tokens: number }
  | { type: 'text'; text: string }
  | {
      type: 'file';
      file: string;
      lines: FileLine[];
      hits: number;
      dir?: string;
      base?: string;
      op?: string;
      add?: number;
      del?: number;
      patch?: boolean;
      viewer?: boolean;
      limit?: number;
      moveTo?: string;
      gapNext?: boolean;
    };
type FileBlock = Extract<SBlock, { type: 'file' }>;

export interface Struct {
  blocks: SBlock[];
  files: number;
  matches: number;
  add: number;
  del: number;
  prefix: string;
  isDiff: boolean;
}

function parseGrepLine(l: string, known: Set<string>) {
  const re = /([:-])(\d+)\1/g;
  let m: RegExpExecArray | null;
  let first: { file: string; sep: string; ln: number; text: string } | null = null;
  while ((m = re.exec(l))) {
    const p = l.slice(0, m.index);
    if (!p || /\s/.test(p)) break;
    const r = { file: p, sep: m[1], ln: +m[2], text: l.slice(m.index + m[0].length) };
    if (known.has(p)) return r;
    if (!first && /[/.]/.test(p) && m[1] === ':') first = r;
  }
  return first;
}

/** rg/grep -n output → sections (echo dividers), per-file match groups, and truncation gaps. */
function grepBlocks(text: string): SBlock[] | null {
  const known = new Set<string>();
  text.split('\n').forEach((l) => {
    const m = l.match(/^([^\s:]+):(\d+):/);
    if (m) known.add(m[1]);
  });
  const blocks: SBlock[] = [];
  let files = 0;
  let secs = 0;
  let gaps = 0;
  const chunks = text.split(/…(\d+) tokens truncated…/);
  for (let ci = 0; ci < chunks.length; ci += 2) {
    if (ci) {
      blocks.push({ type: 'gap', tokens: +chunks[ci - 1] });
      gaps++;
    }
    let cur: FileBlock | null = null;
    let sec: Extract<SBlock, { type: 'section' }> | null = null;
    let buf: string[] = [];
    const flush = () => {
      while (buf.length && !buf[0].trim()) buf.shift();
      while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
      if (buf.length) blocks.push({ type: 'text', text: buf.join('\n') });
      buf = [];
    };
    chunks[ci].split('\n').forEach((l) => {
      const sm = l.match(/^\s*(?:-{3,}|={3,})\s*(\S.*?)\s*(?:-{3,}|={3,})\s*$/);
      if (sm) {
        flush();
        cur = null;
        sec = { type: 'section', label: sm[1], files: 0, hits: 0 };
        blocks.push(sec);
        secs++;
        return;
      }
      if (l === '--') {
        if (cur) cur.gapNext = true;
        return;
      }
      const g = known.size ? parseGrepLine(l, known) : null;
      if (g) {
        flush();
        const c0 = cur as FileBlock | null;
        if (!c0 || c0.file !== g.file) {
          cur = { type: 'file', file: g.file, lines: [], hits: 0 };
          blocks.push(cur);
          files++;
          if (sec) sec.files++;
        } else if (c0.gapNext) c0.lines.push({ gap: true });
        const c = cur as FileBlock;
        c.gapNext = false;
        const mt = g.sep === ':';
        c.lines.push({ ln: g.ln, match: mt, text: g.text });
        if (mt) {
          c.hits++;
          if (sec) sec.hits++;
        }
        return;
      }
      cur = null;
      buf.push(l);
    });
    flush();
  }
  return files || secs || gaps ? blocks : null;
}

/** cat/sed/nl/head/tail/bat of a source file → one numbered, highlighted file block. */
function viewerBlocks(text: string, n: NormTool): SBlock[] | null {
  const p = n.parts.find((x) => !x.label);
  if (!p || !text.trim()) return null;
  const w = shWords(p.t);
  if (!/^(cat|sed|nl|head|tail|bat)$/.test(w[0] || '')) return null;
  const f = w.slice(1).reverse().find((a) => !a.startsWith('-') && langOfPath(a));
  if (!f) return null;
  const rows = text.replace(/\n$/, '').split('\n');
  const sm = w[0] === 'sed' && p.t.match(/-n\s+['"]?(\d+),/);
  const start = sm ? +sm[1] : 1;
  const numbered = rows.filter((r) => r.trim()).every((r) => /^\s*\d+\t/.test(r));
  const lines = rows.map((r, i) => {
    if (numbered) {
      const m = r.match(/^\s*(\d+)\t?(.*)$/);
      return m ? { ln: +m[1], text: m[2] } : { ln: '', text: r };
    }
    return { ln: start + i, text: r };
  });
  return [{ type: 'file', file: f, lines, hits: 0, viewer: true, limit: 400 }];
}

/** apply_patch envelopes and unified git diffs → per-file blocks with +/- lines. */
function parseDiff(text: string): SBlock[] {
  const blocks: SBlock[] = [];
  let cur: FileBlock | null = null;
  let hdr = false;
  let o = 0;
  let nn = 0;
  const nf = (file: string, op: string) => {
    cur = { type: 'file', file, op, lines: [], hits: 0, add: 0, del: 0, patch: true, limit: 200 };
    blocks.push(cur);
  };
  text.split('\n').forEach((l) => {
    let m: RegExpMatchArray | null;
    if (/^\*\*\* (Begin|End) Patch/.test(l)) return;
    if ((m = l.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/))) {
      nf(m[2].trim(), m[1]);
      hdr = false;
      o = nn = 0;
      return;
    }
    const c = cur as FileBlock | null;
    if ((m = l.match(/^\*\*\* Move to: (.+)$/))) {
      if (c) c.moveTo = m[1].trim();
      return;
    }
    if ((m = l.match(/^diff --git a\/(\S+) b\/(\S+)/))) {
      nf(m[2], 'Update');
      hdr = true;
      return;
    }
    if (hdr && c && /^(index |new file|deleted file|similarity|rename |old mode|new mode|--- |\+\+\+ |Binary)/.test(l)) {
      if (/^new file/.test(l)) c.op = 'Add';
      if (/^deleted file/.test(l)) c.op = 'Delete';
      return;
    }
    if (l.startsWith('@@')) {
      hdr = false;
      m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) {
        o = +m[1];
        nn = +m[2];
      } else o = nn = 0;
      if (c) c.lines.push({ hunk: true, text: l });
      return;
    }
    if (!c) {
      if (l.trim()) {
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'text') last.text += '\n' + l;
        else blocks.push({ type: 'text', text: l });
      }
      return;
    }
    if (l.startsWith('\\ No newline')) return;
    if (l[0] === '+') {
      c.lines.push({ mark: '+', text: l.slice(1), ln: nn ? nn++ : '' });
      c.add = (c.add || 0) + 1;
    } else if (l[0] === '-') {
      c.lines.push({ mark: '-', text: l.slice(1), ln: o ? o++ : '' });
      c.del = (c.del || 0) + 1;
    } else {
      c.lines.push({ text: l[0] === ' ' ? l.slice(1) : l, ln: nn || '' });
      if (nn) {
        nn++;
        o++;
      }
    }
  });
  blocks.forEach((b) => {
    if (b.type === 'file') while (b.lines.length && !b.lines[b.lines.length - 1].mark && !b.lines[b.lines.length - 1].text) b.lines.pop();
  });
  return blocks;
}

/** Structured view of a tool output, or null when plain text is the best rendering. Cached. */
export function structOf(n: NormTool): Struct | null {
  if (n.sx !== undefined) return n.sx;
  const text = n.output || '';
  if (text.length > 3e6) return (n.sx = null);
  const isP = (t: string) => /^\s*\*\*\* Begin Patch/.test(t) || /^diff --git /m.test(t);
  const pd = n.detail && isP(n.detail) ? n.detail : isP(text) ? text : null;
  let blocks: SBlock[];
  if (pd) {
    blocks = parseDiff(pd);
    if (pd !== text && text.trim()) blocks.push({ type: 'text', text: text.trim() });
  } else blocks = grepBlocks(text) || viewerBlocks(text, n) || [];
  const fileB = blocks.filter((b): b is FileBlock => b.type === 'file');
  if (!fileB.length && !blocks.some((b) => b.type === 'section' || b.type === 'gap')) return (n.sx = null);
  const paths = fileB.map((b) => b.file);
  let prefix = '';
  if (new Set(paths).size > 1) {
    prefix = paths.reduce((a, p) => {
      let i = 0;
      while (i < a.length && a[i] === p[i]) i++;
      return a.slice(0, i);
    });
    prefix = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  }
  fileB.forEach((b) => {
    const rel = b.file.slice(prefix.length);
    const k = rel.lastIndexOf('/');
    b.dir = rel.slice(0, k + 1);
    b.base = rel.slice(k + 1) + (b.moveTo ? ' → ' + b.moveTo : '');
    const lang = langOfPath(b.file);
    let st: Parameters<typeof tokLine>[2] = null;
    b.lines.forEach((l) => {
      if (l.gap || l.hunk) {
        st = null;
        return;
      }
      const r = tokLine(l.text || '', lang, st);
      st = r.st;
      const sg = l.match ? overlay(r.segs, l.text || '', n.re) : r.segs;
      const base = l.match ? 'var(--fg-2)' : 'var(--fg-3)';
      const mark: Tok[] = l.mark ? [{ t: l.mark + ' ', k: l.mark === '+' ? 'add' : 'del' }] : [];
      l.segs = mark
        .concat(sg)
        .map((g) => ({ t: g.t, c: COL[g.k] || base, bg: g.h ? 'var(--sel)' : 'transparent' }));
    });
  });
  return (n.sx = {
    blocks, files: fileB.length, matches: fileB.reduce((a, b) => a + b.hits, 0), add: fileB.reduce((a, b) => a + (b.add || 0), 0),
    del: fileB.reduce((a, b) => a + (b.del || 0), 0), prefix, isDiff: !!pd,
  });
}
