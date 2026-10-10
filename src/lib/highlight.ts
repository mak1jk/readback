// Lightweight line-by-line syntax highlighter for code blocks, file views, diffs and shell commands.

export type TokKind = '' | 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'dec' | 'add' | 'del';
export interface Tok {
  t: string;
  k: TokKind;
  /** Search hit (grep pattern) overlaid on the token. */
  h?: boolean;
}
/** Rendered segment: text + CSS color (+ optional background). */
export interface ColSeg {
  t: string;
  c: string;
  bg?: string;
}
/** Multi-line construct still open at the end of a line (block comment, triple-quoted string). */
type Carry = { end: string; k: TokKind } | null;

const KWS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
    gd: 'and as assert await break class class_name const continue elif else enum export extends for func if in is match not onready or pass preload return signal static super var void while yield',
    js: 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch throw try typeof var void while with yield type interface enum implements private public protected readonly as declare namespace keyof',
    c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool class namespace template typename public private protected virtual override new delete using constexpr uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t size_t',
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    rs: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while',
    lua: 'and break do else elseif end for function goto if in local not or repeat return then until while',
    sh: 'if then else elif fi for while do done case esac in function return export local',
  }).map(([k, v]) => [k, new Set(v.split(' '))]),
);
const LIT = new Set('True False None true false null nil undefined self this NULL nullptr Self'.split(' '));

interface LangDef {
  lc?: string[];
  bc?: [string, string];
  tq?: boolean;
  dec?: boolean;
  bt?: boolean;
  pre?: boolean;
  sh?: boolean;
  kv?: boolean;
}
const LDEF: Record<string, LangDef> = {
  py: { lc: ['#'], tq: true, dec: true }, gd: { lc: ['#'], tq: true, dec: true }, js: { lc: ['//'], bc: ['/*', '*/'], bt: true },
  c: { lc: ['//'], bc: ['/*', '*/'], pre: true }, go: { lc: ['//'], bc: ['/*', '*/'], bt: true }, rs: { lc: ['//'], bc: ['/*', '*/'] },
  lua: { lc: ['--'] }, sh: { lc: ['#'], sh: true }, json: { kv: true }, yaml: { lc: ['#'], kv: true }, toml: { lc: ['#'], kv: true }, css: { bc: ['/*', '*/'] },
};
const EXT: Record<string, string> = {
  py: 'py', pyi: 'py', gd: 'gd', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', m: 'c',
  go: 'go', rs: 'rs', lua: 'lua', sh: 'sh', bash: 'sh', zsh: 'sh', json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', css: 'css',
};
const FENCE: Record<string, string> = {
  python: 'py', py: 'py', gdscript: 'gd', gd: 'gd', javascript: 'js', js: 'js', jsx: 'js', typescript: 'js', ts: 'js', tsx: 'js', c: 'c', cpp: 'c', 'c++': 'c', h: 'c',
  go: 'go', rust: 'rs', rs: 'rs', lua: 'lua', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', css: 'css',
};
export const COL: Record<string, string> = {
  kw: 'var(--syn-kw)', str: 'var(--syn-str)', num: 'var(--syn-num)', com: 'var(--faint)', fn: 'var(--syn-fn)', type: 'var(--syn-type)', dec: 'var(--syn-dec)', add: 'var(--add-fg)', del: 'var(--del-fg)',
};

export const langOfPath = (p: string) => {
  const m = String(p).match(/\.([\w+]+)$/);
  return m ? EXT[m[1].toLowerCase()] || null : null;
};

