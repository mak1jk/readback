import { describe, expect, it } from 'vitest';
import type { ToolStep } from '../src/model';
import { normTool, splitCmd } from '../src/lib/tools';

const step = (p: Partial<ToolStep>): ToolStep => ({ kind: 'tool', t: 0, name: 'exec_command', cmd: '', detail: '', workdir: '', output: '', exit: null, wall: null, done: null, raw: [], ...p });

describe('readable commands', () => {
  it('reports failed tools without inventing an exit code', () => {
    const n = normTool(step({ name: 'exec', detail: 'script', output: 'Script failed\nOutput:\nConnection lost' }));
    expect(n.status).toBe('Failed');
    expect(n.exit).toBeNull();
  });
  it('shows shell descriptions and command text from every agent without JSON punctuation', () => {
    const n = normTool(step({ name: 'Bash', args: { command: 'npm test', description: 'Run the regression suite' }, done: 100 }));
    expect(n.cmd).toBe('npm test');
    expect(n.title).toBe('Run the regression suite');
    expect(n.status).toBe('Completed');
  });

  it('renders a file operation as an action with labeled parameters', () => {
    const n = normTool(step({ name: 'Read', args: { file_path: '/demo/src/main.ts', offset: 15, limit: 30 } }));
    expect(n.title).toContain('Read');
    expect(n.subject).toBe('/demo/src/main.ts');
    expect(n.fields).toContainEqual({ label: 'Offset', value: '15' });
    expect(n.status).toBe('Awaiting result');
  });

  it('unwraps JS object literals safely without evaluating scripts', () => {
    const n = normTool(step({ name: 'exec', cmd: 'exec', detail: "const r = await tools.exec_command({cmd: 'rg -n TODO src', workdir: '/demo', max_output_tokens: 5000}); text(r);", output: JSON.stringify({ output: 'src/main.ts:2:TODO', exit_code: 0, wall_time_seconds: 0.4 }) }));
    expect(n.cmd).toBe('rg -n TODO src');
    expect(n.output).toBe('src/main.ts:2:TODO');
    expect(n.exit).toBe(0);
    expect(n.wall).toBe(0.4);
    expect(n.title).toContain('Search');
  });

  it('preserves unknown JSON outputs as readable JSON rather than claiming failure', () => {
    const n = normTool(step({ name: 'custom_tool', args: { project_id: 'demo' }, output: '{"status":"ok","items":[1,2]}' }));
    expect(n.output).toContain('\n');
    expect(n.exit).toBeNull();
  });

  it('keeps shell escapes, substitutions and compound statements intact', () => {
    expect(splitCmd('echo a\\;b; printf "%s" "ok"').map((p) => p.t)).toEqual(['echo a\\;b', 'printf "%s" "ok"']);
    expect(splitCmd('echo $(printf a; printf b) && echo done').map((p) => p.t)).toEqual(['echo $(printf a; printf b)', 'echo done']);
    expect(splitCmd('for f in *.ts; do echo "$f"; done')).toHaveLength(1);
  });
});
