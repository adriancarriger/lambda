import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { tempHome } from '../../mothership/__tests__/harness';
import { starterDir } from '../projectsSetup';

/** A new project's starter: `node server.mjs` serves its page. */
describe('the starter project', () => {
  const opened: { dirs: string[]; children: ChildProcess[] } = {
    dirs: [],
    children: [],
  };

  afterEach(() => {
    opened.children.forEach((child) => child.kill());
    opened.dirs.forEach((dir) =>
      fs.rmSync(dir, { recursive: true, force: true })
    );
    opened.dirs = [];
    opened.children = [];
  });

  it('listens when run from a folder whose path has a space', async () => {
    const parent = tempHome();
    opened.dirs = [parent];
    const folder = path.join(parent, 'Sweetums recipe app');
    fs.cpSync(starterDir(), folder, { recursive: true });
    const port = 41_000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: folder,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    opened.children = [child];

    const answers = async (triesLeft: number): Promise<boolean> => {
      const ok = await fetch(`http://127.0.0.1:${port}/`).then(
        (response) => response.status === 200,
        () => false
      );

      if (ok || triesLeft === 0) {
        return ok;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      return answers(triesLeft - 1);
    };
    const answered = await answers(30);

    expect(answered).toBe(true);
  });
});
