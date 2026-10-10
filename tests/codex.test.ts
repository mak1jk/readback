import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCodexJsonl } from '../src/adapters/codex';
import { parseBlocks } from '../src/lib/format';
import { sessionMarkdown } from '../src/lib/export';

const sample = readFileSync(new URL('../fixtures/codex-rollout-sample.jsonl', import.meta.url), 'utf8');

describe('parseCodexJsonl', () => {
  const s = parseCodexJsonl(sample, 'rollout-sample.jsonl')!;

  it('reads session metadata', () => {
    expect(s.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(s.cwd).toBe('/home/user/dev/example-project');
    expect(s.repo).toBe('example-org/example-project');
    expect(s.branch).toBe('main');
    expect(s.cli).toBe('0.1.0');
    expect(s.model).toBe('example-model-1');
    expect(s.started).toBeLessThanOrEqual(s.ended);
  });

  it('splits turns and moves injected context out of the prompt', () => {
    expect(s.turns.length).toBeGreaterThan(0);
    const first = s.turns[0];
    expect(first.prompt.startsWith('# AGENTS.md')).toBe(false);
    expect(first.context.map((c) => c.label)).toContain('AGENTS.md');
    expect(s.title).toBe(first.prompt.trim().split('\n')[0].slice(0, 120));
  });

  it('pairs tool calls with their outputs', () => {
    const tools = s.turns.flatMap((t) => t.steps).filter((x) => x.kind === 'tool');
    expect(tools.length).toBe(s.counts.tools);
    expect(tools.some((x) => x.kind === 'tool' && x.done != null && x.output !== '')).toBe(true);
  });

  it('computes per-turn token deltas that sum to the session total', () => {
    expect(s.tokens).not.toBeNull();
    const out = s.turns.reduce((a, t) => a + (t.tokens?.output || 0), 0);
    expect(out).toBe(s.tokens!.output);
  });

  it('keeps 1-based source line numbers on raw rows', () => {
    const lines = s.turns.flatMap((t) => t.rows).map((r) => r.__line!);
    expect(Math.min(...lines)).toBeGreaterThanOrEqual(1);
    expect(Object.keys(s.turns[0].rows[0])).not.toContain('__line');
  });

  it('returns null for non-session text', () => {
    expect(parseCodexJsonl('hello\nworld', 'x.txt')).toBeNull();
  });

  it('exports Markdown with one section per turn', () => {
    const md = sessionMarkdown(s);
    expect(md.startsWith('# ' + s.title)).toBe(true);
    expect(md.match(/^## Turn \d+$/gm)?.length).toBe(s.turns.length);
  });
});

describe('parseBlocks', () => {
  it('handles headings, lists, fenced code and tables', () => {
    const b = parseBlocks('## Title\n\nText with **bold** and `code`.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |');
    expect(b.map((x) => x.type)).toEqual(['h', 'p', 'ul', 'code', 'code']);
    expect(b[3]).toMatchObject({ lang: 'ts', text: 'const x = 1;' });
    expect(b[4]).toMatchObject({ lang: 'table' });
  });
});

describe('per-call usage', () => {
  it('attaches last_token_usage of the producing request to tool calls', () => {
    const s = parseCodexJsonl(sample, 'rollout-sample.jsonl')!;
    const tools = s.turns.flatMap((t) => t.steps).filter((x) => x.kind === 'tool');
    expect(tools.some((x) => x.kind === 'tool' && x.usage && x.usage.input > 0)).toBe(true);
  });
});
