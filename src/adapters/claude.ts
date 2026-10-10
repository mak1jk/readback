import type { Adapter } from '../model';
import { jsonRows, SessionBuilder, textOf, time } from './shared';

export const parseClaudeJsonl: Adapter = (input, file) => {
  const rows = jsonRows(input);
  if (!rows.some((r) => (r.type === 'user' || r.type === 'assistant') && r.message)) return null;
  const b = new SessionBuilder('claude', file);
  const seen = new Set<string>();
  for (const r of rows) {
    const t = time(r.timestamp, b.session.ended);
    if (r.sessionId) b.session.id = r.sessionId;
    if (r.cwd) b.session.cwd = r.cwd;
    if (r.gitBranch) b.session.branch = r.gitBranch;
    if (r.version) b.session.cli = r.version;
    if (r.type === 'ai-title' && r.aiTitle) b.session.title = r.aiTitle;
    if (r.type === 'system' && r.subtype === 'compact_boundary') b.step('compaction', 'Context compacted', t, r);
    const m = r.message;
    if (!m || !['user', 'assistant'].includes(r.type)) continue;
    if (r.uuid && seen.has(r.uuid)) continue;
    if (r.uuid) seen.add(r.uuid);
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: textOf(m.content) }];
    if (r.type === 'user') {
      const user = blocks.filter((p: any) => p.type !== 'tool_result');
      const text = textOf(user);
      if (text) {
        if (r.isMeta && b.turn) b.turn.context.push({ label: 'Session context', text, raw: [r] });
        else b.prompt(text, t, [r]);
      }
      for (const p of blocks) if (p.type === 'tool_result') {
        const result = r.toolUseResult;
        b.result(p.tool_use_id, p.content, t, r, p.is_error === true ? true : p.is_error === false ? false : undefined, result?.exitCode ?? result?.exit_code);
      }
    } else {
      if (m.model) b.session.model = m.model;
      for (const p of blocks) {
        if (p.type === 'tool_use') b.tool(p.id, p.name, p.input, t, r);
        else if (p.type === 'thinking') b.step('reasoning', p.thinking || '', t, r);
        else if (p.type === 'text') b.step('message', p.text || '', t, r);
      }
      if (m.usage) {
        const u = m.usage;
        b.usage(m.id || r.uuid || String(r.__line), { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, reasoning: 0 });
      }
    }
  }
  return b.finish();
};
