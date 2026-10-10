import type { RawRow } from '../model';

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const hm = (ms: number) => {
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};
export const hms = (ms: number) => hm(ms) + ':' + pad2(new Date(ms).getSeconds());
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
};
export const dayLbl = (ms: number) => {
  const d = new Date(ms);
  return MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
};
export const K = (n: number | null | undefined) =>
  n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.max(0, n));
export const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + pad2(s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
};
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

const rep = (k: string, v: unknown) =>
  k === 'encrypted_content' && typeof v === 'string' && v.length > 40 ? v.slice(0, 24) + '… (' + v.length + ' chars, encrypted)' : v;

export interface RawView {
  line: number | string;
  kind: string;
  time: string;
  json: string;
}
export const rawRowsOf = (rows: RawRow[] | undefined): RawView[] =>
  (rows || [])
    .slice()
    .sort((a, b) => (a.__line || 0) - (b.__line || 0))
    .map((r) => ({
      line: r.__line || '–',
      kind: r.type + (r.payload && r.payload.type ? ' · ' + r.payload.type : ''),
      time: r.timestamp ? hms(new Date(r.timestamp).getTime()) : '',
      json: JSON.stringify(r, rep, 2),
    }));

/** Base program of a shell command: strips a leading `cd x &&`, env assignments and the path. */
export const baseCmd = (c: string) => {
  let s = String(c).replace(/^cd\s+\S+\s*&&\s*/, '').trim();
  s = s.replace(/^(\w+=\S+\s+)+/, '');
  const w = s.split(/\s+/)[0] || '';
  return w.split('/').pop() || '';
};

// ---- Lightweight Markdown -------------------------------------------------

export type Seg = { t: string; kind: 'plain' | 'bold' | 'code' };
export type Block =
  | { type: 'p'; segs: Seg[] }
  | { type: 'h'; text: string }
  | { type: 'ul'; items: Seg[][] }
  | { type: 'code'; lang: string; text: string };

export function segs(text: string): Seg[] {
  return String(text)
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)
    .filter(Boolean)
    .map((p): Seg =>
      p.startsWith('**') && p.endsWith('**') && p.length > 4
        ? { t: p.slice(2, -2), kind: 'bold' }
        : p.startsWith('`') && p.endsWith('`') && p.length > 2
          ? { t: p.slice(1, -1), kind: 'code' }
          : { t: p, kind: 'plain' },
    );
}

export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = String(text || '').split('\n');
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    const t = para.join('\n').trim();
    if (t) out.push({ type: 'p', segs: segs(t) });
    para = [];
  };
  const isLi = (l: string) => /^\s*([-*•]|\d+[.)])\s/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim().startsWith('```')) {
      flush();
      const lang = l.trim().slice(3) || 'text';
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      out.push({ type: 'code', lang, text: code.join('\n') });
      continue;
    }
    if (l.trim().startsWith('|')) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      out.push({ type: 'code', lang: 'table', text: rows.join('\n') });
      continue;
    }
    if (/^#{1,4}\s/.test(l)) {
      flush();
      out.push({ type: 'h', text: l.replace(/^#+\s/, '').replace(/\*\*/g, '') });
      i++;
      continue;
    }
    if (/^\*\*[^*]+\*\*\s*$/.test(l.trim())) {
      flush();
      out.push({ type: 'h', text: l.trim().slice(2, -2) });
      i++;
      continue;
    }
    if (isLi(l)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && (isLi(lines[i]) || (lines[i].startsWith('  ') && lines[i].trim() && items.length))) {
        const x = lines[i++];
        if (isLi(x)) items.push(x.replace(/^\s*([-*•]|\d+[.)])\s/, ''));
        else items[items.length - 1] += ' ' + x.trim();
      }
      out.push({ type: 'ul', items: items.map((t) => segs(t)) });
      continue;
    }
    if (!l.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return out;
}

export const fileSlug = (title: string) => (title.slice(0, 50).replace(/[^\w-]+/g, '-') || 'session') + '.md';
