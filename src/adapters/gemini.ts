import type { Adapter, RawRow } from '../model';
import { decode, jsonRows, SessionBuilder, textOf, time } from './shared';

/** Old JSON snapshots and current append-only JSONL ($set/$patch/$rewindTo). */
export function geminiRecord(input: string | Uint8Array): RawRow | null {
  try {
    const obj = JSON.parse(decode(input));
    if (obj?.sessionId && Array.isArray(obj.messages)) return obj;
  } catch { /* JSONL */ }
  const rows = jsonRows(input);
  if (!rows.some((r) => r.sessionId || r.$set?.sessionId)) return null;
  const record: RawRow = { messages: [] };
  for (const r of rows) {
    if (r.sessionId || r.$set) {
      Object.assign(record, r.$set || r);
      if (!Array.isArray(record.messages)) record.messages = [];
    } else if (r.$rewindTo) {
      const i = record.messages.findIndex((m: any) => m.id === r.$rewindTo);
      record.messages = i >= 0 ? record.messages.slice(0, i) : [];
    } else if (r.$patch) {
      const patch = r.$patch;
      for (const update of [patch, ...(patch.updates || [])]) {
        const m = record.messages.find((m: any) => m.id === update.id);
        if (!m) continue;
        if (update.content !== undefined) m.content = update.content;
        for (const call of update.toolCalls || []) {
          const c = m.toolCalls?.find((c: any) => c.id === call.id);
          if (c) Object.assign(c, call);
        }
      }
      if (patch.removeIds) record.messages = record.messages.filter((m: any) => !patch.removeIds.includes(m.id));
      if (patch.orderIds) {
        const index = new Map(record.messages.map((m: any) => [m.id, m]));
        record.messages = record.messages.filter((m: any) => !patch.orderIds.includes(m.id)).concat(patch.orderIds.map((id: string) => index.get(id)).filter(Boolean));
      }
    } else if (r.id && r.type) {
      const i = record.messages.findIndex((m: any) => m.id === r.id);
      if (i >= 0) record.messages[i] = r;
      else record.messages.push(r);
    }
  }
  return record;
}
export const parseGemini: Adapter = (input, file) => {
  const record = geminiRecord(input);
  if (!record) return null;
  const b = new SessionBuilder('gemini', file);
  Object.assign(b.session, { id: record.sessionId || file, cwd: record.directories?.[0] || '', started: time(record.startTime), ended: time(record.lastUpdated) });
  for (const r of record.messages) {
    const t = time(r.timestamp, b.session.ended);
    if (r.type === 'user') b.prompt(textOf(r.content), t, [r]);
    else if (r.type === 'gemini') {
      if (r.model) b.session.model = r.model;
      for (const thought of r.thoughts || []) b.step('reasoning', [thought.subject, thought.description].filter(Boolean).join('\n'), time(thought.timestamp, t), r);
      for (const c of r.toolCalls || []) {
        const st = b.tool(c.id, c.name, c.args, time(c.timestamp, t), r);
        if (c.result != null || c.status === 'error') b.result(c.id, c.result ?? c.resultDisplay ?? 'Tool failed', t, r, c.status === 'error' ? true : c.status === 'success' ? false : undefined);
        if (c.description && !st.args?.description) st.args = { ...st.args, description: c.description };
      }
      b.step('message', textOf(r.content), t, r);
      if (r.tokens) b.usage(r.id, { input: r.tokens.input || 0, cached: r.tokens.cached || 0, output: r.tokens.output || 0, reasoning: r.tokens.thoughts || 0 });
    } else if (r.type === 'error' || r.type === 'warning') b.step('message', textOf(r.content), t, r);
  }
  return b.finish();
};
