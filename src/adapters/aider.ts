import type { Adapter, RawRow } from '../model';
import { decode, SessionBuilder, time } from './shared';

export const parseAider: Adapter = (input, file) => {
  const source = decode(input).replace(/\r\n/g, '\n');
  if (!/^# aider chat started at /m.test(source)) return null;
  const b = new SessionBuilder('aider', file);
  let t = 0;
  let fence: string | null = null;
  let reply: string[] = [];
  let raw: RawRow = {};
  let promptContinues = false;
  const flush = () => {
    b.step('message', reply.join('\n').trim(), t, raw);
    reply = [];
  };
  for (const [i, line] of source.split('\n').entries()) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      reply.push(line);
      promptContinues = false;
      continue;
    }
    if (!fence && line.startsWith('# aider chat started at ')) {
      flush();
      t = time(line.slice(24).trim().replace(' ', 'T'), t);
      b.session.started ||= t;
      promptContinues = false;
    } else if (!fence && line.startsWith('#### ')) {
      if (promptContinues && b.turn) b.turn.prompt += '\n' + line.slice(5).trimEnd();
      else {
        flush();
        raw = { type: 'markdown', text: line, __line: i + 1 };
        b.prompt(line.slice(5).trimEnd(), t, [raw]);
      }
      promptContinues = line.endsWith('  ');
    } else {
      reply.push(line);
      promptContinues = false;
    }
  }
  flush();
  return b.finish();
};
