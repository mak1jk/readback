import { describe, expect, it } from 'vitest';
import { AGENTS } from '../src/lib/agents';
import type { AgentId, ToolStep } from '../src/model';
import { readFileSync } from 'node:fs';

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const at = (s: number) => `2026-10-10T10:00:${String(s).padStart(2, '0')}.000Z`;
const parse = (id: AgentId, input: unknown, ext = 'json') => AGENTS.find((a) => a.id === id)?.parse?.(typeof input === 'string' ? input : JSON.stringify(input), `sample.${ext}`);
const tool = (s: ReturnType<typeof parse>) => s?.turns[0].steps.find((x) => x.kind === 'tool') as ToolStep;

describe('agent transcripts', () => {
  it.each([
    ['claude', 'claude-session-sample.jsonl'], ['pi', 'pi-session-sample.jsonl'],
    ['gemini', 'gemini-session-sample.json'], ['opencode', 'opencode-export-sample.json'],
    ['aider', 'aider-history-sample.md'],
  ] as const)('imports the bundled %s example as UTF-8 bytes', (id, file) => {
    const s = AGENTS.find((a) => a.id === id)?.parse?.(readFileSync(new URL('../fixtures/' + file, import.meta.url)), file);
    expect(s?.agent).toBe(id);
    expect(s?.turns.length).toBeGreaterThan(0);
  });
  it('Claude keeps tool results in the requesting turn and deduplicates streamed usage', () => {
    const usage = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 10 };
    const s = parse('claude', jsonl([
      { type: 'user', sessionId: 'c1', cwd: '/demo', timestamp: at(0), message: { role: 'user', content: 'Check the build' } },
      { type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-test', usage, content: [{ type: 'thinking', thinking: 'Inspect first' }] } },
      { type: 'assistant', timestamp: at(2), message: { id: 'm1', model: 'claude-test', usage, content: [{ type: 'tool_use', id: 'call1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } },
      { type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'Tests failed', is_error: true }] } },
      { type: 'assistant', timestamp: at(4), message: { id: 'm2', content: [{ type: 'text', text: 'One test needs fixing.' }] } },
    ]), 'jsonl');
    expect(s?.turns).toHaveLength(1);
    expect(tool(s)).toMatchObject({ name: 'Bash', cmd: 'npm test', output: 'Tests failed', error: true, exit: null, done: Date.parse(at(3)) });
    expect(s?.tokens).toMatchObject({ input: 30, cached: 10, output: 5 });
    expect(s?.counts).toMatchObject({ tools: 1, failed: 1, reasoning: 1, messages: 1 });
  });

  it('Gemini reads text parts, thoughts and completed tool calls in JSON sessions', () => {
    const s = parse('gemini', { sessionId: 'g1', startTime: at(0), lastUpdated: at(5), messages: [
      { id: 'u', type: 'user', timestamp: at(0), content: [{ text: 'Read the config' }] },
      { id: 'a', type: 'gemini', timestamp: at(1), model: 'gemini-test', content: 'The config is valid.', thoughts: [{ subject: 'Review', description: 'Read the file', timestamp: at(1) }], tokens: { input: 40, output: 6, cached: 20, thoughts: 2 }, toolCalls: [{ id: 't', name: 'read_file', args: { file_path: '/demo/config.ts' }, timestamp: at(2), status: 'success', result: [{ functionResponse: { response: { output: 'export default {};' } } }] }] },
    ] });
    expect(s?.turns[0].prompt).toBe('Read the config');
    expect(tool(s).output).toBe('export default {};');
    expect(s?.turns[0].steps.map((x) => x.kind)).toEqual(['reasoning', 'tool', 'message']);
    expect(s?.tokens?.reasoning).toBe(2);
  });

  it('Gemini JSONL patches and rewinds replace messages rather than duplicating them', () => {
    const s = parse('gemini', jsonl([
      { sessionId: 'g2', startTime: at(0) },
      { id: 'u', type: 'user', timestamp: at(0), content: 'Test' },
      { id: 'a', type: 'gemini', timestamp: at(1), content: 'Partial', toolCalls: [{ id: 'c', name: 'run_shell_command', args: { command: 'npm test' }, status: 'running' }] },
      { $patch: { id: 'a', content: 'Complete', toolCalls: [{ id: 'c', result: 'Passed' }] } },
      { id: 'discard', type: 'user', timestamp: at(3), content: 'Discard this' },
      { $rewindTo: 'discard' },
    ]), 'jsonl');
    expect(s?.turns).toHaveLength(1);
    expect(s?.turns[0].steps.some((x) => x.kind === 'message' && x.text === 'Complete')).toBe(true);
    expect(tool(s).output).toBe('Passed');
  });

  it('Pi selects the latest parent chain, and pairs toolResult by toolCallId', () => {
    const s = parse('pi', jsonl([
      { type: 'session', version: 3, id: 'p1', timestamp: at(0), cwd: '/demo' },
      { type: 'message', id: 'u1', parentId: null, timestamp: at(1), message: { role: 'user', content: 'Abandoned branch' } },
      { type: 'message', id: 'u2', parentId: null, timestamp: at(2), message: { role: 'user', content: 'Run tests' } },
      { type: 'message', id: 'a', parentId: 'u2', timestamp: at(3), message: { role: 'assistant', model: 'pi-test', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'npm test' } }] } },
      { type: 'message', id: 'r', parentId: 'a', timestamp: at(4), message: { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'Passed' }], isError: false } },
    ]), 'jsonl');
    expect(s?.turns).toHaveLength(1);
    expect(s?.turns[0].prompt).toBe('Run tests');
    expect(tool(s)).toMatchObject({ output: 'Passed', error: false, exit: null });
  });

  it('OpenCode imports exported messages with readable tools, errors and usage', () => {
    const s = parse('opencode', { info: { id: 'o1', title: 'Build check', directory: '/demo', time: { created: Date.parse(at(0)), updated: Date.parse(at(5)) } }, messages: [
      { info: { id: 'u', role: 'user', time: { created: Date.parse(at(0)) } }, parts: [{ type: 'text', text: 'Check the build' }] },
      { info: { id: 'a', role: 'assistant', modelID: 'open-test', tokens: { input: 25, output: 6, reasoning: 2, cache: { read: 10 } }, time: { created: Date.parse(at(1)) } }, parts: [{ type: 'tool', tool: 'bash', callID: 'c', state: { status: 'error', input: { command: 'npm test' }, error: 'Build failed', time: { start: Date.parse(at(2)), end: Date.parse(at(3)) } } }, { type: 'text', text: 'The build failed.' }] },
    ] });
    expect(s?.title).toBe('Build check');
    expect(tool(s)).toMatchObject({ cmd: 'npm test', output: 'Build failed', error: true, exit: null });
    expect(s?.tokens?.input).toBe(35);
  });

  it('Aider parses multiline prompts, preserving fenced Markdown headings in replies', () => {
    const s = parse('aider', '# aider chat started at 2026-10-10 10:00:00\n\n#### Fix this  \n#### and test it\n\nHere is the change:\n```md\n#### A heading in a file\n```\n\n#### Thanks\n\nDone.\n', 'md');
    expect(s?.turns).toHaveLength(2);
    expect(s?.turns[0].prompt).toBe('Fix this\nand test it');
    expect(s?.turns[0].steps[0]).toMatchObject({ kind: 'message', text: 'Here is the change:\n```md\n#### A heading in a file\n```' });
    expect(s?.tokens).toBeNull();
  });

  it('Gemini partial ordering retains preceding messages and accepts $set metadata', () => {
    const s = parse('gemini', jsonl([
      { $set: { sessionId: 'g3', startTime: at(0) } },
      { id: 'u', type: 'user', timestamp: at(0), content: 'Keep the prompt' },
      { id: 'a', type: 'gemini', timestamp: at(1), content: 'First' },
      { id: 'b', type: 'gemini', timestamp: at(2), content: 'Second' },
      { $patch: { orderIds: ['b', 'a'] } },
    ]), 'jsonl');
    expect(s?.turns[0].prompt).toBe('Keep the prompt');
    expect(s?.turns[0].steps.map((x) => 'text' in x ? x.text : '')).toEqual(['Second', 'First']);
  });

  it('Gemini rewind to an unavailable message clears the previous history', () => {
    const s = parse('gemini', jsonl([
      { sessionId: 'g4' }, { id: 'u', type: 'user', content: 'Removed' }, { $rewindTo: 'unknown' },
    ]), 'jsonl');
    expect(s).toBeNull();
  });

  it.each(['claude', 'gemini', 'pi', 'opencode', 'aider'] as AgentId[])('%s rejects unrelated files', (id) => {
    expect(parse(id, '{"hello":"world"}')).toBeNull();
  });
});
