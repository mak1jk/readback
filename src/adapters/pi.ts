import type { Adapter, RawRow } from '../model';
import { jsonRows, SessionBuilder, textOf, time } from './shared';

export const parsePiJsonl: Adapter = (input, file) => {
  const rows = jsonRows(input);
  const header = rows.find((r) => r.type === 'session');
  if (!header) return null;
  const b = new SessionBuilder('pi', file);
  Object.assign(b.session, { id: header.id || file, cwd: header.cwd || '', started: time(header.timestamp) });
  const entries = rows.filter((r) => r.type !== 'session');
  // Pi appends alternate branches to the same file. Only the latest leaf's ancestry is active.
  let active = entries;
  if (entries.some((r) => 'parentId' in r)) {
    const index = new Map(entries.map((r) => [r.id, r]));
    const chain: RawRow[] = [];
    const seen = new Set<string>();
    let r: RawRow | undefined = entries[entries.length - 1];
    while (r && !seen.has(r.id)) {
      seen.add(r.id);
      chain.push(r);
      r = r.parentId ? index.get(r.parentId) : undefined;
    }
    active = chain.reverse();
  }
  for (const r of active) {
    const m = r.message || {};
    const t = time(r.timestamp || m.timestamp, b.session.ended);
    if (r.type === 'model_change') Object.assign(b.session, { model: r.modelId || '', provider: r.provider || '' });
    if (r.type === 'session_info' && r.name) b.session.title = r.name;
    if (r.type === 'compaction' || r.type === 'branch_summary') b.step('compaction', r.summary || 'Context compacted', t, r);
    if (r.type === 'custom_message' && r.display) b.step('message', textOf(r.content), t, r);
    if (r.type !== 'message') continue;
    if (m.role === 'user') b.prompt(textOf(m.content), t, [r]);
    else if (m.role === 'assistant') {
      if (m.model) b.session.model = m.model;
      if (m.provider) b.session.provider = m.provider;
      for (const p of Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) {
        if (p.type === 'toolCall') b.tool(p.id, p.name, p.arguments, t, r);
        else if (p.type === 'thinking') b.step('reasoning', p.thinking || '', t, r);
        else if (p.type === 'text') b.step('message', p.text || '', t, r);
      }
      if (m.stopReason === 'aborted' && b.turn) b.turn.aborted = true;
      if (m.errorMessage) b.step('message', m.errorMessage, t, r);
      if (m.usage) b.usage(r.id || String(r.__line), { input: (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0), cached: m.usage.cacheRead || 0, output: m.usage.output || 0, reasoning: m.usage.reasoning || 0 });
    } else if (m.role === 'toolResult') b.result(m.toolCallId, m.content, t, r, m.isError, m.details?.exitCode);
    else if (m.role === 'bashExecution') {
      const st = b.tool(r.id || String(r.__line), 'bash', { command: m.command }, t, r);
      b.result(r.id || String(r.__line), m.output, t, r, m.cancelled || (m.exitCode != null && m.exitCode !== 0), m.exitCode);
      if (m.cancelled && b.turn) b.turn.aborted = true;
      st.detail = m.truncated ? 'Output truncated by Pi' : '';
    }
  }
  return b.finish();
};
