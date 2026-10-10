import type { Adapter, AgentId } from '../model';
import { parseCodexJsonl } from '../adapters/codex';
import { parseClaudeJsonl } from '../adapters/claude';
import { parseGemini } from '../adapters/gemini';
import { parsePiJsonl } from '../adapters/pi';
import { parseOpenCode } from '../adapters/opencode';
import { parseAider } from '../adapters/aider';

export interface AgentDef {
  id: AgentId;
  name: string;
  /** Default sessions folder; `~` expands to the home directory on the Rust side. */
  path: string;
  hue: number;
  /** File extensions the scanner picks up inside `path`. */
  exts: string[];
  /** Human guidance for agent-specific import and discovery. */
  hint?: string;
  /** False for formats requiring explicit exports or a project folder. */
  autoScan?: boolean;
  parse: Adapter | null;
}

// Verify each path against current docs of each tool before enabling its adapter.
export const AGENTS: AgentDef[] = [
  { id: 'codex', name: 'Codex', path: '~/.codex/sessions', hue: 285, exts: ['jsonl'], parse: parseCodexJsonl },
  { id: 'claude', name: 'Claude Code', path: '~/.claude/projects', hue: 45, exts: ['jsonl'], parse: parseClaudeJsonl },
  { id: 'gemini', name: 'Gemini CLI', path: '~/.gemini/tmp', hue: 235, exts: ['json', 'jsonl'], parse: parseGemini },
  { id: 'opencode', name: 'OpenCode', path: 'OpenCode session exports (.json)', hue: 150, exts: ['json'], parse: parseOpenCode, autoScan: false, hint: 'Import a JSON session exported by OpenCode, or open a folder containing exports.' },
  { id: 'aider', name: 'Aider', path: '<repo>/.aider.chat.history.md', hue: 335, exts: ['md'], parse: parseAider, autoScan: false, hint: 'Import .aider.chat.history.md or open the project folder containing it. This history does not record token usage or structured tool calls.' },
  { id: 'pi', name: 'Pi', path: '~/.pi/agent/sessions', hue: 95, exts: ['jsonl'], parse: parsePiJsonl },
];

export const agentOf = (id: string): AgentDef => AGENTS.find((a) => a.id === id) || AGENTS[0];
export const agentDot = (a: AgentDef) => 'oklch(0.72 0.11 ' + a.hue + ')';
export const isSupported = (a: AgentDef) => !!a.parse;
