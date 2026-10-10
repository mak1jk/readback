import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import type { AgentId, Session, Step, Turn } from './model';
import { AGENTS, agentDot, agentOf, isSupported } from './lib/agents';
import { THEMES, applyTheme, isThemeKey, type ThemeKey } from './lib/themes';
import { K, MON, clip, dayKey, dayLbl, dur, fileSlug, hm, parseBlocks, rawRowsOf, type Seg } from './lib/format';
import { sessionMarkdown } from './lib/export';
import { codeLines, type ColSeg } from './lib/highlight';
import { isShellName, normTool, structOf, type NormTool, type SBlock } from './lib/tools';
import * as P from './platform';

type Tab = 'transcript' | 'overview' | 'trace';
type Flags = Record<string, boolean>;
type TogKey = 'ctx' | 'prompts' | 'rawItems' | 'full' | 'events' | 'more' | 'plain' | 'scripts';
type Tog = (key: TogKey, id: string) => void;

interface State {
  agents: AgentId[];
  agent: AgentId;
  agentMenu: boolean;
  sessions: Session[];
  selId: string | null;
  loading: boolean;
  query: string;
  day: string | null;
  tab: Tab;
  raw: boolean;
  theme: ThemeKey;
  work: Flags;
  tools: Flags;
  ctx: Flags;
  prompts: Flags;
  rawItems: Flags;
  full: Flags;
  events: Flags;
  groupAll: Flags;
  days: Flags;
  files: Flags;
  more: Flags;
  filesAll: Flags;
  plain: Flags;
  scripts: Flags;
  loadErrors: Flags;
  allOpen: boolean | null;
  daysAll: boolean | null;
  traceTurn: number | null;
  toast: string;
  dragging: boolean;
  w: number;
}

const AGENTS_KEY = 'session-explorer-agents';
const THEME_KEY = 'session-explorer-theme';
const SHOW_REASONING = true;

function initialState(): State {
  let agents: AgentId[] = ['codex'];
  let agent: AgentId = 'codex';
  let theme: ThemeKey = 'nocturne';
  try {
    const a = JSON.parse(localStorage.getItem(AGENTS_KEY) || 'null');
    if (a && Array.isArray(a.agents)) {
      const ok = a.agents.filter((id: string) => AGENTS.some((x) => x.id === id));
      if (ok.length) {
        agents = ok;
        agent = ok.includes(a.agent) ? a.agent : ok[0];
      }
    }
    const t = localStorage.getItem(THEME_KEY);
    if (isThemeKey(t)) theme = t;
  } catch {
    /* storage unavailable */
  }
  return {
    agents, agent, agentMenu: false, sessions: [], selId: null, loading: true, query: '', day: null, tab: 'transcript', raw: false, theme,
    work: {}, tools: {}, ctx: {}, prompts: {}, rawItems: {}, full: {}, events: {}, groupAll: {}, days: {}, files: {}, more: {}, filesAll: {}, plain: {}, scripts: {}, loadErrors: {},
    allOpen: null, daysAll: null, traceTurn: null, toast: '', dragging: false, w: 0,
  };
}

const saveAgents = (agents: AgentId[], agent: AgentId) => {
  try {
    localStorage.setItem(AGENTS_KEY, JSON.stringify({ agents, agent }));
  } catch {
    /* ignore */
  }
};

const domIdOf = (s: Session, i: number) => s.id.replace(/\W/g, '') + '-' + i;
const turnText = (t: Turn) => (t.prompt + ' ' + t.steps.map((s) => ('text' in s ? s.text : '') || (s.kind === 'tool' ? s.cmd : '')).join(' ')).toLowerCase();
const turnsOf = (s: Session) => (s.stub ? s.turnCount || 0 : s.turns.length);
const stepText = (s: Step) => (s.kind === 'tool' ? s.cmd : s.text) || '';
const mono = "'JetBrains Mono',monospace";

// Upsert by id, newest first.
const mergeSessions = (cur: Session[], add: Session[]) => add.concat(cur.filter((x) => !add.some((a) => a.id === x.id)));

