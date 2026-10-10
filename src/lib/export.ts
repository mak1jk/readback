import type { Session } from '../model';
import { dayLbl } from './format';
import { normTool } from './tools';

export function sessionMarkdown(s: Session): string {
  return (
    '# ' + s.title + '\n\n' +
    [s.repo, s.model, dayLbl(s.started)].filter(Boolean).join(' · ') + '\n\n' +
    s.turns
      .map(
        (t, i) =>
          '## Turn ' + (i + 1) + '\n\n> ' + t.prompt.replace(/\n/g, '\n> ') + '\n\n' +
          t.steps
            .map((st) =>
              st.kind === 'message' ? st.text : st.kind === 'tool' ? '```sh\n$ ' + normTool(st).cmd + (st.exit ? '   # exit ' + st.exit : '') + '\n```' : '',
            )
            .filter(Boolean)
            .join('\n\n'),
      )
      .join('\n\n---\n\n')
  );
}
