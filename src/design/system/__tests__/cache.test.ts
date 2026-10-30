import * as path from 'path';

import { PROJECT_CONFIG_FILE } from '../../../config/projectConfig';
import { notInstalledMessage } from '../build';
import {
  LOOK_ONLY_KEEP_MS,
  buildFromRef,
  cacheDirOf,
  takeLock,
} from '../cache';
import {
  PROJECT_NAME,
  listTree,
  makeRepo,
  parksApp,
  projectAt,
  quiet,
  rejection,
  useHome,
} from './buildFixture';
import { tmpDir } from './gitFixture';

// A plain object in place of `fs`, so a test can step into the lock's reads
// and writes the way a second process would.
jest.mock('fs', () => ({ ...jest.requireActual('fs') }));
const fs: typeof import('fs') = jest.requireMock('fs');

// os.homedir() follows jest's copy of HOME, so the cache lands in a temp home.
jest.mock('os', () => ({
  ...jest.requireActual<object>('os'),
  homedir: () => process.env.HOME ?? '/',
}));

/** A pid no process has: the holder of a lock left by a build that died. */
const DEAD = 2 ** 22 + 7;

describe('the build checkout lock', () => {
  const dirs: string[] = [];

  /** A lock path in a fresh folder. */
  const newLock = (): string => {
    const dir = tmpDir('lambda-ds-lock-');
    dirs.splice(dirs.length, 0, dir);

    return path.join(dir, 'checkout.lock');
  };

  afterEach(() => {
    jest.restoreAllMocks();
    dirs
      .splice(0)
      .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('retries when the holder lets go between the refused write and the read', async () => {
    const lock = newLock();
    // The holder still had it at the write and released it straight after.
    jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    });

    const release = await takeLock(lock, 'Pawnee parks map', 1000);

    expect(fs.existsSync(lock)).toBe(true);
    release();
  });

  it('never takes a stale lock another waiter has already taken over', async () => {
    const lock = newLock();
    fs.writeFileSync(lock, String(DEAD));
    const read = fs.readFileSync;
    // Another waiter saw the same dead holder and took the lock first.
    jest.spyOn(fs, 'readFileSync').mockImplementationOnce((file, options) => {
      const body = read(file, options);
      fs.writeFileSync(lock, `${process.ppid}:the other waiter`);

      return body;
    });

    await expect(takeLock(lock, 'Pawnee parks map', 300)).rejects.toThrow(
      'Another design system build is running for Pawnee parks map.'
    );
    expect(read(lock, 'utf8')).toBe(`${process.ppid}:the other waiter`);
  });

  it('takes over a lock whose holder died, holding it under its own token', async () => {
    const lock = newLock();
    fs.writeFileSync(lock, `${DEAD}:the build that died`);

    const release = await takeLock(lock, 'Pawnee parks map', 1000);
    const holder = fs.readFileSync(lock, 'utf8');

    expect(holder.startsWith(`${process.pid}:`)).toBe(true);
    expect(holder).not.toBe(`${DEAD}:the build that died`);
    release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('lets go only of its own lock', async () => {
    const lock = newLock();
    const release = await takeLock(lock, 'Pawnee parks map', 1000);
    // Taken over while this build looked dead.
    fs.writeFileSync(lock, `${process.ppid}:the next build`);

    release();

    expect(fs.readFileSync(lock, 'utf8')).toBe(
      `${process.ppid}:the next build`
    );
  });
});

describe('buildFromRef', () => {
  const homes: { home: string; restore: () => void }[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    homes.splice(0).forEach((home) => {
      home.restore();
      fs.rmSync(home.home, { recursive: true, force: true });
    });
    dirs
      .splice(0)
      .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  /** Pawnee parks map on main, its packages never installed: look only. */
  const lookOnly = (): ReturnType<typeof makeRepo> => {
    const repo = makeRepo(parksApp({ installed: false }));
    dirs.splice(dirs.length, 0, repo.root);
    repo.commit('Pawnee parks map design system');

    return repo;
  };

  /** Pawnee parks map on main, whose own build fails straight away. */
  const failingBuild = (): ReturnType<typeof makeRepo> => {
    const repo = makeRepo({
      ...parksApp(),
      [PROJECT_CONFIG_FILE]: `${JSON.stringify({
        name: PROJECT_NAME,
        design: { system: { build: 'exit 3 # {out}' } },
      })}\n`,
    });
    repo.commit('Pawnee parks map design system');

    return repo;
  };

  it('refuses a ref that is not one commit, building nothing', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const repo = failingBuild();

    const error = await rejection(
      buildFromRef({
        project: projectAt(repo.root),
        projectName: PROJECT_NAME,
        ref: 'main..main',
        log: quiet,
      })
    );

    expect(error.message).toContain('Needed a single revision');
    expect(fs.existsSync(`${home.home}/.lambda/cache`)).toBe(false);
  });

  it("clears a dead build's half-built folder once it holds the lock, keeping a live one's", async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const repo = failingBuild();
    const project = projectAt(repo.root);
    const base = cacheDirOf(project, PROJECT_NAME);
    fs.mkdirSync(path.join(base, `abc.building-${DEAD}`), { recursive: true });
    fs.mkdirSync(path.join(base, `def.building-${process.pid}`));

    const error = await rejection(
      buildFromRef({
        project,
        projectName: PROJECT_NAME,
        ref: 'main',
        log: quiet,
      })
    );

    expect(error.message).toBe(
      "The project's design system build (design.system.build) failed: exit 3."
    );

    expect(
      fs.readdirSync(base).filter((name) => name.includes('.building'))
    ).toEqual([`def.building-${process.pid}`]);
  });

  it('keeps each look-only build in its own folder, so the next never removes one a pod may be reading', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const project = projectAt(lookOnly().root);
    const build = () =>
      buildFromRef({
        project,
        projectName: PROJECT_NAME,
        ref: 'main',
        log: quiet,
      });

    const first = await build();
    const files = listTree(first.folder);
    const removed = jest.spyOn(fs, 'rmSync');
    const second = await build();

    expect(first.result?.notes).toEqual([notInstalledMessage(PROJECT_NAME)]);
    expect(second.folder).not.toBe(first.folder);
    expect(removed.mock.calls.map(([at]) => at)).not.toContain(first.folder);
    expect(files.length).toBeGreaterThan(0);
    expect(listTree(first.folder)).toEqual(files);
  });

  it('sweeps look-only builds older than a day, keeping newer ones', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const project = projectAt(lookOnly().root);
    const base = cacheDirOf(project, PROJECT_NAME);
    const old = new Date(Date.now() - LOOK_ONLY_KEEP_MS - 60_000);
    [
      'abc.not-installed',
      'abc.not-installed-0ld',
      'def.not-installed-n3w',
    ].forEach((name) =>
      fs.mkdirSync(path.join(base, name), { recursive: true })
    );
    ['abc.not-installed', 'abc.not-installed-0ld'].forEach((name) =>
      fs.utimesSync(path.join(base, name), old, old)
    );

    const { folder } = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(
      fs
        .readdirSync(base)
        .filter((name) => name.includes('.not-installed'))
        .sort()
    ).toEqual(['def.not-installed-n3w', path.basename(folder)].sort());
  });
});
