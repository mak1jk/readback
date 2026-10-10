const decoder = new TextDecoder();

/** Lines of a text or UTF-8 byte buffer, without building one string for the whole input. */
export function* lines(input: string | Uint8Array): Generator<string> {
  if (typeof input === 'string') {
    yield* input.split('\n');
    return;
  }
  let start = 0;
  for (;;) {
    const nl = input.indexOf(10, start);
    if (nl < 0) break;
    yield decoder.decode(input.subarray(start, nl));
    start = nl + 1;
  }
  yield decoder.decode(input.subarray(start));
}
