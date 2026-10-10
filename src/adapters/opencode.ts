import type { Adapter } from '../model';
import { decode, SessionBuilder, time } from './shared';

/** An `opencode export` document, not a storage metadata fragment or credentials file. */
export const parseOpenCode: Adapter = (input, file) => {
  let data;
  try { data = JSON.parse(decode(input)); } catch { return null; }
  if (!data?.info?.id || !Array.isArray(data.messages)) return null;
  const b = new SessionBuilder('opencode', file);
  const meta = data.info;
  Object.assign(b.session, { id: meta.id, cwd: meta.directory || '', title: meta.title || '', cli: meta.version || '', started: time(meta.time?.created), ended: time(meta.time?.updated) });
  for (const r of data.messages) {
    const info = r.info || {};
    const t = time(info.time?.created, b.session.ended);
    const parts = Array.isArray(r.parts) ? r.parts : [];
    if (info.role === 'user') b.prompt(parts.filter((p: any) => p.type === 'text' || p.type === 'file').map((p: any) => p.text || `[Attachment: ${p.filename || 'file'}]`).join('\n'), t, [r]);
    else if (info.role === 'assistant') {
      b.session.model = info.modelID || b.session.model;
      b.session.provider = info.providerID || b.session.provider;
      for (const p of parts) {
        if (p.type === 'text') b.step('message', p.text || '', time(p.time?.start, t), r);
        else if (p.type === 'reasoning') b.step('reasoning', p.text || '', time(p.time?.start, t), r);
        else if (p.type === 'tool') {
          const state = p.state || {};
          const st = b.tool(p.callID || p.id, p.tool, state.input, time(state.time?.start, t), r);
          if (state.status === 'completed' || state.status === 'error') {
            b.result(p.callID || p.id, state.output ?? state.error ?? '', time(state.time?.end, t), r, state.status === 'error', state.metadata?.exit ?? state.metadata?.exitCode);
            if (state.time?.end && state.time?.start) st.wall = Math.max(0, state.time.end - state.time.start) / 1000;
          }
        }
      }
      if (info.tokens) {
        const u = info.tokens;
        b.usage(info.id, { input: (u.input || 0) + (u.cache?.read || 0) + (u.cache?.write || 0), cached: u.cache?.read || 0, output: u.output || 0, reasoning: u.reasoning || 0 });
      }
      if (info.error) b.step('message', info.error.data?.message || info.error.name || 'Agent error', t, r);
    }
  }
  return b.finish();
};
