import * as fs from 'fs';

import { browserCommand, runOpen } from '..';
import { tempHome } from '../../../mothership/__tests__/harness';

describe('lambda open', () => {
  const homes: { list: string[] } = { list: [] };
  const home = (): string => {
    const made = tempHome();
    homes.list = [...homes.list, made];

    return made;
  };

  afterEach(() => {
    homes.list.forEach((made) =>
      fs.rmSync(made, { recursive: true, force: true })
    );
    homes.list = [];
  });

  it('says it is opening when a browser opened', async () => {
    const line = await runOpen({
      env: { LAMBDA_HOME: home() },
      answering: async () => true,
      open: async () => undefined,
    });

    expect(line).toBe('Opening Lambda in your browser, signed in…');
  });

  it('prints the link when no browser opens (over SSH, no xdg-open)', async () => {
    const line = await runOpen({
      env: { LAMBDA_HOME: home() },
      answering: async () => true,
      open: async () => {
        throw new Error('spawn xdg-open ENOENT');
      },
    });

    expect(line).toMatch(
      /^Couldn't open a browser here \(spawn xdg-open ENOENT\)\. Open this link within a minute: http:\/\/127\.0\.0\.1:\d+\/auth\/link\?t=/
    );
  });

  it('uses a command each platform really has', () => {
    const url = 'http://localhost:4580/auth/login?token=t';

    expect(browserCommand('darwin', url)).toEqual(['open', [url]]);
    expect(browserCommand('linux', url)).toEqual(['xdg-open', [url]]);
    // `start` is a cmd built-in, not a program execFile can run.
    expect(browserCommand('win32', url)).toEqual([
      'rundll32',
      ['url.dll,FileProtocolHandler', url],
    ]);
  });
});
