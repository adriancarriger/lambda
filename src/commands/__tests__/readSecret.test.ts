import { PassThrough } from 'stream';

import { readSecret } from '../connect';

const KEY = ['lin', 'api', 'pawneeparks'].join('_');

describe('a key typed at the terminal', () => {
  it('is read but never shown: only the question appears', async () => {
    const input = new PassThrough();
    const shown: string[] = [];
    // A terminal: readline echoes what is typed to a TTY output.
    const output = Object.assign(
      new PassThrough().on('data', (chunk: Buffer) =>
        shown.splice(shown.length, 0, chunk.toString())
      ),
      { isTTY: true, columns: 80 }
    );

    const reading = readSecret('Linear API key: ', {
      input,
      output,
      isTTY: true,
    });
    input.write(`${KEY}\r`);

    expect(await reading).toBe(KEY);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shown.join('')).toContain('Linear API key: ');
    expect(shown.join('')).not.toContain(KEY);
  });
});
