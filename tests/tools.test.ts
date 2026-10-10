import { describe, expect, it } from 'vitest';
import type { ToolStep } from '../src/model';
import { codeLines } from '../src/lib/highlight';
import { normTool, splitCmd, structOf } from '../src/lib/tools';

const step = (p: Partial<ToolStep>): ToolStep => ({ kind: 'tool', t: 0, name: 'shell_command', cmd: '', detail: '', workdir: '', output: '', exit: null, wall: null, done: null, raw: [], ...p });

describe('splitCmd', () => {
  it('splits on operators outside quotes and labels echo dividers', () => {
    const parts = splitCmd("printf '%s\\n' '--- symbols ---' && rg -n 'a|b' src | head -n 5");
    expect(parts.map((p) => p.prev)).toEqual(['', '&&', '|']);
    expect(parts[0].label).toBe('symbols');
    expect(parts[1].t).toBe("rg -n 'a|b' src");
  });
});

describe('normTool', () => {
  it('unwraps a code-mode script call and its output envelope', () => {
    const script = 'const r = await tools.exec_command({"cmd":"rg -n foo src &amp;&amp; echo ok","workdir":"/repo","max_output_tokens":60000});';
    const output = JSON.stringify([{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: 'Warning: truncated output (original token count: 5000)\nTotal output lines: 20\n\nsrc/a.py:3:foo()\n' }]);
    const n = normTool(step({ name: 'js', cmd: 'js', detail: script, output }));
    expect(n.name).toBe('shell_command');
    expect(n.cmd).toBe('rg -n foo src && echo ok');
    expect(n.workdir).toBe('/repo');
    expect(n.script).toContain('tools.exec_command');
    expect(n.wall).toBe(0.2);
    expect(n.trunc).toEqual({ tokens: 5000, lines: 20 });
    expect(n.output).toBe('src/a.py:3:foo()\n');
    expect(n.limits).toBe('max 60.0k tok');
    expect(n.base).toBe('rg');
  });
});

describe('structOf', () => {
  it('groups grep hits per file with section labels and highlights the pattern', () => {
    const out = '--- part ---\nsrc/x/a.py:3:def foo():\nsrc/x/a.py-4-    pass\n--\nsrc/x/a.py:9:foo()\nsrc/x/b.py:1:import foo';
    const sx = structOf(normTool(step({ cmd: "rg -n -C 1 'foo' src", output: out })))!;
    expect(sx.files).toBe(2);
    expect(sx.matches).toBe(3);
    expect(sx.prefix).toBe('src/x/');
    const a = sx.blocks.find((b) => b.type === 'file')!;
    if (a.type !== 'file') throw new Error();
    expect(a.lines.some((l) => l.gap)).toBe(true);
    expect(a.lines[0].segs!.some((g) => g.t === 'foo' && g.bg === 'var(--sel)')).toBe(true);
  });

  it('parses apply_patch envelopes into +/- file blocks', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 2;\n ctx\n*** Add File: src/b.ts\n+export {};\n*** End Patch';
    const sx = structOf(normTool(step({ name: 'apply_patch', cmd: 'apply_patch', detail: patch, output: 'Done!' })))!;
    expect(sx.isDiff).toBe(true);
    expect(sx.files).toBe(2);
    expect([sx.add, sx.del]).toEqual([2, 1]);
  });

  it('returns null for plain output', () => {
    expect(structOf(normTool(step({ cmd: 'ls', output: 'a\nb\n' })))).toBeNull();
  });
});

describe('codeLines', () => {
  it('colors keywords, strings and comments', () => {
    const [l] = codeLines('const x = "hi"; // note', 'ts');
    expect(l.segs.find((g) => g.t === 'const')?.c).toBe('var(--syn-kw)');
    expect(l.segs.find((g) => g.t === '"hi"')?.c).toBe('var(--syn-str)');
    expect(l.segs[l.segs.length - 1].c).toBe('var(--faint)');
  });
});
