// Host bridge: Tauri commands when running inside the desktop shell, browser fallbacks otherwise.
import type { AgentId } from './model';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** A session file to import, regardless of where it came from (picker, drop, disk scan). */
export interface SourceFile {
  name: string;
  size: number;
  path?: string;
  text: () => Promise<string | Uint8Array>;
}

// ---- Library: manually imported files (IndexedDB `session-explorer` / `files`, key = name:size) ----

export interface LibRecord {
  key: string;
  agent: AgentId;
  name: string;
  text: string;
  added: number;
  path?: string;
}

let dbp: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('session-explorer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

export async function libraryLoad(): Promise<LibRecord[]> {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction('files').objectStore('files').getAll();
      q.onsuccess = () => res((q.result || []) as LibRecord[]);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return [];
  }
}

export async function librarySave(rec: LibRecord) {
  try {
    (await idb()).transaction('files', 'readwrite').objectStore('files').put(rec);
  } catch {
    /* storage unavailable: session stays in memory only */
  }
}

export async function libraryDelete(key: string) {
  try {
    (await idb()).transaction('files', 'readwrite').objectStore('files').delete(key);
  } catch {
    /* ignore */
  }
}

// ---- Scanned files the user removed from the library (kept on disk, hidden from the list) ----

const HIDDEN_KEY = 'session-explorer-hidden';
export function hiddenPaths(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
export function hidePath(path: string) {
  const h = hiddenPaths();
  h.add(path);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h]));
  } catch {
    /* ignore */
  }
}

// ---- Tauri bridge ----

export interface FileInfo {
  /** Watcher owner; never infer an agent from a shared extension. */
  agent?: AgentId;
  path: string;
  name: string;
  size: number;
  mtime: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

export interface Summary {
  id: string;
  title: string;
  cwd: string;
  repo: string;
  branch: string;
  model: string;
  cli: string;
  started: string | null;
  ended: string | null;
  turns: number;
  tokens: { input: number; cached: number; output: number; reasoning: number } | null;
}
export type ScanItem = FileInfo & { summary: Summary | null };

/** Whole file as raw bytes: skips JSON encoding over IPC and the engine's max string length. */
export const readSession = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>('read_session', { path }));

export const fileFromInfo = (f: FileInfo): SourceFile => ({ name: f.name, size: f.size, path: f.path, text: () => readSession(f.path) });

/** Session files under `dir` (`~` allowed) with list summaries, newest first. Missing folder → []. */
export const scanFolder = (agent: string, dir: string, exts: string[]) => invoke<ScanItem[]>('scan_agent', { agent, path: dir, exts });

export const summarizeFiles = (agent: string, paths: string[]) => invoke<ScanItem[]>('summarize_files', { agent, paths });

export const watchFolder = (agent: AgentId, dir: string, exts: string[]) => invoke<void>('watch_folder', { agent, path: dir, exts });

export async function onSessionFileChanged(cb: (f: FileInfo) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<FileInfo>('session-file-changed', (e) => cb(e.payload));
}

export async function onMenu(cb: (id: string) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('menu', (e) => cb(e.payload));
}

export async function pickFiles(exts: string[] = ['jsonl', 'json', 'md']): Promise<SourceFile[]> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const sel = await open({ multiple: true, filters: [{ name: 'Sessions', extensions: [...exts, 'txt'] }] });
  if (!sel) return [];
  const paths = Array.isArray(sel) ? sel : [sel];
  const infos = await invoke<FileInfo[]>('stat_files', { paths });
  return infos.map(fileFromInfo);
}

export async function pickFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const dir = await open({ directory: true });
  return !dir || Array.isArray(dir) ? null : dir;
}

// ---- Extra session folders added through "Open sessions folder" (desktop) ----

const FOLDERS_KEY = 'session-explorer-folders';
export function extraFolders(): { agent: AgentId; path: string }[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]');
  } catch {
    return [];
  }
}
export function addFolder(agent: AgentId, path: string) {
  const list = extraFolders().filter((f) => !(f.agent === agent && f.path === path));
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(list.concat({ agent, path })));
  } catch {
    /* ignore */
  }
}

/** Save text through a native dialog (Tauri) or a download link (browser). Returns false if cancelled. */
export async function saveText(fileName: string, text: string): Promise<boolean> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: fileName, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return false;
    await invoke('write_text_file', { path, contents: text });
    return true;
  }
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// ---- Browser helpers ----

export const fromFileList = (files: FileList | File[] | null | undefined): SourceFile[] =>
  Array.from(files || []).map((f) => ({ name: f.name, size: f.size, text: () => f.text() }));

/** Collect files from a drop, walking into dropped folders. */
export async function fromDataTransfer(dt: DataTransfer): Promise<SourceFile[]> {
  const entries = Array.from(dt.items || [])
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return fromFileList(dt.files);
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const e of entries) await walk(e);
  return fromFileList(out);
}
