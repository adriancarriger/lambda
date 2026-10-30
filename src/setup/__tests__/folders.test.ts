import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HttpError } from '../../mothership/relay';
import { setupProject } from '../firstRun';
import {
  CANT_OPEN,
  HIDDEN_FOLDER,
  HOME_ONLY,
  NOT_ALL_OF_HOME,
  NO_SUCH_FOLDER,
  listFolders,
} from '../folders';

/** A temp home with folders, a hidden one, a file and a symlink out to /tmp. */
const tempHome = (): string => {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-home-'))
  );
  ['code', 'code/pawnee-parks', 'Documents', '.config', '.ssh'].forEach((dir) =>
    fs.mkdirSync(path.join(home, dir))
  );
  fs.writeFileSync(path.join(home, 'notes.txt'), 'hi\n');
  fs.symlinkSync(os.tmpdir(), path.join(home, 'tmp-link'));

  return home;
};

/** That home's own LAMBDA_HOME, so a project step never marks the real one. */
const homeEnv = (home: string) => ({ LAMBDA_HOME: path.join(home, '.lambda') });

const refusal = (run: () => unknown): { status: number; message: string } => {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: error.status, message: error.message };
    }

    throw error;
  }

  throw new Error('It was not refused.');
};

const refusalOf = async (
  run: () => Promise<unknown>
): Promise<{ status: number; message: string }> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: error.status, message: error.message };
    }

    throw error;
  }

  throw new Error('It was not refused.');
};

describe('the folder list', () => {
  it('lists the home folder: folders only, hidden ones left out', () => {
    const home = tempHome();

    expect(listFolders('', home)).toEqual({
      path: home,
      parent: null,
      home,
      folders: ['code', 'Documents'],
    });
  });

  it('lists a folder under home, with its parent', () => {
    const home = tempHome();

    expect(listFolders(path.join(home, 'code'), home)).toEqual({
      path: path.join(home, 'code'),
      parent: home,
      home,
      folders: ['pawnee-parks'],
    });
  });

  it.each([
    ['/etc', () => '/etc'],
    ['~/../', () => '~/../'],
    [
      'a symlink under home to /tmp',
      (home: string) => path.join(home, 'tmp-link'),
    ],
  ])('refuses %s with the home-folder message', (_what, requested) => {
    const home = tempHome();

    expect(refusal(() => listFolders(requested(home), home))).toEqual({
      status: 403,
      message: HOME_ONLY,
    });
  });

  it('answers 404 for a missing path under home, and for a file', () => {
    const home = tempHome();

    expect(
      refusal(() => listFolders(path.join(home, 'missing'), home))
    ).toEqual({
      status: 404,
      message: NO_SUCH_FOLDER,
    });
    expect(
      refusal(() => listFolders(path.join(home, 'notes.txt'), home))
    ).toEqual({ status: 404, message: NO_SUCH_FOLDER });
  });

  const asRoot = process.getuid?.() === 0;

  (asRoot ? it.skip : it)("answers 403 for a folder it can't read", () => {
    const home = tempHome();
    const locked = path.join(home, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);

    try {
      expect(refusal(() => listFolders(locked, home))).toEqual({
        status: 403,
        message: CANT_OPEN,
      });
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('never takes the home folder itself as a project, before any git or init', async () => {
    const home = tempHome();
    const git = jest.fn(() => '');
    const init = jest.fn(() => ({ code: 0 }));

    expect(
      await refusalOf(() =>
        setupProject({ folder: home }, { home, env: homeEnv(home), git, init })
      )
    ).toEqual({ status: 403, message: NOT_ALL_OF_HOME });
    expect(
      await refusalOf(() =>
        setupProject({ folder: '~' }, { home, env: homeEnv(home), git, init })
      )
    ).toEqual({
      status: 403,
      message: NOT_ALL_OF_HOME,
    });
    expect(git).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    // The folder list still starts there.
    expect(listFolders('', home).path).toBe(home);
  });

  it('applies the same check to the project POST, before any git or init', async () => {
    const home = tempHome();
    const git = jest.fn(() => '');
    const init = jest.fn(() => ({ code: 0 }));

    expect(
      await refusalOf(() =>
        setupProject(
          { folder: '/etc' },
          { home, env: homeEnv(home), git, init }
        )
      )
    ).toEqual({ status: 403, message: HOME_ONLY });
    expect(git).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  it('refuses a hidden folder posted or listed directly, and a link to one', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.ssh', 'keys'));
    fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'ssh-link'));
    const git = jest.fn(() => '');
    const init = jest.fn(() => ({ code: 0 }));
    const hidden = { status: 403, message: HIDDEN_FOLDER };

    expect(
      await refusalOf(() =>
        setupProject(
          { folder: '~/.ssh' },
          { home, env: homeEnv(home), git, init }
        )
      )
    ).toEqual(hidden);
    expect(
      await refusalOf(() =>
        setupProject(
          { folder: '~/ssh-link' },
          { home, env: homeEnv(home), git, init }
        )
      )
    ).toEqual(hidden);
    expect(refusal(() => listFolders('~/.ssh', home))).toEqual(hidden);
    expect(refusal(() => listFolders('~/.ssh/keys', home))).toEqual(hidden);
    expect(git).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  (asRoot ? it.skip : it)(
    'answers home-only, not "can\'t open", for an unreadable folder outside home',
    () => {
      const home = tempHome();
      const outside = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-outside-'))
      );
      fs.mkdirSync(path.join(outside, 'eagleton'));
      fs.chmodSync(outside, 0o000);

      try {
        expect(
          refusal(() => listFolders(path.join(outside, 'eagleton'), home))
        ).toEqual({ status: 403, message: HOME_ONLY });
      } finally {
        fs.chmodSync(outside, 0o700);
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  (asRoot ? it.skip : it)(
    "answers can't open for a folder inside home it can't get into",
    () => {
      const home = tempHome();
      const locked = path.join(home, 'code', 'locked');
      fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
      fs.chmodSync(locked, 0o000);

      try {
        expect(refusal(() => listFolders('~/code/locked/inner', home))).toEqual(
          {
            status: 403,
            message: CANT_OPEN,
          }
        );
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    }
  );
});