export default function App() {
  const [S, setS] = useState<State>(initialState);
  const set = useCallback((p: Partial<State> | ((s: State) => Partial<State>)) => setS((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) })), []);
  const stateRef = useRef(S);
  stateRef.current = S;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>();
  const effSelRef = useRef<string | undefined>();

  const flash = useCallback((t: string) => {
    set({ toast: t });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => set({ toast: '' }), 2000);
  }, [set]);
  const copy = useCallback((text: string, msg?: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    flash(msg || 'Copied');
  }, [flash]);
  const tog = (key: TogKey, id: string) => set((s) => ({ [key]: { ...s[key], [id]: !s[key][id] } }));
  const scrollTop = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  // ---- Theme ----
  useEffect(() => applyTheme(S.theme), [S.theme]);
  const setTheme = (k: ThemeKey) => {
    try {
      localStorage.setItem(THEME_KEY, k);
    } catch {
      /* ignore */
    }
    set({ theme: k });
  };

  // ---- Width (right rail shows at ≥1100px) ----
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !window.ResizeObserver) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (Math.abs(w - stateRef.current.w) > 8) set({ w });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [set]);

  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  // ---- Loading: library + scanned agent folders ----
  // On the desktop, sessions start as list-only stubs from Rust summaries and are parsed in full
  // when opened, so multi-GB session folders stay responsive.
  const stubOf = (it: P.ScanItem, agent: AgentId, id: string, libKey: string): Session | null => {
    const m = it.summary;
    if (!m) return null;
    const stamp = (v: string | null, fallback: number) => {
      const t = v && /^\d+$/.test(v) ? Number(v) : Date.parse(v || '');
      return Number.isFinite(t) ? t : fallback;
    };
    const started = stamp(m.started, it.mtime);
    return {
      id, agent, libKey, saved: true, path: it.path, stub: true, turnCount: m.turns,
      title: m.title || it.name, file: it.name, cwd: m.cwd, repo: m.repo, branch: m.branch, model: m.model, cli: m.cli, provider: '',
      started, ended: stamp(m.ended, started), contextWindow: null,
      tokens: m.tokens, counts: { tools: 0, reasoning: 0, messages: 0, failed: 0 }, turns: [],
    };
  };

  const scanDir = useCallback(async (agent: AgentId, dir: string): Promise<Session[]> => {
    const ag = agentOf(agent);
    if (!P.isTauri || !isSupported(ag)) return [];
    try {
      const hidden = P.hiddenPaths();
      const items = await P.scanFolder(agent, dir, ag.exts);
      const known = new Set(stateRef.current.sessions.map((s) => s.path).filter(Boolean));
      const got = items
        .filter((f) => !hidden.has(f.path) && !known.has(f.path))
        .map((f) => stubOf(f, agent, 'fs:' + f.path, 'fs:' + f.path))
        .filter((x): x is Session => !!x);
      if (got.length) set((st) => ({ sessions: mergeSessions(st.sessions, got) }));
      await P.watchFolder(ag.id, dir, ag.exts);
      return got;
    } catch {
      return []; // folder unreadable: the agent just shows its empty state
    }
  }, [set]);

  const scanAgent = useCallback(async (agent: AgentId) => {
    if (agentOf(agent).autoScan !== false) await scanDir(agent, agentOf(agent).path);
    for (const f of P.extraFolders()) if (f.agent === agent) await scanDir(agent, f.path);
  }, [scanDir]);

  useEffect(() => {
    let cancelled = false;
    const unlisten: (() => void)[] = [];
    (async () => {
      const recs = (await P.libraryLoad()).sort((a, b) => b.added - a.added);
      const lib: Session[] = [];
      for (const r of recs) {
        const ag = agentOf(r.agent);
        try {
          if (r.text) {
            const s = ag.parse?.(r.text, r.name);
            if (s && s.turns.length) lib.push(Object.assign(s, { id: 'lib-' + r.key, agent: r.agent, saved: true, libKey: r.key, path: r.path }));
          } else if (r.path && P.isTauri) {
            const [it] = await P.summarizeFiles(r.agent, [r.path]);
            const s = it && stubOf(it, r.agent, 'lib-' + r.key, r.key);
            if (s) lib.push(s);
          }
        } catch {
          /* skip unreadable record */
        }
      }
      if (cancelled) return;
      if (lib.length) set((st) => ({ sessions: mergeSessions(st.sessions, lib) }));
      if (P.isTauri) {
        for (const id of stateRef.current.agents) await scanAgent(id);
        const pending: Record<string, number> = {};
        unlisten.push(
          await P.onSessionFileChanged((f) => {
            clearTimeout(pending[f.path]);
            pending[f.path] = window.setTimeout(async () => {
              if (P.hiddenPaths().has(f.path)) return;
              const cur = stateRef.current.sessions.find((x) => x.path === f.path && (!f.agent || x.agent === f.agent));
              const ag = f.agent ? AGENTS.find((a) => a.id === f.agent) : cur ? agentOf(cur.agent) : undefined;
              if (!ag?.parse) return;
              const id = cur?.id || 'fs:' + f.path;
              const libKey = cur?.libKey || 'fs:' + f.path;
              try {
                if (cur && !cur.stub) {
                  // Open session: re-parse in full so the transcript follows the live file.
                  const s = ag.parse(await P.readSession(f.path), f.name);
                  if (s && s.turns.length) set((st) => ({ sessions: mergeSessions(st.sessions, [Object.assign(s, { id, agent: ag.id, saved: true, libKey, path: f.path })]) }));
                } else {
                  const [it] = await P.summarizeFiles(ag.id, [f.path]);
                  const s = it && stubOf(it, ag.id, id, libKey);
                  if (s) set((st) => ({ sessions: mergeSessions(st.sessions, [s]) }));
                }
              } catch {
                /* file mid-write; the next change event retries */
              }
            }, 400);
          }),
        );
      } else if (import.meta.env.DEV && !stateRef.current.sessions.length) {
        // Dev preview in a plain browser: show the synthetic demo sessions (also used for README
        // screenshots) plus one sample per other agent. Not part of production builds.
        const demo = import.meta.glob('../fixtures/demo/*.jsonl', { query: '?raw', import: 'default' });
        const samples: [AgentId, () => Promise<unknown>][] = [
          ['claude', () => import('../fixtures/claude-session-sample.jsonl?raw').then((m) => m.default)],
          ['gemini', () => import('../fixtures/gemini-session-sample.json?raw').then((m) => m.default)],
          ['opencode', () => import('../fixtures/opencode-export-sample.json?raw').then((m) => m.default)],
          ['aider', () => import('../fixtures/aider-history-sample.md?raw').then((m) => m.default)],
          ['pi', () => import('../fixtures/pi-session-sample.jsonl?raw').then((m) => m.default)],
        ];
        const sources: [AgentId, string, () => Promise<unknown>][] = Object.entries(demo)
          .map(([p, load]): [AgentId, string, () => Promise<unknown>] => ['codex', p.split('/').pop() as string, load])
          .concat(samples.map(([a, load]) => [a, a + '-sample', load]));
        const got: Session[] = [];
        for (const [agent, name, load] of sources) {
          try {
            const s = agentOf(agent).parse?.(String(await load()), name);
            if (s && s.turns.length) got.push(Object.assign(s, { id: 'demo:' + agent + ':' + name, agent }));
          } catch {
            /* skip a sample the adapter rejects */
          }
        }
        if (got.length) set((st) => ({ sessions: mergeSessions(st.sessions, got) }));
      }
      if (!cancelled) set({ loading: false });
    })();
    return () => {
      cancelled = true;
      unlisten.forEach((u) => u());
    };
  }, [set, scanAgent]);

  // ---- Import ----
  const importFiles = useCallback(async (files: P.SourceFile[]) => {
    const st = stateRef.current;
    const ag = agentOf(st.agent);
    if (!ag.parse) {
      flash('Reading ' + ag.name + ' sessions is coming soon');
      return;
    }
    const list = files.filter((f) => ag.exts.some((ext) => f.name.toLowerCase().endsWith('.' + ext)) || f.name.toLowerCase().endsWith('.txt'));
    const added: Session[] = [];
    let dup = 0;
    for (const f of list) {
      const key = ag.id + ':' + (f.path || f.name + ':' + f.size);
      if (st.sessions.some((x) => x.agent === ag.id && (x.libKey === key || x.libKey === f.name + ':' + f.size || (f.path && x.path === f.path))) || added.some((x) => x.libKey === key)) {
        dup++;
        continue;
      }
      try {
        if (f.path && P.isTauri) {
          // Desktop: keep a reference to the file instead of copying its contents.
          const [it] = await P.summarizeFiles(ag.id, [f.path]);
          const s = it && stubOf(it, ag.id, 'lib-' + key, key);
          if (s) {
            added.push(s);
            P.librarySave({ key, agent: ag.id, name: f.name, text: '', added: Date.now(), path: f.path });
          }
          continue;
        }
        const raw = await f.text();
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const s = ag.parse(text, f.name);
        if (s && s.turns.length) {
          Object.assign(s, { id: 'lib-' + key, agent: ag.id, saved: true, libKey: key });
          added.push(s);
          P.librarySave({ key, agent: ag.id, name: f.name, text, added: Date.now() });
        }
      } catch {
        /* not a session file */
      }
    }
    if (added.length) {
      set((s) => ({ sessions: added.concat(s.sessions), selId: added[0].id, query: '', day: null, traceTurn: null }));
      flash(added.length + (added.length > 1 ? ' sessions' : ' session') + ' saved to library' + (dup ? ' · ' + dup + ' already there' : ''));
    } else if (dup) flash(dup === 1 ? 'Already in library' : dup + ' sessions already in library');
    else if (files.length) flash('No ' + ag.name + ' sessions found in ' + (list.length ? 'those files' : 'that selection'));
  }, [flash, set]);

  const openFiles = useCallback(async () => {
    if (!P.isTauri) return fileRef.current?.click();
    const ag = agentOf(stateRef.current.agent);
    if (!ag.parse) return flash('Reading ' + ag.name + ' sessions is coming soon');
    importFiles(await P.pickFiles(ag.exts));
  }, [importFiles, flash]);
  const openFolder = useCallback(async () => {
    if (!P.isTauri) return dirRef.current?.click();
    const ag = agentOf(stateRef.current.agent);
    if (!ag.parse) return flash('Reading ' + ag.name + ' sessions is coming soon');
    const dir = await P.pickFolder();
    if (!dir) return;
    P.addFolder(ag.id, dir);
    const got = await scanDir(ag.id, dir);
    if (got.length) {
      set({ selId: got.sort((a, b) => b.started - a.started)[0].id, query: '', day: null, traceTurn: null });
      flash(got.length + (got.length > 1 ? ' sessions' : ' session') + ' saved to library');
    } else flash('No ' + ag.name + ' sessions found in that folder');
  }, [importFiles, flash, scanDir, set]);

  // Open a stub: read and parse the full file once it is selected.
  const loadingId = useRef<string | null>(null);
  useEffect(() => {
    const st = stateRef.current;
    const cur = st.sessions.find((x) => x.id === effSelRef.current);
    if (!cur?.stub || !cur.path || st.loadErrors[cur.id] || loadingId.current === cur.id) return;
    loadingId.current = cur.id;
    const ag = agentOf(cur.agent);
    P.readSession(cur.path)
      .then((text) => {
        const s = ag.parse?.(text, cur.file);
        if (!s || !s.turns.length) throw new Error('empty');
        set((st2) => ({ sessions: st2.sessions.map((x) => (x.id === cur.id ? Object.assign(s, { id: cur.id, agent: cur.agent, saved: cur.saved, libKey: cur.libKey, path: cur.path }) : x)) }));
      })
      .catch(() => { set((st2) => ({ loadErrors: { ...st2.loadErrors, [cur.id]: true } })); flash('Couldn’t read that session file'); })
      .finally(() => {
        loadingId.current = null;
      });
  });

  const removeSession = async (s: Session) => {
    if (s.libKey?.startsWith('fs:') && s.path) P.hidePath(s.path);
    else if (s.libKey) await P.libraryDelete(s.libKey);
    set((st) => ({ sessions: st.sessions.filter((x) => x.id !== s.id), selId: null }));
    flash('Removed from library');
  };

  // ---- Native menu + shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === 'Escape') set({ agentMenu: false });
    };
    window.addEventListener('keydown', onKey);
    let un: (() => void) | undefined;
    if (P.isTauri) P.onMenu((id) => (id === 'import' ? openFiles() : id === 'open-folder' ? openFolder() : id === 'find' ? searchRef.current?.focus() : null)).then((u) => (un = u));
    return () => {
      window.removeEventListener('keydown', onKey);
      un?.();
    };
  }, [openFiles, openFolder, set]);

  // ---- Navigation ----
  const jump = (domId: string) => {
    const el = document.getElementById('turn-' + domId);
    const sc = scrollRef.current;
    if (el && sc) sc.scrollTo({ top: el.offsetTop - sc.offsetTop - 16, behavior: 'smooth' });
  };
  const goTurn = (domId: string) => {
    if (S.tab === 'transcript') return jump(domId);
    set({ tab: 'transcript' });
    setTimeout(() => jump(domId), 60);
  };

  // ---- Drag & drop ----
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (!S.dragging) set({ dragging: true });
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set({ dragging: false });
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    set({ dragging: false });
    importFiles(await P.fromDataTransfer(e.dataTransfer));
  };

  // ================= Derived view =================
  const tab = S.tab;
  const isTrace = tab === 'trace';
  const isDash = tab === 'overview';
  const q = S.query.trim().toLowerCase();
  const agent = S.agents.includes(S.agent) ? S.agent : S.agents[0];
  const agSessions = useMemo(() => S.sessions.filter((x) => (x.agent || 'codex') === agent), [S.sessions, agent]);
  const effSel = (agSessions.find((x) => x.id === S.selId) || agSessions.slice().sort((a, b) => b.started - a.started)[0])?.id;
  const s = S.sessions.find((x) => x.id === effSel);
  effSelRef.current = effSel;

  // Sidebar groups
  const filtered = agSessions
    .filter((x) => (!S.day || dayKey(x.started) === S.day) && (!q || x.title.toLowerCase().includes(q) || x.turns.some((t) => turnText(t).includes(q))))
    .sort((a, b) => b.started - a.started);
  const selLabel = s ? dayLbl(s.started) : '';
  type Group = { label: string; items: Session[]; open: boolean; turns: number };
  const groups: Group[] = [];
  filtered.forEach((x) => {
    const label = dayLbl(x.started);
    let g = groups.find((y) => y.label === label);
    if (!g) {
      const open = q || S.day ? true : S.days[label] != null ? S.days[label] : S.daysAll != null ? S.daysAll : label === selLabel;
      groups.push((g = { label, items: [], open, turns: 0 }));
    }
    g.turns += turnsOf(x);
    g.items.push(x);
  });
  const anyDayOpen = groups.some((g) => g.open);
  const matchOf = (x: Session) => {
    if (!q || x.title.toLowerCase().includes(q)) return '';
    const t = x.turns.find((t) => turnText(t).includes(q));
    const src = t && (t.prompt.toLowerCase().includes(q) ? t.prompt : stepText(t.steps.find((y) => stepText(y).toLowerCase().includes(q)) || ({ kind: 'message', text: '' } as Step)));
    if (!src) return '';
    const i = src.toLowerCase().indexOf(q);
    return (i > 30 ? '…' : '') + src.slice(Math.max(0, i - 30), i + 90).replace(/\s+/g, ' ');
  };

  // Activity calendar
  const cal = useMemo(() => {
    if (!agSessions.length) return { weeks: [] as { k: string; c: number; t: number }[][], range: '', last: 0 };
    const counts: Record<string, number> = {};
    agSessions.forEach((x) => {
      const k = dayKey(x.started);
      counts[k] = (counts[k] || 0) + 1;
    });
    const last = Math.max(...agSessions.map((x) => x.started));
    const end = new Date(last);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(start.getDate() - 7 * 16 + 1);
    const weeks = [];
    for (let w = 0; w < 16; w++) {
      const days = [];
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(start.getDate() + w * 7 + d);
        const k = dayKey(dt.getTime());
        days.push({ k, c: counts[k] || 0, t: dt.getTime() });
      }
      weeks.push(days);
    }
    return { weeks, range: MON[start.getMonth()] + ' – ' + MON[end.getMonth()] + ' ' + end.getFullYear(), last };
  }, [agSessions]);

  const agentEmpty = !S.loading && agSessions.length === 0;
  const ea = agentOf(agent);
  const showRail = !isTrace && !isDash && !!s && (S.w || 9999) >= 1100;

  // ================= Render =================
  return (
    <div
      ref={rootRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ position: 'relative', display: 'flex', height: '100vh', minHeight: 560, overflow: 'hidden', background: 'var(--bg)', fontSize: 13.5, color: 'var(--fg)', fontFamily: 'Inter,system-ui,sans-serif' }}
    >
      <aside style={{ width: 'clamp(240px,26%,300px)', flex: 'none', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line)', minWidth: 0 }}>
        {/* Agent tabs */}
        <div style={{ position: 'relative', padding: '12px 12px 2px 12px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
            {S.agents.map((id) => {
              const a = agentOf(id);
              const on = id === agent;
              const c = S.sessions.filter((x) => (x.agent || 'codex') === id).length;
              return (
                <button
                  key={id}
                  className="h-surface"
                  title={a.path}
                  onClick={() => {
                    set({ agent: id, day: null, traceTurn: null, selId: null });
                    saveAgents(S.agents, id);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 7, border: 0, background: on ? 'var(--surface)' : 'transparent', boxShadow: on ? '0 0 0 1px var(--line-2)' : 'none', color: on ? 'var(--fg)' : 'var(--muted)', font: '500 12px Inter,sans-serif', cursor: 'pointer' }}
                >
                  <Dot color={agentDot(a)} />
                  {a.name}
                  <span style={{ color: 'var(--faint)', fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>{c || ''}</span>
                </button>
              );
            })}
            <button className="h-surface" aria-label="Add an agent" aria-expanded={S.agentMenu} onClick={() => set({ agentMenu: !S.agentMenu })} title="Add an agent" style={{ position: 'relative', zIndex: S.agentMenu ? 22 : undefined, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, border: '1px dashed var(--line-2)', background: S.agentMenu ? 'var(--surface)' : 'transparent', color: 'var(--fg-3)', cursor: 'pointer', fontSize: 13 }}>
              <i className="ph ph-plus" />
            </button>
          </div>
          {S.agentMenu && (
            <>
              <div onClick={() => set({ agentMenu: false })} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
              <div style={{ position: 'absolute', left: 12, width: 300, maxWidth: 'calc(100vw - 24px)', top: 46, zIndex: 21, display: 'flex', flexDirection: 'column', padding: 6, borderRadius: 10, background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line-2), 0 12px 32px rgba(0,0,0,0.45)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px 8px' }}>
                  <span style={eyebrow}>Agents</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>Each agent gets its own tab and reads sessions from its folder on this computer.</span>
                </div>
                {AGENTS.map((a) => {
                  const on = S.agents.includes(a.id);
                  const c = S.sessions.filter((x) => (x.agent || 'codex') === a.id).length;
                  const sup = isSupported(a);
                  return (
                    <button
                      key={a.id}
                      className="h-hover"
                      onClick={() => {
                        const next = on ? S.agents.filter((x) => x !== a.id) : S.agents.concat(a.id);
                        if (!next.length) return flash('Keep at least one agent');
                        const act = on ? (a.id === agent ? next[0] : agent) : a.id;
                        set({ agents: next, agent: act, day: null, selId: null, agentMenu: false });
                        saveAgents(next, act);
                        if (!on) scanAgent(a.id);
                      }}
                      style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--fg)', textAlign: 'left', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}
                    >
                      <i className={on ? 'ph ph-check-square' : 'ph ph-square'} style={{ fontSize: 16, color: on ? 'var(--accent-fg)' : 'var(--dim)' }} />
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500 }}>
                          <Dot color={agentDot(a)} />
                          {a.name}
                        </span>
                        <span style={{ font: `400 11px ${mono}`, color: 'var(--faint)', ...ellipsis }}>{a.path}</span>
                      </span>
                      <span style={{ fontSize: 11, color: sup ? 'var(--muted)' : 'var(--faint)', whiteSpace: 'nowrap' }}>{sup ? c + (c === 1 ? ' session' : ' sessions') : 'Coming soon'}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px 12px 16px', minWidth: 0 }}>
          <span style={{ fontWeight: 500, fontSize: 15, letterSpacing: '-0.01em' }}>Sessions</span>
          <span style={{ color: 'var(--faint)', fontSize: 12 }}>{agSessions.length}</span>
          <div style={{ flex: 1 }} />
          <IconBtn onClick={() => set({ daysAll: !anyDayOpen, days: {} })} title={anyDayOpen ? 'Collapse to days' : 'Expand all days'} icon={anyDayOpen ? 'ph ph-rows' : 'ph ph-list'} />
          <IconBtn onClick={openFolder} title="Open a sessions folder" icon="ph ph-folder-open" />
          <button className="h-tint" onClick={openFiles} title={'Import ' + ea.name + ' sessions'} style={{ ...iconBtn, flex: 'none', border: '1px solid var(--accent)', color: 'var(--accent-fg-2)' }}>
            <i className="ph ph-upload-simple" />
          </button>
          <input type="file" accept={ea.exts.map((ext) => '.' + ext).concat('.txt').join(',')} multiple ref={fileRef} onChange={(e) => { importFiles(P.fromFileList(e.target.files)); e.target.value = ''; }} style={{ display: 'none' }} />
          <input type="file" multiple ref={dirRef} onChange={(e) => { importFiles(P.fromFileList(e.target.files)); e.target.value = ''; }} style={{ display: 'none' }} />
        </div>

        {/* Search */}
        <div style={{ padding: '0 14px 12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', borderRadius: 8, background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line-2)' }}>
            <i className="ph ph-magnifying-glass" style={{ color: 'var(--faint)' }} />
            <input ref={searchRef} value={S.query} onChange={(e) => set({ query: e.target.value })} placeholder="Search prompts, replies, commands" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', font: '400 13px Inter,sans-serif' }} />
            {!!q && (
              <button onClick={() => set({ query: '' })} style={{ border: 0, background: 'transparent', color: 'var(--faint)', cursor: 'pointer', padding: 0, display: 'flex' }}>
                <i className="ph ph-x" />
              </button>
            )}
          </div>
        </div>

        {/* Activity calendar */}
        <div style={{ padding: '2px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, color: 'var(--faint)' }}>
            <span style={{ fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Activity</span>
            <span>{cal.range}</span>
            <div style={{ flex: 1 }} />
            {S.day && (
              <button onClick={() => set({ day: null })} style={{ border: 0, background: 'transparent', color: 'var(--accent-fg)', font: '500 11px Inter,sans-serif', cursor: 'pointer', padding: 0 }}>
                {(() => {
                  const [, m, d] = S.day.split('-');
                  return MON[+m - 1] + ' ' + d;
                })()}{' '}
                ✕
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(16,minmax(0,1fr))', gap: 3, maxWidth: 256, overflow: 'hidden' }}>
            {cal.weeks.map((days, wi) => (
              <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                {days.map((d) => {
                  const sel = S.day === d.k;
                  return (
                    <button
                      key={d.k}
                      onClick={() => d.c && set({ day: sel ? null : d.k })}
                      title={dayLbl(d.t) + ' · ' + d.c + (d.c === 1 ? ' session' : ' sessions')}
                      style={{ width: '100%', aspectRatio: '1', padding: 0, borderRadius: 3, border: 0, background: d.c === 0 ? 'var(--surface)' : d.c === 1 ? 'var(--bar)' : 'var(--accent)', boxShadow: sel ? '0 0 0 1.5px var(--accent-fg-3)' : 'none', cursor: 'pointer', opacity: d.t > cal.last + 864e5 ? 0.35 : 1 }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 16px' }}>
          {groups.map((g) => (
            <Fragment key={g.label}>
              <button className="h-hover-fg" onClick={() => set((s2) => ({ days: { ...s2.days, [g.label]: !g.open } }))} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', marginTop: 4, padding: '8px 8px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--muted)', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
                <i className={g.open ? 'ph ph-caret-down' : 'ph ph-caret-right'} style={{ fontSize: 11, color: 'var(--faint)' }} />
                <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{g.label}</span>
                {!g.open && g.label === selLabel && <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--accent)' }} />}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>
                  {g.items.length + (g.items.length === 1 ? ' session' : ' sessions') + ' · ' + g.turns + ' turns'}
                </span>
              </button>
              {g.open &&
                g.items.map((x) => {
                  const active = x.id === effSel;
                  const match = matchOf(x);
                  return (
                    <button
                      key={x.id}
                      className="h-surface"
                      onClick={() => {
                        set({ selId: x.id, traceTurn: null });
                        scrollTop();
                      }}
                      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 5, width: '100%', textAlign: 'left', padding: '9px 10px 10px 12px', border: 0, borderRadius: 8, background: active ? 'var(--surface)' : 'transparent', color: 'var(--fg)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}
                    >
                      {active && <span style={{ position: 'absolute', left: 0, top: 10, bottom: 10, width: 2, borderRadius: 2, background: 'var(--accent)' }} />}
                      <span style={{ fontWeight: 500, fontSize: 13, lineHeight: 1.4, ...clamp2 }}>{x.title}</span>
                      {match && <span style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--accent-fg)', ...clamp2 }}>{match}</span>}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--faint)', minWidth: 0 }}>
                        <i className="ph ph-git-branch" />
                        <span style={ellipsis}>{(x.repo || x.cwd) + (x.branch ? ' · ' + x.branch : '')}</span>
                      </span>
                      <span style={{ display: 'flex', gap: 7, fontSize: 11, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>
                        <span>{hm(x.started)}</span>
                        <span>·</span>
                        <span>{turnsOf(x)} turns</span>
                        <span>·</span>
                        <span>{x.tokens ? K(x.tokens.input + x.tokens.output) + ' tok' : 'Usage unavailable'}</span>
                      </span>
                    </button>
                  );
                })}
            </Fragment>
          ))}
          {agentEmpty && <div style={{ padding: '24px 10px', color: 'var(--faint)', fontSize: 12.5, lineHeight: 1.5 }}>No sessions for this agent yet.</div>}
          {filtered.length === 0 && agSessions.length > 0 && <div style={{ padding: '32px 10px', color: 'var(--faint)', fontSize: 13, lineHeight: 1.5 }}>No sessions match.</div>}
        </div>

        {/* Theme footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 12px', borderTop: '1px solid var(--line)' }}>
          <i className="ph ph-palette" style={{ color: 'var(--faint)' }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{THEMES[S.theme].name}</span>
          <div style={{ flex: 1 }} />
          {(Object.keys(THEMES) as ThemeKey[]).map((k) => (
            <button key={k} onClick={() => setTheme(k)} title={THEMES[k].name} style={{ width: 22, height: 22, padding: 0, borderRadius: 11, border: 0, cursor: 'pointer', background: `linear-gradient(135deg, ${THEMES[k].v.bg} 0 50%, ${THEMES[k].v.accent} 50% 100%)`, boxShadow: k === S.theme ? '0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent)' : '0 0 0 1px var(--line-2)' }} />
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {S.loading && <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '0 48px', color: 'var(--faint)' }}>Loading sessions…</div>}
        {agentEmpty && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 32px' }}>
            <div style={{ maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: agentDot(ea) }} />
                {ea.name}
              </span>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--fg-strong)' }}>No {ea.name} sessions yet</h2>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--muted)', textWrap: 'pretty' } as CSSProperties}>
                {isSupported(ea)
                  ? ea.hint || (P.isTauri ? 'New sessions in this folder appear automatically. You can also import session files by hand.' : 'Import session files or drop a sessions folder here. Automatic folder discovery is available in the desktop app.')
                  : 'Reading ' + ea.name + ' sessions isn’t available yet. Once it is, sessions from this folder will appear here automatically.'}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, background: 'var(--code)', boxShadow: '0 0 0 1px var(--line)', font: `400 12px ${mono}`, color: 'var(--fg-3)' }}>
                <i className="ph ph-folder" style={{ color: 'var(--faint)' }} />
                <span style={{ minWidth: 0, ...ellipsis }}>{ea.path}</span>
              </div>
              {isSupported(ea) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button onClick={openFolder} style={{ height: 32, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--tint)', color: 'var(--accent-fg-3)', font: '500 12.5px Inter,sans-serif', cursor: 'pointer' }}>
                    <i className="ph ph-folder-open" />
                    Open sessions folder
                  </button>
                  <button className="h-surface" onClick={openFiles} style={{ height: 32, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--fg-3)', font: '500 12.5px Inter,sans-serif', cursor: 'pointer' }}>
                    <i className="ph ph-upload-simple" />
                    Import files
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {!!s && !S.loading && s.stub && <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '0 48px', color: 'var(--faint)' }}>{S.loadErrors[s.id] ? <>Couldn’t read this session. <button style={linkBtn} onClick={() => set((st) => ({ loadErrors: { ...st.loadErrors, [s.id]: false } }))}>Retry</button></> : 'Loading session…'}</div>}
        {!!s && !S.loading && !s.stub && (
          <SessionView
            key={s.id}
            s={s}
            S={S}
            set={set}
            q={q}
            tab={tab}
            showRail={showRail}
            scrollRef={scrollRef}
            jump={jump}
            goTurn={goTurn}
            tog={tog}
            copy={copy}
            flash={flash}
            onRemove={() => removeSession(s)}
          />
        )}
      </main>

      {S.dragging && (
        <div style={{ position: 'absolute', inset: 12, borderRadius: 14, border: '1.5px dashed var(--accent)', background: 'var(--overlay)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, pointerEvents: 'none' }}>
          <i className="ph ph-file-arrow-down" style={{ fontSize: 34, color: 'var(--accent-fg)' }} />
          <span style={{ fontSize: 16, fontWeight: 500 }}>Drop to import</span>
          <span style={{ color: 'var(--muted)', fontSize: 12.5, fontFamily: mono }}>rollout-*.jsonl · a sessions folder</span>
        </div>
      )}
      {!!S.toast && (
        <div style={{ position: 'absolute', left: 320, bottom: 20, padding: '9px 14px', borderRadius: 8, background: 'var(--surface)', boxShadow: '0 0 0 1px var(--dim), 0 6px 18px rgba(0,0,0,0.55)', fontSize: 12.5, color: 'var(--fg)' }}>{S.toast}</div>
      )}
    </div>
  );
}

// ================= Session view (header, tabs, transcript / overview / trace, rail) =================

interface SessionViewProps {
  s: Session;
  S: State;
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void;
  q: string;
  tab: Tab;
  showRail: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  jump: (domId: string) => void;
  goTurn: (domId: string) => void;
  tog: Tog;
  copy: (text: string, msg?: string) => void;
  flash: (t: string) => void;
  onRemove: () => void;
}

function SessionView({ s, S, set, q, tab, showRail, scrollRef, jump, goTurn, tog, copy, flash, onRemove }: SessionViewProps) {
  const isTrace = tab === 'trace';
  const isDash = tab === 'overview';
  const allTurns = s.turns.map((t, i) => ({ t, i }));
  const visible = q ? allTurns.filter((x) => turnText(x.t).includes(q)) : allTurns;
  const selTurn = isTrace ? (S.traceTurn != null ? S.traceTurn : 0) : null;
  const readerList = isTrace ? allTurns.filter((x) => x.i === selTurn) : isDash ? [] : visible;
  const defOpen = false;
  const anyOpen = S.allOpen != null ? S.allOpen : defOpen;
  const failedAll: { n: number; cmd: string; exit: number | null; i: number }[] = [];
  s.turns.forEach((t, i) => t.steps.forEach((st) => {
    if (st.kind !== 'tool') return;
    const n = normTool(st);
    if (n.status === 'Failed') failedAll.push({ n: i + 1, cmd: n.title + (n.subject ? ' · ' + n.subject : ''), exit: n.exit, i });
  }));
  const scrollTop = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const exportMd = async () => {
    try {
      if (await P.saveText(fileSlug(s.title), sessionMarkdown(s))) flash('Markdown downloaded');
    } catch {
      flash('Export failed');
    }
  };
  const exportPdf = () => {
    set({ allOpen: true, work: {} });
    setTimeout(() => window.print(), 300);
  };

  const tabDef: [Tab, string, string, string][] = [
    ['transcript', 'Transcript', 'ph ph-chat-text', s.turns.length + ' turns'],
    ['overview', 'Overview', 'ph ph-chart-bar', ''],
    ['trace', 'Trace', 'ph ph-chart-bar-horizontal', ''],
  ];

  return (
    <>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '12px 16px', padding: '16px 24px 0', borderBottom: '1px solid var(--line)' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 500, letterSpacing: '-0.01em', lineHeight: 1.35, ...clamp2 }}>{s.title}</h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ height: 20, padding: '0 7px', display: 'flex', alignItems: 'center', borderRadius: 4, background: 'var(--tint)', color: 'var(--accent-fg-2)', font: `500 11px ${mono}` }}>{s.model || 'unknown model'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ph ph-git-branch" />
              {(s.repo || '—') + (s.branch ? '@' + s.branch : '')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: mono, fontSize: 11.5 }}>
              <i className="ph ph-folder" />
              {s.cwd}
            </span>
            <span>{dayLbl(s.started) + ', ' + hm(s.started)}</span>
            <span>{dur(s.ended - s.started)}</span>
            {s.saved && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ph ph-database" />
                In library
              </span>
            )}
          </div>
        </div>
        <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: '0 1 auto' }}>
          {!isDash && (
            <>
              <div style={{ display: 'flex', height: 30, padding: 2, borderRadius: 8, boxShadow: '0 0 0 1px var(--line-2)' }}>
                <button onClick={() => set({ raw: false })} title="Readable transcript" style={{ ...segBtn, background: S.raw ? 'transparent' : 'var(--tint)', color: S.raw ? 'var(--muted)' : 'var(--accent-fg-3)' }}>
                  <i className="ph ph-article" />
                  Readable
                </button>
                <button onClick={() => set({ raw: true, rawItems: {} })} title="Source JSONL for every item" style={{ ...segBtn, background: S.raw ? 'var(--tint)' : 'transparent', color: S.raw ? 'var(--accent-fg-3)' : 'var(--muted)' }}>
                  <i className="ph ph-brackets-curly" />
                  JSON
                </button>
              </div>
              <button className="h-surface" onClick={() => set({ allOpen: !anyOpen, work: {} })} title="Expand or collapse all work logs" style={{ height: 30, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--fg-3)', font: '500 12px Inter,sans-serif', cursor: 'pointer' }}>
                <i className={anyOpen ? 'ph ph-arrows-in-simple' : 'ph ph-arrows-out-simple'} />
                {anyOpen ? 'Collapse work' : 'Expand work'}
              </button>
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'center', height: 30, padding: 2, borderRadius: 8, boxShadow: '0 0 0 1px var(--line-2)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 6px 0 8px', font: '500 12px Inter,sans-serif', color: 'var(--faint)' }}>
              <i className="ph ph-export" />
              Export
            </span>
            <button className="h-surface" onClick={exportMd} title="Download as Markdown" style={exportBtn}>.md</button>
            <button className="h-surface" onClick={exportPdf} title="Print or save as PDF" style={exportBtn}>PDF</button>
          </div>
          {s.saved && (
            <button className="h-fail" onClick={onRemove} title="Remove from library" style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer' }}>
              <i className="ph ph-trash" />
            </button>
          )}
        </div>
        <div className="no-print" style={{ flexBasis: '100%', display: 'flex', gap: 2, marginTop: -2 }}>
          {tabDef.map(([id, label, icon, count]) => (
            <button
              key={id}
              className="h-fg"
              onClick={() => {
                set({ tab: id });
                scrollTop();
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 10px', border: 0, borderBottom: '2px solid ' + (tab === id ? 'var(--accent)' : 'transparent'), background: 'transparent', color: tab === id ? 'var(--fg)' : 'var(--muted)', font: '500 12.5px Inter,sans-serif', cursor: 'pointer' }}
            >
              <i className={icon} />
              {label}
              <span style={{ fontWeight: 400, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
            </button>
          ))}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {isTrace && <TraceList visible={visible} selTurn={selTurn} onSelect={(i) => { set({ traceTurn: i }); scrollTop(); }} onOpen={() => goTurn(domIdOf(s, selTurn || 0))} />}

        <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          <div style={{ maxWidth: 820, padding: '24px 28px 120px', display: 'flex', flexDirection: 'column', gap: 30 }}>
            {isDash && <Overview s={s} goTurn={goTurn} />}
            {isDash && failedAll.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--faint)' }}>Failed calls · {failedAll.length > 12 ? failedAll.length + ' (showing 12)' : failedAll.length}</span>
                <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 8, boxShadow: '0 0 0 1px var(--line)', overflow: 'hidden' }}>
                  {failedAll.slice(0, 12).map((fl, k) => (
                    <button key={k} className="h-hover" onClick={() => goTurn(domIdOf(s, fl.i))} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) auto', alignItems: 'center', gap: 10, width: '100%', minHeight: 32, padding: '5px 12px', border: 0, borderBottom: '1px solid var(--line-soft)', background: 'transparent', color: 'var(--fg-3)', textAlign: 'left', cursor: 'pointer' }}>
                      <span style={{ fontSize: 11, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>Turn {fl.n}</span>
                      <span style={{ font: `400 12px ${mono}`, ...ellipsis }}>{fl.cmd}</span>
                      {fl.exit != null ? <ExitBadge exit={fl.exit} /> : <span style={{ fontSize: 11, color: 'var(--fail-text)' }}>Failed</span>}
                    </button>
                  ))}
                </div>
                <span style={{ fontSize: 11, color: 'var(--faint)' }}>Click a row to open that turn in Transcript.</span>
              </div>
            )}
            {!!q && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{visible.length + ' of ' + s.turns.length + ' turns match “' + S.query.trim() + '”'}</div>}
            {readerList.map(({ t, i }) => (
              <TurnView key={i} s={s} t={t} i={i} S={S} set={set} tog={tog} copy={copy} defOpen={defOpen} />
            ))}
          </div>
        </div>

        {showRail && (
          <nav style={{ width: 236, flex: 'none', overflowY: 'auto', padding: '24px 14px 28px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div style={{ padding: '0 10px 8px', ...eyebrow }}>Prompts</div>
            {visible.map(({ t, i }) => (
              <button key={i} className="h-surface-fg" onClick={() => jump(domIdOf(s, i))} style={{ display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', padding: '6px 10px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--muted)', font: '400 12px/1.45 Inter,sans-serif', cursor: 'pointer' }}>
                <span style={{ display: 'flex', gap: 8 }}>
                  <span style={{ flex: 'none', color: 'var(--dim)', fontVariantNumeric: 'tabular-nums', minWidth: 16 }}>{i + 1}</span>
                  <span style={clamp2}>{clip(t.prompt.replace(/\s+/g, ' ') || '(no text)', 120)}</span>
                </span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </>
  );
}

// ---- Turn ----

type WorkItem =
  | { kind: 'reasoning'; title: string; body: string; raw: Step['raw'] }
  | { kind: 'tool'; tk: string; st: Extract<Step, { kind: 'tool' }> };
type Entry =
  | { kind: 'work'; wk: string; items: WorkItem[]; start: number; end: number }
  | { kind: 'message'; text: string; raw: Step['raw'] }
  | { kind: 'compaction' };

function TurnView({ s, t, i, S, set, tog, copy, defOpen }: { s: Session; t: Turn; i: number; S: State; set: SessionViewProps['set']; tog: SessionViewProps['tog']; copy: SessionViewProps['copy']; defOpen: boolean }) {
  const key = s.id + ':' + i;
  const entries: Entry[] = [];
  let work: Extract<Entry, { kind: 'work' }> | null = null;
  let wi = 0;
  t.steps.forEach((st, si) => {
    if (st.kind === 'message') {
      work = null;
      entries.push({ kind: 'message', text: st.text, raw: st.raw });
      return;
    }
    if (st.kind === 'compaction') {
      work = null;
      entries.push({ kind: 'compaction' });
      return;
    }
    if (st.kind === 'reasoning' && !SHOW_REASONING) return;
    if (!work) {
      work = { kind: 'work', wk: key + ':w' + wi++, items: [], start: st.t, end: st.t };
      entries.push(work);
    }
    const w: Extract<Entry, { kind: 'work' }> = work;
    w.end = Math.max(w.end, (st.kind === 'tool' && st.done) || st.t);
    if (st.kind === 'reasoning') {
      const m = st.text.match(/^\*\*(.+?)\*\*\s*/);
      const body = (m ? st.text.slice(m[0].length) : st.text).replace(/\*\*(.+?)\*\*/g, '$1').trim();
      w.items.push({ kind: 'reasoning', title: m ? m[1] : 'Thinking', body, raw: st.raw });
    } else w.items.push({ kind: 'tool', tk: key + ':' + si, st });
  });

  const long = t.prompt.length > 700;
  const pOpen = !!S.prompts[key];
  const tok = t.tokens;
  const footer = [dur(t.end - t.start), tok ? K(tok.output) + ' out' : '', tok ? K(tok.input) + ' in' : '', tok && tok.input > 0 ? Math.round((tok.cached / tok.input) * 100) + '% cached' : ''].filter(Boolean).join(' · ');
  const evOpen = !!S.events[key];

  return (
    <div id={'turn-' + domIdOf(s, i)} style={{ display: 'flex', gap: 16, scrollMarginTop: 16 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 8, background: 'var(--surface)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ fontWeight: 500, color: 'var(--fg-2)' }}>You</span>
            <span>{hm(t.start)}</span>
            {t.context.map((c, ci) => {
              const ck = key + ':c' + ci;
              return (
                <button key={ci} onClick={() => tog('ctx', ck)} title="Injected context" style={{ display: 'flex', alignItems: 'center', gap: 4, height: 20, padding: '0 7px', borderRadius: 4, border: '1px solid var(--line-2)', background: S.ctx[ck] ? 'var(--tint)' : 'transparent', color: 'var(--fg-4)', font: '500 11px Inter,sans-serif', cursor: 'pointer' }}>
                  <i className="ph ph-paperclip" />
                  {c.label}
                </button>
              );
            })}
            <span style={{ marginLeft: 'auto', color: 'var(--dim)', fontSize: 11, whiteSpace: 'nowrap' }}>Turn {i + 1}</span>
          </div>
          {t.context.map((c, ci) =>
            S.ctx[key + ':c' + ci] ? (
              <pre key={ci} style={{ margin: 0, maxHeight: 240, overflow: 'auto', padding: '10px 12px', borderRadius: 6, background: 'var(--code)', font: `400 11.5px/1.55 ${mono}`, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.text}</pre>
            ) : null,
          )}
          {!S.raw ? (
            <>
              <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--fg-strong)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', textWrap: 'pretty' } as CSSProperties}>
                {(long && !pOpen ? clip(t.prompt, 600) : t.prompt) || '(no text — attachment or empty prompt)'}
              </div>
              {long && (
                <button onClick={() => tog('prompts', key)} style={linkBtn}>
                  {pOpen ? 'Show less' : 'Show full prompt'}
                </button>
              )}
            </>
          ) : (
            <RawRows rows={(t.promptRows || []).concat(...t.context.map((c) => c.raw || []))} />
          )}
        </div>

        {entries.map((e, ei) =>
          e.kind === 'work' ? (
            <WorkBlock key={ei} e={e} S={S} set={set} tog={tog} copy={copy} defOpen={defOpen} />
          ) : e.kind === 'compaction' ? (
            <div key={ei} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: 'var(--faint)' }}>
              <span style={{ flex: 1, height: 1, background: 'linear-gradient(to right,var(--line-2-0),var(--line-2))' }} />
              <i className="ph ph-arrows-in-line-vertical" />
              Context compacted
              <span style={{ flex: 1, height: 1, background: 'linear-gradient(to left,var(--line-2-0),var(--line-2))' }} />
            </div>
          ) : S.raw ? (
            <RawRows key={ei} rows={e.raw} />
          ) : (
            <Markdown key={ei} text={e.text} copy={copy} />
          ),
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
          {t.aborted && <span style={{ color: 'var(--fail-text)' }}>Interrupted</span>}
          <span>{footer}</span>
          {!!t.rows?.length && (
            <button className="h-accent2" onClick={() => tog('events', key)} style={{ display: 'flex', alignItems: 'center', gap: 4, border: 0, background: 'transparent', padding: 0, color: 'var(--muted)', font: '500 11px Inter,sans-serif', cursor: 'pointer' }}>
              <i className="ph ph-brackets-curly" />
              {(evOpen ? 'Hide' : 'Show') + ' all ' + t.rows.length + ' JSONL events'}
            </button>
          )}
        </div>
        {evOpen && (
          <div style={{ maxHeight: 640, overflow: 'auto', paddingRight: 4 }}>
            <RawRows rows={t.rows} />
          </div>
        )}
      </div>
    </div>
  );
}

function WorkBlock({ e, S, set, tog, copy, defOpen }: { e: Extract<Entry, { kind: 'work' }>; S: State; set: SessionViewProps['set']; tog: SessionViewProps['tog']; copy: SessionViewProps['copy']; defOpen: boolean }) {
  const n = e.items.filter((x) => x.kind === 'tool').length;
  const r = e.items.filter((x) => x.kind === 'reasoning').length;
  const f = e.items.filter((x) => x.kind === 'tool' && normTool(x.st).status === 'Failed').length;
  const open = S.work[e.wk] != null ? S.work[e.wk] : S.allOpen != null ? S.allOpen : defOpen;
  const ga = !!S.groupAll[e.wk];
  const ot = e.items.reduce((a, x) => a + (x.kind === 'tool' ? normTool(x.st).outTok : 0), 0);
  const summary = [n ? n + (n === 1 ? ' command' : ' commands') : '', r ? r + ' thinking ' + (r === 1 ? 'step' : 'steps') : '', ot ? '≈' + K(ot) + ' tok of output' : ''].filter(Boolean).join(' · ');

  return (
    <div style={{ borderRadius: 8, boxShadow: '0 0 0 1px var(--line)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button className="h-hover" onClick={() => set((s2) => ({ work: { ...s2.work, [e.wk]: !open } }))} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', border: 0, background: 'transparent', color: 'var(--fg-3)', font: '500 12.5px Inter,sans-serif', cursor: 'pointer', textAlign: 'left' }}>
          <i className={open ? 'ph ph-caret-down' : 'ph ph-caret-right'} style={{ color: 'var(--faint)' }} />
          <span>{n ? 'Worked for ' + dur(e.end - e.start) : 'Thought'}</span>
          <span style={{ color: 'var(--faint)', fontWeight: 400 }}>{summary}</span>
          {f > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--fail-text)', fontWeight: 400 }}>
              <i className="ph ph-warning-circle" />
              {f} failed
            </span>
          )}
        </button>
        {open && n > 0 && (
          <button
            className="h-tint"
            onClick={() => {
              const ns = { ...S.tools };
              e.items.forEach((x) => {
                if (x.kind === 'tool') delete ns[x.tk];
              });
              set({ groupAll: { ...S.groupAll, [e.wk]: !ga }, tools: ns });
            }}
            style={{ flex: 'none', height: 26, marginRight: 6, padding: '0 9px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--accent-fg)', font: '500 11.5px Inter,sans-serif', cursor: 'pointer' }}
          >
            {ga ? 'Close outputs' : 'Open all outputs'}
          </button>
        )}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)', padding: '4px 0' }}>
          {e.items.map((x, k) =>
            x.kind === 'reasoning' ? (
              S.raw ? (
                <div key={k} style={{ padding: '8px 12px 8px 36px' }}>
                  <RawRows rows={x.raw} />
                </div>
              ) : (
                <div key={k} style={{ display: 'flex', gap: 10, padding: '8px 12px' }}>
                  <i className="ph ph-brain" style={{ color: 'var(--dim)', marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--fg-4)', fontWeight: 500 }}>{x.title}</span>
                    {!!x.body && <span style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--muted)', whiteSpace: 'pre-wrap', textWrap: 'pretty' } as CSSProperties}>{x.body}</span>}
                  </div>
                </div>
              )
            ) : (
              <ToolRow key={k} tk={x.tk} st={x.st} S={S} set={set} tog={tog} copy={copy} groupOpen={ga} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({ tk, st, S, set, tog, copy, groupOpen }: { tk: string; st: Extract<Step, { kind: 'tool' }>; S: State; set: SessionViewProps['set']; tog: Tog; copy: SessionViewProps['copy']; groupOpen: boolean }) {
  const n = normTool(st);
  const failed = n.status === 'Failed';
  const shell = isShellName(n.name);
  const icon = /read|glob|grep|search/i.test(n.name) ? 'ph ph-file-magnifying-glass' : /plan/i.test(n.name) ? 'ph ph-list-checks' : /patch|edit|write|replace/i.test(n.name) ? 'ph ph-pencil-simple-line' : n.name === 'view_image' ? 'ph ph-image' : shell ? 'ph ph-terminal' : 'ph ph-wrench';
  const wall = n.wall != null ? (n.wall < 1 ? n.wall.toFixed(1) + 's' : dur(n.wall * 1000)) : '';
  const output = n.output || n.detail || (n.status === 'Awaiting result' ? '(awaiting result)' : '(no output)');
  const open = S.tools[tk] != null ? S.tools[tk] : groupOpen;
  const raw = S.raw || !!S.rawItems[tk];
  const full = !!S.full[tk];
  const showCmd = shell;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button className="h-hover" aria-expanded={open} onClick={() => set((s2) => ({ tools: { ...s2.tools, [tk]: !open } }))} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 42, padding: '7px 12px', border: 0, background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer', textAlign: 'left' }}>
        <i className={icon} style={{ color: 'var(--tool)', flex: 'none' }} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span title={n.title} style={{ font: '500 12.5px Inter,sans-serif', ...ellipsis }}>{n.title}</span>
          {!!n.subject && <span title={n.subject} style={{ font: `400 11px ${mono}`, color: 'var(--muted)', ...ellipsis }}>{n.subject}</span>}
        </span>
        {failed && n.exit != null && <ExitBadge exit={n.exit} />}
        <span style={{ font: '400 10.5px Inter,sans-serif', color: failed ? 'var(--fail-text)' : 'var(--faint)' }}>{n.status}</span>
        <span title="Approximate tokens this result adds to the context" style={{ flex: 'none', fontSize: 11, color: n.outTok >= 8000 ? 'var(--fg-3)' : 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>{n.output ? '≈' + K(n.outTok) + ' tok' : ''}</span>
        <span style={{ flex: 'none', minWidth: 30, textAlign: 'right', fontSize: 11, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>{wall}</span>
      </button>
      {open && (
        <div style={{ margin: '0 12px 8px 36px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ToolOpen tk={tk} n={n} S={S} set={set} tog={tog} copy={copy} raw={raw} full={full} showCmd={showCmd} output={output} rawRows={st.raw} />
        </div>
      )}
    </div>
  );
}

const plural = (c: number, a: string, b: string) => c + ' ' + (c === 1 ? a : b);

function ToolOpen({ tk, n, S, set, tog, copy, raw, full, showCmd, output, rawRows }: { tk: string; n: NormTool; S: State; set: SessionViewProps['set']; tog: Tog; copy: SessionViewProps['copy']; raw: boolean; full: boolean; showCmd: boolean; output: string; rawRows: Step['raw'] }) {
  const sx = raw ? null : structOf(n);
  const plain = !sx || !!S.plain[tk];
  const maxH = full ? 'none' : plain ? 360 : 560;
  const fAll = S.filesAll[tk];
  const anyFileOpen = sx ? (fAll != null ? fAll : sx.files <= 3) : false;
  const hasSummary = !plain && !!sx && sx.files > 0 && !(sx.files === 1 && !sx.matches && !sx.isDiff);
  const hasPrefix = !plain && !!sx?.prefix;
  const hasMeta = !!n.trunc || hasSummary || hasPrefix;

  const u = n.usage;
  const facts: { k: string; v: string; tip: string }[] = [];
  if (n.output) facts.push({ k: 'Result', v: '≈' + K(n.outTok) + ' tok · ' + n.outLines.toLocaleString('en-US') + (n.outLines === 1 ? ' line' : ' lines'), tip: 'Size of the output the model reads back (estimated at ~4 characters per token)' });
  if (u) {
    facts.push({ k: 'Request', v: K(u.input) + ' in' + (u.input ? ' · ' + Math.round((u.cached / u.input) * 100) + '% cached' : '') + ' · ' + K(u.output) + ' out' + (u.shared > 1 ? ' · shared by ' + u.shared + ' calls' : ''), tip: 'Tokens for the model request that produced this call (output includes reasoning: ' + K(u.reasoning) + ')' });
    if (u.window) facts.push({ k: 'Context', v: Math.round((u.input / u.window) * 100) + '% of ' + K(u.window), tip: 'How full the context window was when this call was made' });
  }
  if (n.limits) facts.push({ k: 'Limits', v: n.limits, tip: 'Limits the agent set on this call' });

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24 }}>
        <span style={{ flex: 1, minWidth: 0, font: `400 11px ${mono}`, color: 'var(--faint)', ...ellipsis }}>{n.workdir}</span>
        {!raw && (
          <>
            {!!n.script && (
              <button className="h-surface-fg" onClick={() => tog('scripts', tk)} title="The script the agent ran to call this command" style={smallBtn}>
                <i className="ph ph-code" />
                {S.scripts[tk] ? 'Hide script' : 'Script'}
              </button>
            )}
            {!plain && sx && sx.files > 3 && (
              <button
                className="h-surface-fg"
                onClick={() => {
                  const ns = { ...S.files };
                  Object.keys(ns).forEach((k) => {
                    if (k.startsWith(tk + ':f')) delete ns[k];
                  });
                  set({ files: ns, filesAll: { ...S.filesAll, [tk]: !anyFileOpen } });
                }}
                style={smallBtn}
              >
                <i className="ph ph-files" />
                {anyFileOpen ? 'Collapse files' : 'Expand files'}
              </button>
            )}
            {!!sx && (
              <button className="h-surface-fg" onClick={() => tog('plain', tk)} style={smallBtn}>
                <i className={plain ? 'ph ph-list-magnifying-glass' : 'ph ph-text-align-left'} />
                {plain ? 'Structured' : 'Plain text'}
              </button>
            )}
            <button className="h-surface-fg" onClick={() => tog('full', tk)} style={smallBtn}>
              <i className={full ? 'ph ph-arrows-in-simple' : 'ph ph-arrows-out-simple'} />
              {full ? 'Collapse' : 'Full height'}
            </button>
            <button className="h-surface-fg" onClick={() => copy(output, 'Output copied')} style={smallBtn}>
              <i className="ph ph-copy" />
              Copy
            </button>
          </>
        )}
        {!S.raw && (
          <button className="h-surface" onClick={() => tog('rawItems', tk)} style={{ ...smallBtn, border: '1px solid var(--line-2)', color: 'var(--fg-3)' }}>
            <i className={raw ? 'ph ph-article' : 'ph ph-brackets-curly'} />
            {raw ? 'Readable' : 'JSON'}
          </button>
        )}
      </div>
      {!raw && facts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', padding: '0 2px 2px', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {facts.map((f) => (
            <span key={f.k} title={f.tip} style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: 'var(--faint)' }}>{f.k}</span>
              <span style={{ color: 'var(--fg-4)' }}>{f.v}</span>
            </span>
          ))}
        </div>
      )}
      {!raw && !showCmd && n.fields.length > 0 && (
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 6, background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          {n.fields.map((field) => (
            <div key={field.label} style={{ display: 'grid', gridTemplateColumns: '100px minmax(0,1fr)', gap: 10 }}>
              <dt style={{ fontSize: 11.5, color: 'var(--faint)' }}>{field.label}</dt>
              <dd style={{ margin: 0, font: `400 11.5px/1.6 ${mono}`, color: 'var(--fg-3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {field.value.length > 400 ? <details><summary style={{ cursor: 'pointer' }}>{clip(field.value.replace(/\s+/g, ' '), 100)}</summary>{field.value}</details> : field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {raw ? (
        <RawRows rows={rawRows} />
      ) : (
        <div style={{ borderRadius: 6, background: 'var(--code)', boxShadow: '0 0 0 1px var(--line)', overflow: 'hidden' }}>
          {!!S.scripts[tk] && <pre style={{ margin: 0, padding: '10px 12px', maxHeight: 240, overflow: 'auto', borderBottom: '1px solid var(--line)', font: `400 11.5px/1.6 ${mono}`, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.script}</pre>}
          {showCmd && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '10px 12px', borderBottom: '1px solid var(--line)', font: `400 11.5px/1.6 ${mono}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}><span style={{ color: 'var(--faint)', font: '500 11px Inter,sans-serif' }}>Command</span><button style={smallBtn} onClick={() => copy(n.cmd, 'Command copied')}>Copy command</button></div>
              {n.cmdLines.map((cl, k) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr)', gap: 6, paddingLeft: cl.indent }}>
                  <span style={{ color: 'var(--dim)' }}>{cl.op}</span>
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    <ColSegs segs={cl.segs} />
                  </span>
                </div>
              ))}
            </div>
          )}
          {hasMeta && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px', padding: '6px 12px', borderBottom: '1px solid var(--line)', fontSize: 11, color: 'var(--muted)' }}>
              {hasSummary && sx && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className="ph ph-magnifying-glass" />
                  {sx.isDiff ? plural(sx.files, 'file', 'files') + ' changed · +' + sx.add + ' −' + sx.del : plural(sx.files, 'file', 'files') + ' · ' + plural(sx.matches, 'match', 'matches')}
                </span>
              )}
              {hasPrefix && <span style={{ fontFamily: mono, color: 'var(--faint)' }}>in {sx?.prefix}</span>}
              {!!n.trunc && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className="ph ph-scissors" />
                  {'Truncated by the agent · original ' + K(n.trunc.tokens) + ' tokens' + (n.trunc.lines ? ', ' + n.trunc.lines.toLocaleString('en-US') + ' lines' : '')}
                </span>
              )}
            </div>
          )}
          {plain || !sx ? (
            <pre style={{ margin: 0, padding: '10px 12px', maxHeight: maxH, overflow: 'auto', font: `400 11.5px/1.6 ${mono}`, color: 'var(--fg-4)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{output}</pre>
          ) : (
            <div style={{ maxHeight: maxH, overflow: 'auto', padding: '2px 0 6px' }}>
              {sx.blocks.map((b, bi) => (
                <StructBlock key={bi} b={b} k={tk + ':f' + bi} S={S} set={set} tog={tog} defOpen={anyFileOpen} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function StructBlock({ b, k, S, set, tog, defOpen }: { b: SBlock; k: string; S: State; set: SessionViewProps['set']; tog: Tog; defOpen: boolean }) {
  if (b.type === 'section')
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 10px', padding: '12px 12px 6px' }}>
        <span style={{ font: '600 11px Inter,sans-serif', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>{b.label}</span>
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{b.files ? plural(b.files, 'file', 'files') + ' · ' + plural(b.hits, 'match', 'matches') : ''}</span>
      </div>
    );
  if (b.type === 'gap')
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 12px', fontSize: 11, color: 'var(--muted)' }}>
        <span style={{ flex: 1, borderTop: '1px dashed var(--line-2)' }} />
        <i className="ph ph-scissors" />
        <span>{K(b.tokens) + ' tokens cut here · not in the session file'}</span>
        <span style={{ flex: 1, borderTop: '1px dashed var(--line-2)' }} />
      </div>
    );
  if (b.type === 'text') return <pre style={{ margin: 0, padding: '6px 12px', font: `400 11.5px/1.6 ${mono}`, color: 'var(--fg-4)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.text}</pre>;
  const o = S.files[k] != null ? S.files[k] : defOpen;
  const lim0 = b.limit || 30;
  const lim = S.more[k] ? Infinity : lim0;
  const nl = b.lines.length;
  const count = b.patch ? (b.op === 'Delete' ? 'deleted' : (b.op === 'Add' ? 'new · ' : '') + '+' + b.add + ' −' + b.del) : b.hits ? plural(b.hits, 'match', 'matches') : plural(nl, 'line', 'lines');
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button className="h-hover" onClick={() => set((s2) => ({ files: { ...s2.files, [k]: !o } }))} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) auto', alignItems: 'center', gap: 8, width: '100%', minHeight: 28, padding: '3px 12px', border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', font: `400 11.5px ${mono}` }}>
        <i className={o ? 'ph ph-caret-down' : 'ph ph-caret-right'} style={{ fontSize: 10, color: 'var(--faint)' }} />
        <span style={{ minWidth: 0, ...ellipsis }}>
          <span style={{ color: 'var(--faint)' }}>{b.dir}</span>
          <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>{b.base}</span>
        </span>
        <span style={{ font: '400 11px Inter,sans-serif', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </button>
      {o && (
        <div style={{ display: 'flex', flexDirection: 'column', padding: '2px 0 8px' }}>
          {b.lines.slice(0, lim).map((l, li) =>
            l.gap ? (
              <div key={li} style={{ padding: '0 12px 0 14px', font: `400 11.5px/1.3 ${mono}`, color: 'var(--dim)' }}>
                <span style={{ display: 'inline-block', width: 40, textAlign: 'right' }}>⋯</span>
              </div>
            ) : l.hunk ? (
              <div key={li} style={{ margin: '4px 0 2px', padding: '2px 12px 2px 66px', background: 'var(--hover)', font: `400 11px/1.6 ${mono}`, color: 'var(--syn-fn)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.text}</div>
            ) : (
              <div key={li} style={{ display: 'grid', gridTemplateColumns: '40px minmax(0,1fr)', gap: 12, padding: '0 12px 0 14px', background: l.mark === '+' ? 'var(--add-bg)' : l.mark === '-' ? 'var(--del-bg)' : 'transparent', opacity: b.patch || b.viewer || l.match ? 1 : 0.6, font: `400 11.5px/1.6 ${mono}` }}>
                <span style={{ textAlign: 'right', color: l.match ? 'var(--accent-fg)' : 'var(--dim)', userSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>{l.ln}</span>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  <ColSegs segs={l.segs || []} rounded />
                </span>
              </div>
            ),
          )}
          {nl > lim && (
            <button onClick={() => tog('more', k)} style={{ alignSelf: 'flex-start', margin: '4px 0 0 66px', border: 0, background: 'transparent', padding: 0, color: 'var(--accent-fg)', font: '500 11px Inter,sans-serif', cursor: 'pointer' }}>
              {'Show ' + (nl - lim0) + ' more lines'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ColSegs = ({ segs, rounded }: { segs: ColSeg[]; rounded?: boolean }) => (
  <>
    {segs.map((g, k) => (
      <span key={k} style={{ color: g.c, background: g.bg, borderRadius: rounded ? 2 : undefined }}>{g.t}</span>
    ))}
  </>
);

// ---- Overview ----

function Overview({ s, goTurn }: { s: Session; goTurn: (domId: string) => void }) {
  const tk = s.tokens || { input: 0, cached: 0, output: 0, reasoning: 0 };
  const tiles = [
    { label: 'Duration', value: s.agent === 'aider' ? '—' : dur(s.ended - s.started), sub: s.agent === 'aider' ? 'Not recorded in history' : hm(s.started) + ' – ' + hm(s.ended) },
    { label: 'Turns', value: s.turns.length, sub: s.counts.messages + ' replies' },
    { label: 'Commands', value: s.counts.tools, sub: s.counts.failed + ' failed calls' },
    { label: 'Input tokens', value: s.tokens ? K(tk.input) : '—', sub: s.tokens ? (tk.input ? Math.round((tk.cached / tk.input) * 100) : 0) + '% from cache' : 'Not recorded in this session' },
    { label: 'Output tokens', value: s.tokens ? K(tk.output) : '—', sub: s.tokens ? K(tk.reasoning) + ' reasoning' : 'Not recorded in this session' },
  ];
  const mx = Math.max(1, ...s.turns.map((t) => (t.tokens ? t.tokens.output : 0)));
  const cc: Record<string, number> = {};
  const heavy: { n: number; i: number; cmd: string; t: number }[] = [];
  let heavyTotal = 0;
  s.turns.forEach((t, i) => t.steps.forEach((st) => {
    if (st.kind !== 'tool') return;
    const n = normTool(st);
    const b = isShellName(n.name) ? n.base : n.name;
    cc[b] = (cc[b] || 0) + 1;
    heavyTotal += n.outTok;
    if (n.outTok) heavy.push({ n: i + 1, i, cmd: n.title + (n.subject ? ' · ' + n.subject : ''), t: n.outTok });
  }));
  const arr = Object.entries(cc).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const top = arr.length ? arr[0][1] : 1;
  heavy.sort((a, b) => b.t - a.t);
  const heavyTop = heavy.length ? heavy[0].t : 1;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8 }}>
          {tiles.map((tl) => (
            <div key={tl.label} style={{ borderRadius: 8, boxShadow: '0 0 0 1px var(--line)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--faint)' }}>{tl.label}</span>
              <span style={{ fontSize: 20, fontWeight: 500, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{tl.value}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{tl.sub}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>Output tokens per turn</span>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 72 }}>
              {s.tokens ? s.turns.map((t, i) => {
                const o = t.tokens ? Math.max(0, t.tokens.output) : 0;
                return <button key={i} className="h-bar" onClick={() => goTurn(domIdOf(s, i))} title={'Turn ' + (i + 1) + ' · ' + K(o) + ' output tokens'} style={{ flex: 1, minWidth: 2, height: Math.max(3, Math.round((o / mx) * 72)), padding: 0, border: 0, borderRadius: '2px 2px 0 0', background: 'var(--bar)', cursor: 'pointer' }} />;
              }) : <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--faint)' }}>Token usage was not recorded.</span>}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>Most-run commands</span>
            {arr.map(([name, count]) => (
              <div key={name} style={{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr) 28px', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ fontFamily: mono, fontSize: 11.5, color: 'var(--fg-3)', ...ellipsis }}>{name}</span>
                <span style={{ height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: Math.round((count / top) * 100) + '%', background: 'var(--tool)' }} />
                </span>
                <span style={{ color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {heavy.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>Largest tool outputs · ≈{K(heavyTotal)} tok of tool output in this session</span>
          <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 8, boxShadow: '0 0 0 1px var(--line)', overflow: 'hidden' }}>
            {heavy.slice(0, 8).map((hv, k) => (
              <button key={k} className="h-hover" onClick={() => goTurn(domIdOf(s, hv.i))} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) 120px 64px', alignItems: 'center', gap: 10, width: '100%', minHeight: 32, padding: '5px 12px', border: 0, borderBottom: '1px solid var(--line-soft)', background: 'transparent', color: 'var(--fg-3)', textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ fontSize: 11, color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>Turn {hv.n}</span>
                <span style={{ font: `400 12px ${mono}`, ...ellipsis }}>{hv.cmd}</span>
                <span style={{ height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: Math.max(2, Math.round((hv.t / heavyTop) * 100)) + '%', background: 'var(--bar-2)' }} />
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>≈{K(hv.t)}</span>
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>Estimated at ~4 characters per token. Click a row to open that turn.</span>
        </div>
      )}
    </>
  );
}

// ---- Trace ----

function TraceList({ visible, selTurn, onSelect, onOpen }: { visible: { t: Turn; i: number }[]; selTurn: number | null; onSelect: (i: number) => void; onOpen: () => void }) {
  return (
    <div style={{ flex: 1.25, minWidth: 0, overflowY: 'auto', borderRight: '1px solid var(--line)', padding: '12px 0 40px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 14px', padding: '4px 20px 10px', fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
        <Legend w={10} h={6} r={2} color="var(--tool)" label="Command" />
        <Legend w={10} h={6} r={2} color="var(--fail)" label="Failed" />
        <Legend w={3} h={10} r={1} color="var(--faint)" label="Thinking" />
        <Legend w={3} h={10} r={1} color="var(--accent-fg)" label="Reply" />
        <div style={{ flex: 1 }} />
        <span title="Each row is scaled to its own duration">
          <i className="ph ph-info" />
        </span>
        <button className="h-surface" onClick={onOpen} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', border: '1px solid var(--line-2)', borderRadius: 6, background: 'transparent', color: 'var(--fg-3)', font: '500 11px Inter,sans-serif', cursor: 'pointer' }}>
          <i className="ph ph-arrow-square-out" />
          Open in Transcript
        </button>
      </div>
      {visible.map(({ t, i }) => {
        const D = Math.max(1, t.end - t.start);
        const n = t.steps.filter((x) => x.kind === 'tool').length;
        const active = i === selTurn;
        return (
          <button key={i} className="h-hover" onClick={() => onSelect(i)} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '24px minmax(0,1fr) minmax(120px,1.4fr) 48px', alignItems: 'center', gap: 12, width: '100%', padding: '8px 20px', border: 0, background: active ? 'var(--surface)' : 'transparent', color: 'var(--fg)', textAlign: 'left', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            {active && <span style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 2, background: 'var(--accent)' }} />}
            <span style={{ fontSize: 11, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, ...ellipsis }}>{t.prompt.replace(/\s+/g, ' ') || '(no text)'}</span>
              <span style={{ fontSize: 11, color: 'var(--faint)' }}>{hm(t.start)} · {n ? n + ' cmd' : 'reply only'}</span>
            </span>
            <span style={{ position: 'relative', height: 18, borderRadius: 4, background: 'var(--hover)', boxShadow: 'inset 0 0 0 1px var(--line)', overflow: 'hidden' }}>
              {t.steps.map((st, k) => {
                const left = Math.max(0, Math.min(100, ((st.t - t.start) / D) * 100));
                let g: { left: number; width: string; minW: number; top: number; color: string } | null = null;
                if (st.kind === 'tool') g = { left, width: Math.max(0, (((st.done || st.t) - st.t) / D) * 100) + '%', minW: 3, top: 4, color: normTool(st).status === 'Failed' ? 'var(--fail)' : 'var(--tool)' };
                else if (st.kind === 'reasoning' && SHOW_REASONING) g = { left, width: '0', minW: 2, top: 2, color: 'var(--faint)' };
                else if (st.kind === 'message') g = { left: Math.min(left, 99.4), width: '0', minW: 3, top: 1, color: 'var(--accent-fg)' };
                return g ? <span key={k} style={{ position: 'absolute', top: g.top, bottom: g.top, left: g.left + '%', width: g.width, minWidth: g.minW, borderRadius: 2, background: g.color }} /> : null;
              })}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dur(D)}</span>
          </button>
        );
      })}
      {!visible.length && <div style={{ padding: '24px 20px', color: 'var(--faint)', fontSize: 12.5 }}>No turns match.</div>}
    </div>
  );
}

// ---- Small pieces ----

function Markdown({ text, copy }: { text: string; copy: (t: string, m?: string) => void }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 14, lineHeight: 1.65, color: 'var(--fg-2)' }}>
      {blocks.map((b, k) =>
        b.type === 'p' ? (
          <p key={k} style={{ margin: 0, textWrap: 'pretty', wordBreak: 'break-word' } as CSSProperties}>
            <Segs segs={b.segs} />
          </p>
        ) : b.type === 'h' ? (
          <h3 key={k} style={{ margin: '6px 0 0', fontSize: 14.5, fontWeight: 600, color: 'var(--fg-strong)' }}>{b.text}</h3>
        ) : b.type === 'ul' ? (
          <ul key={k} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {b.items.map((li, j) => (
              <li key={j} style={{ paddingLeft: 2, wordBreak: 'break-word' }}>
                <Segs segs={li} />
              </li>
            ))}
          </ul>
        ) : (
          <div key={k} style={{ borderRadius: 8, background: 'var(--code)', boxShadow: '0 0 0 1px var(--line)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', height: 30, padding: '0 6px 0 12px', borderBottom: '1px solid var(--line)', font: `500 11px ${mono}`, color: 'var(--faint)' }}>
              <span>{b.lang}</span>
              <div style={{ flex: 1 }} />
              <button className="h-surface-fg" onClick={() => copy(b.text)} style={{ ...smallBtn, height: 22, padding: '0 7px' }}>
                <i className="ph ph-copy" />
                Copy
              </button>
            </div>
            <pre style={{ margin: 0, padding: '12px 14px', overflowX: 'auto', font: `400 12.5px/1.6 ${mono}`, color: 'var(--fg-3)' }}>
              {codeLines(b.text, b.lang).map((cl, j) => (
                <div key={j} style={{ minHeight: '1.6em' }}>
                  <ColSegs segs={cl.segs} />
                </div>
              ))}
            </pre>
          </div>
        ),
      )}
    </div>
  );
}

function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((g, k) =>
        g.kind === 'bold' ? (
          <strong key={k} style={{ fontWeight: 600, color: 'var(--fg-strong)' }}>{g.t}</strong>
        ) : g.kind === 'code' ? (
          <code key={k} style={{ padding: '1px 5px', borderRadius: 4, background: 'var(--surface)', font: `400 12.5px ${mono}`, color: 'var(--accent-fg-2)' }}>{g.t}</code>
        ) : (
          <span key={k}>{g.t}</span>
        ),
      )}
    </>
  );
}

function RawRows({ rows }: { rows: Step['raw'] }) {
  const list = useMemo(() => rawRowsOf(rows), [rows]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {list.map((rw, k) => (
        <div key={k} style={{ borderRadius: 6, background: 'var(--code)', boxShadow: '0 0 0 1px var(--line)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: 10, padding: '5px 10px', borderBottom: '1px solid var(--line)', font: `500 11px ${mono}`, color: 'var(--faint)' }}>
            <span style={{ color: 'var(--accent-fg)' }}>L{rw.line}</span>
            <span style={{ color: 'var(--fg-3)' }}>{rw.kind}</span>
            <span style={{ marginLeft: 'auto' }}>{rw.time}</span>
          </div>
          <pre style={{ margin: 0, padding: '10px 12px', maxHeight: 420, overflow: 'auto', font: `400 11.5px/1.6 ${mono}`, color: 'var(--fg-4)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{rw.json}</pre>
        </div>
      ))}
    </div>
  );
}

const ExitBadge = ({ exit }: { exit: number }) => (
  <span style={{ flex: 'none', height: 18, padding: '0 6px', display: 'flex', alignItems: 'center', borderRadius: 4, background: 'var(--fail-bg)', color: 'var(--fail-fg)', font: `500 10.5px ${mono}` }}>exit {exit}</span>
);
const Dot = ({ color }: { color: string }) => <span style={{ width: 7, height: 7, borderRadius: 4, background: color }} />;
const Legend = ({ w, h, r, color, label }: { w: number; h: number; r: number; color: string; label: ReactNode }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
    <span style={{ width: w, height: h, borderRadius: r, background: color }} />
    {label}
  </span>
);
const IconBtn = ({ onClick, title, icon }: { onClick: () => void; title: string; icon: string }) => (
  <button className="h-surface" onClick={onClick} title={title} style={iconBtn}>
    <i className={icon} />
  </button>
);

const ellipsis: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const clamp2: CSSProperties = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const eyebrow: CSSProperties = { fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)' };
const iconBtn: CSSProperties = { width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer', fontSize: 14 };
const segBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, padding: '0 9px', border: 0, borderRadius: 6, font: '500 12px Inter,sans-serif', cursor: 'pointer' };
const exportBtn: CSSProperties = { height: '100%', padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--fg-3)', font: '500 12px Inter,sans-serif', cursor: 'pointer' };
const smallBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px', border: 0, borderRadius: 4, background: 'transparent', color: 'var(--muted)', font: '500 11px Inter,sans-serif', cursor: 'pointer' };
const linkBtn: CSSProperties = { alignSelf: 'flex-start', border: 0, background: 'transparent', color: 'var(--accent-fg)', font: '500 12px Inter,sans-serif', cursor: 'pointer', padding: 0 };