export function tokLine(s: string, lang: string | null, st: Carry): { segs: Tok[]; st: Carry } {
  const L = lang ? LDEF[lang] : undefined;
  if (!L || !s || s.length > 2000) return { segs: [{ t: s || ' ', k: '' }], st: null };
  const kw = KWS[lang as string] || new Set<string>();
  const out: Tok[] = [];
  let i = 0;
  let cmdStart = true;
  const emit = (t: string, k: TokKind) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.k === k) last.t += t;
    else out.push({ t, k });
  };
  if (st) {
    const j = s.indexOf(st.end);
    if (j < 0) return { segs: [{ t: s, k: st.k }], st };
    emit(s.slice(0, j + st.end.length), st.k);
    i = j + st.end.length;
    st = null;
  }
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i, i + 400);
    let m: RegExpMatchArray | null;
    if (L.lc && L.lc.some((x) => rest.startsWith(x)) && (!L.sh || i === 0 || /\s/.test(s[i - 1]))) {
      emit(s.slice(i), 'com');
      break;
    }
    if (L.bc && rest.startsWith(L.bc[0])) {
      const j = s.indexOf(L.bc[1], i + 2);
      if (j < 0) {
        emit(s.slice(i), 'com');
        st = { end: L.bc[1], k: 'com' };
        break;
      }
      emit(s.slice(i, j + 2), 'com');
      i = j + 2;
      continue;
    }
    if (L.tq && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const q = rest.slice(0, 3);
      const j = s.indexOf(q, i + 3);
      if (j < 0) {
        emit(s.slice(i), 'str');
        st = { end: q, k: 'str' };
        break;
      }
      emit(s.slice(i, j + 3), 'str');
      i = j + 3;
      continue;
    }
    if (c === '"' || (c === "'" && lang !== 'rs') || (c === '`' && L.bt)) {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && !L.sh) j++;
        j++;
      }
      const str = s.slice(i, Math.min(j + 1, s.length));
      emit(str, L.kv && /^\s*:/.test(s.slice(i + str.length)) ? 'fn' : 'str');
      i += str.length;
      cmdStart = false;
      continue;
    }
    if (L.dec && c === '@' && (m = rest.match(/^@[\w.]+/))) {
      emit(m[0], 'dec');
      i += m[0].length;
      continue;
    }
    if (L.pre && c === '#' && !s.slice(0, i).trim() && (m = rest.match(/^#\s*\w+/))) {
      emit(m[0], 'dec');
      i += m[0].length;
      continue;
    }
    if (L.sh) {
      if (c === '$' && (m = rest.match(/^\$(\{[^}]*\}|\w+|[@#?*!$0-9])/))) {
        emit(m[0], 'type');
        i += m[0].length;
        cmdStart = false;
        continue;
      }
      if (c === '-' && (i === 0 || /\s/.test(s[i - 1])) && (m = rest.match(/^--?[\w-]+/))) {
        emit(m[0], 'kw');
        i += m[0].length;
        continue;
      }
      if (/[|&;<>]/.test(c)) {
        emit(c, 'kw');
        i++;
        if (/[|&;]/.test(c)) cmdStart = true;
        continue;
      }
      if (cmdStart && (m = rest.match(/^[\w./~-]+/))) {
        emit(m[0], kw.has(m[0]) ? 'kw' : 'fn');
        i += m[0].length;
        cmdStart = kw.has(m[0]);
        continue;
      }
    }
    if (/[0-9]/.test(c) && !/[\w$]/.test(s[i - 1] || '') && (m = rest.match(/^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[a-zA-Z]*/))) {
      emit(m[0], 'num');
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const w = (rest.match(/^[A-Za-z_$][\w$]*/) as RegExpMatchArray)[0];
      const after = s.slice(i + w.length, i + w.length + 40);
      let k: TokKind = '';
      if (L.kv) k = /^\s*[:=]/.test(after) && !s.slice(0, i).replace(/^\s*-\s*/, '').trim() ? 'fn' : LIT.has(w) ? 'num' : '';
      else if (kw.has(w)) k = 'kw';
      else if (LIT.has(w)) k = 'num';
      else if (/^\s*\(/.test(after) || (lang === 'rs' && after[0] === '!')) k = 'fn';
      else if (/^[A-Z][a-z0-9]/.test(w)) k = 'type';
      emit(w, k);
      i += w.length;
      continue;
    }
    if (L.sh && !/\s/.test(c)) cmdStart = false;
    emit(c, '');
    i++;
  }
  return { segs: out.length ? out : [{ t: ' ', k: '' }], st };
}

/** Split highlighted tokens further where `re` (a grep pattern) matches, marking hits. */
export function overlay(segs: Tok[], text: string, re: RegExp | null): Tok[] {
  if (!re || !text) return segs;
  const R: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) && n++ < 200) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    R.push([m.index, m.index + m[0].length]);
  }
  if (!R.length) return segs;
  const out: Tok[] = [];
  let pos = 0;
  segs.forEach((sg) => {
    const b = pos + sg.t.length;
    let cur = pos;
    R.forEach(([x, y]) => {
      if (y <= cur || x >= b) return;
      if (x > cur) out.push({ t: text.slice(cur, x), k: sg.k });
      const e = Math.min(y, b);
      out.push({ t: text.slice(Math.max(x, cur), e), k: sg.k, h: true });
      cur = e;
    });
    if (cur < b) out.push({ t: text.slice(cur, b), k: sg.k });
    pos = b;
  });
  return out;
}

const CL = new Map<string, { segs: ColSeg[] }[]>();
/** Highlighted lines of a fenced code block (`lang` is the fence tag; `diff`/`patch` get +/- colors). */
export function codeLines(text: string, lang: string): { segs: ColSeg[] }[] {
  const key = lang + '\u0000' + text;
  const hit = CL.get(key);
  if (hit) return hit;
  const l0 = String(lang || '').toLowerCase();
  const lg = FENCE[l0] || null;
  let st: Carry = null;
  const out = String(text)
    .split('\n')
    .map((l) => {
      if (l0 === 'diff' || l0 === 'patch') {
        const k = l.startsWith('@@') ? 'fn' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';
        return { segs: [{ t: l || ' ', c: COL[k] || 'var(--fg-3)' }] };
      }
      const r = lg ? tokLine(l, lg, st) : { segs: [{ t: l || ' ', k: '' as TokKind }], st: null };
      st = r.st;
      return { segs: r.segs.map((g) => ({ t: g.t, c: COL[g.k] || 'var(--fg-3)' })) };
    });
  if (CL.size > 400) CL.clear();
  CL.set(key, out);
  return out;
}
