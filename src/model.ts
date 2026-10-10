// Normalized session model shared by every agent adapter (see design handoff README).

export type AgentId = 'codex' | 'claude' | 'gemini' | 'opencode' | 'aider' | 'pi';

/** Original parsed JSON line, plus a non-enumerable 1-based `__line`. */
export type RawRow = Record<string, any> & { __line?: number };

export interface Tokens {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total?: number;
}

export interface CallUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  window: number | null;
  /** Number of tool calls produced by the same request. */
  shared: number;
}

export type Step =
  | { kind: 'message'; t: number; text: string; raw: RawRow[] }
  | { kind: 'reasoning'; t: number; text: string; raw: RawRow[] }
  | {
      kind: 'tool';
      t: number;
      name: string;
      cmd: string;
      detail: string;
      workdir: string;
      /** Parsed call arguments (limits such as max_output_tokens, yield_time_ms live here). */
      args?: Record<string, any>;
      /** Tokens of the model request that produced this call, from the next token_count event. */
      usage?: CallUsage;
      output: string;
      /** Tool failure reported by the agent; distinct from a measured shell exit code. */
      error?: boolean;
      exit: number | null;
      wall: number | null;
      done: number | null;
      raw: RawRow[];
    }
  | { kind: 'compaction'; t: number; text: string; raw: RawRow[] };

export type ToolStep = Extract<Step, { kind: 'tool' }>;

export interface ContextItem {
  label: string;
  text: string;
  raw: RawRow[];
}

export interface Turn {
  id: string;
  turnId?: string;
  start: number;
  end: number;
  aborted: boolean;
  prompt: string;
  promptRows: RawRow[];
  context: ContextItem[];
  steps: Step[];
  tokens: Tokens | null;
  rows: RawRow[];
}

export interface Session {
  id: string;
  agent: AgentId;
  title: string;
  file: string;
  cwd: string;
  repo: string;
  branch: string;
  model: string;
  cli: string;
  provider: string;
  started: number;
  ended: number;
  contextWindow: number | null;
  tokens: Tokens | null;
  counts: { tools: number; reasoning: number; messages: number; failed: number };
  turns: Turn[];
  saved?: boolean;
  libKey?: string;
  /** Absolute path on disk (desktop app); full sessions are re-read from here. */
  path?: string;
  /** List-only placeholder built from a disk summary; `turns` is empty until the file is opened. */
  stub?: boolean;
  /** Turn count from the summary while `stub` is true. */
  turnCount?: number;
}

/** Raw bytes are accepted so files larger than the engine's max string length still parse. */
export type Adapter = (input: string | Uint8Array, fileName: string) => Session | null;
