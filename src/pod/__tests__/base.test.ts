/**
 * Pods check out the ref `_base.json` names, else the codebase's default
 * branch fetched fresh (or the main checkout's HEAD with no origin), and get
 * the planner's instructions — uncommitted edits included.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadProjectConfig } from '../../config/projectConfig';
import { createPodStore } from '../../pod-store';
import { lambdaPackageDir } from '../../process/workflow-file';
import {
  ourCommandFiles,
  podBase,
  refreshBase,
  removePodInstructions,
  writeCommandsIgnore,
  writePodInstructions,
} from '../base';
import { claudeStateFile } from '../claudeTrust';
import { runNew } from '../lifecycle';
import { newWindow } from '../tmux';
import { usePodProject } from './podProject';

// Agent windows are recorded, never opened; messages are never pasted.
jest.mock('../tmux', () => ({
  ...jest.requireActual('../tmux'),
  newWindow: jest.fn(),
  waitForAgentReady: jest.fn(async () => true),
}));
jest.mock('../messaging', () => ({
  ...jest.requireActual('../messaging'),
  sendMessage: jest.fn(async () => ({ id: 'm1' })),
}));

const saved = { ...process.env };

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-base-')));

const write = (root: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=leslie@pawnee.gov',
      '-c',
      'user.name=Leslie Knope',
      '-c',
      'init.defaultBranch=trunk',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();

/** A remote whose default branch is `trunk`, and a clone of it. */
const clonedRepo = (): { remote: string; clone: string } => {
  const seed = tmp();
  git(seed, 'init', '-q');
  write(seed, 'README.md', 'Pawnee Parks\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'start');
  const remote = path.join(tmp(), 'remote.git');
  git(seed, 'clone', '-q', '--bare', seed, remote);
  const clone = path.join(tmp(), 'clone');
  git(seed, 'clone', '-q', remote, clone);

  return { remote, clone };
};

afterEach(() => {
  process.env = { ...saved };
});

describe('podBase', () => {
  it('names nothing with no _base.json: the default branch is used', () => {
    process.env.LAMBDA_PODS_ROOT = tmp();

    expect(podBase()).toEqual({});
  });

  it('reads the branch and the planner from _base.json', () => {
    const root = tmp();
    write(
      root,
      '_base.json',
      JSON.stringify({ ref: 'pod-base', planner: '/x/planner-checkout' })
    );
    process.env.LAMBDA_PODS_ROOT = root;

    expect(podBase()).toEqual({
      ref: 'pod-base',
      planner: '/x/planner-checkout',
    });
  });
});

describe('refreshBase', () => {
  it("fetches origin's default branch, whatever it is called", () => {
    const { remote, clone } = clonedRepo();
    // A commit the clone hasn't seen: only a fetch brings it.
    const other = path.join(tmp(), 'other');
    git(tmp(), 'clone', '-q', remote, other);
    write(other, 'NEWS.md', 'Ice Town opens\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'news');
    git(other, 'push', '-q', 'origin', 'trunk');

    expect(refreshBase(clone, {}, tmp())).toBe('origin/trunk');
    expect(git(clone, 'rev-parse', 'origin/trunk')).toBe(
      git(other, 'rev-parse', 'HEAD')
    );
  });

  it("uses the main checkout's HEAD, with no fetch, when there is no origin", () => {
    const repo = tmp();
    git(repo, 'init', '-q');
    write(repo, 'README.md', 'Pawnee Parks\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');

    expect(refreshBase(repo, {}, tmp())).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('lets _base.json ref override it', () => {
    const { clone } = clonedRepo();

    expect(refreshBase(clone, { ref: 'pod-base' }, tmp())).toBe('pod-base');
  });

  it('refuses an origin with no HEAD, naming both fixes and guessing no branch', () => {
    const repo = tmp();
    git(repo, 'init', '-q');
    git(repo, 'remote', 'add', 'origin', clonedRepo().remote);
    const root = tmp();

    expect(() => refreshBase(repo, {}, root)).toThrow(
      `can't tell origin's default branch. Run "git remote set-head origin --auto", or set "ref" in ${path.join(
        root,
        '_base.json'
      )}. Nothing was created.`
    );
  });

  it("refuses when origin's branch can't be fetched, with git's last line", () => {
    const { clone } = clonedRepo();
    git(clone, 'remote', 'set-url', 'origin', '/no/such/remote.git');

    expect(() => refreshBase(clone, {}, tmp())).toThrow(
      /^git fetch origin trunk failed: fatal: [^\n]*[^.]\. Nothing was created\.$/
    );
  });
});

describe('lambda pod new with a base it cannot use', () => {
  beforeEach(() => {
    jest.mocked(newWindow).mockReset();
    delete process.env.LAMBDA_PODS_ROOT;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** `lambda pod new ice-town` (launching agents) in the project at `root`. */
  const attempt = (root: string): Promise<void> => {
    const project = loadProjectConfig(root);

    if (project === null) {
      throw new Error('No project.');
    }

    return runNew(
      'ice-town',
      { launch: true },
      {
        project,
        tickets: () => {
          throw new Error('none');
        },
        print: () => undefined,
      }
    );
  };

  /** Every tmux session the attempt started (agent windows open sessions). */
  const sessionsStarted = (): string[] =>
    jest.mocked(newWindow).mock.calls.map(([args]) => args.session);

  /** Nothing of the pod's: no state, no worktree, no session. */
  const expectNothingCreated = (root: string, worktrees: string): void => {
    expect(fs.existsSync(path.join(root, '.lambda', 'pods'))).toBe(false);
    expect(fs.readdirSync(worktrees)).toEqual([]);
    expect(sessionsStarted()).toEqual([]);
  };

  it('starts the pod session when the base is fine — what the checks below look for', async () => {
    const root = usePodProject();
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'start');
    // A second commit, so the worktree being at HEAD isn't just "a commit".
    write(root, 'NEWS.md', 'Ice Town opens\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'news');
    process.env.LAMBDA_POD_WORKTREES = tmp();
    // Whether each agent started under the start lock a resume takes too.
    const locked: boolean[] = [];
    jest.mocked(newWindow).mockImplementation(({ session }) => {
      const id = session.replace(/^lambda-pod-/, '');
      locked.splice(
        locked.length,
        0,
        fs.existsSync(path.join(root, '.lambda', 'pods', id, 'start.lock'))
      );
    });

    await attempt(root);

    expect(sessionsStarted()).toHaveLength(2);
    expect(sessionsStarted()[0]).toMatch(/^lambda-pod-ice-town-[0-9a-f]{4}$/);
    expect(locked).toEqual([true, true]);
    // Marked trusted before they started: the worktree is keyed on the repo.
    expect(
      JSON.parse(fs.readFileSync(claudeStateFile(), 'utf8')).projects[
        fs.realpathSync(root)
      ]
    ).toEqual({ hasTrustDialogAccepted: true });

    // No origin: the worktree is made at the main checkout's HEAD.
    const store = createPodStore(path.join(root, '.lambda', 'pods'));
    const [id] = store.listPodIds();

    if (id === undefined) {
      throw new Error('No pod.');
    }

    expect(git(store.requirePod(id).devCwd, 'rev-parse', 'HEAD')).toBe(
      git(root, 'rev-parse', 'HEAD')
    );
  });

  it("creates nothing when origin's default branch can't be told", async () => {
    const root = usePodProject();
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'start');
    git(root, 'remote', 'add', 'origin', '/no/such/remote.git');
    const worktrees = tmp();
    process.env.LAMBDA_POD_WORKTREES = worktrees;

    await expect(attempt(root)).rejects.toThrow(
      "can't tell origin's default branch"
    );
    expectNothingCreated(root, worktrees);
  });

  it('says plainly that a project with no commits needs a first one, creating nothing', async () => {
    const root = usePodProject();
    git(root, 'init', '-q');
    const worktrees = tmp();
    process.env.LAMBDA_POD_WORKTREES = worktrees;

    await expect(attempt(root)).rejects.toThrow(
      'this codebase has no commits yet. Make a first commit, then try again. Nothing was created.'
    );
    expectNothingCreated(root, worktrees);
  });

  it("creates nothing when origin's default branch can't be fetched", async () => {
    const { clone } = clonedRepo();
    write(clone, 'lambda.json', '{ "name": "pawnee-parks" }\n');
    process.chdir(clone);
    git(clone, 'remote', 'set-url', 'origin', '/no/such/remote.git');
    const worktrees = tmp();
    process.env.LAMBDA_POD_WORKTREES = worktrees;

    await expect(attempt(clone)).rejects.toThrow(
      /^git fetch origin trunk failed: .+\. Nothing was created\.$/
    );
    expectNothingCreated(clone, worktrees);
  });
});

describe('writePodInstructions', () => {
  it("lays the planner's instructions into the pod, and nothing else from it", () => {
    const planner = tmp();
    const worktree = tmp();
    write(planner, '.lambda/planning/human-chat.md', 'the planner chat');
    write(planner, 'apps/parks/index.ts', 'code');

    writePodInstructions({
      podId: 'ice-town-1a2b',
      devCwd: worktree,
      managerCwd: path.join(worktree, '.lambda', 'managers', 'ice-town-1a2b'),
      projectDir: planner,
      owner: 'Leslie Knope',
    });

    expect(
      fs.readFileSync(
        path.join(worktree, '.claude', 'commands', 'human-chat.md'),
        'utf8'
      )
    ).toBe('the planner chat');
    expect(fs.existsSync(path.join(worktree, 'apps'))).toBe(false);
  });

  it("keeps another pod's command files in the ignore list", () => {
    const planner = tmp();
    const worktree = tmp();
    write(planner, '.lambda/planning/human-chat.md', 'the planner chat');
    write(
      worktree,
      '.claude/commands/.gitignore',
      '# Written by lambda pod for this worktree only.\n.gitignore\nstart.md\n'
    );

    writePodInstructions({
      podId: 'ice-town-1a2b',
      devCwd: worktree,
      managerCwd: path.join(worktree, '.lambda', 'managers', 'ice-town-1a2b'),
      projectDir: planner,
      owner: 'Leslie Knope',
    });

    const listed = fs
      .readFileSync(path.join(worktree, '.claude/commands/.gitignore'), 'utf8')
      .split('\n');
    expect(listed).toContain('start.md');
    expect(listed).toContain('human-chat.md');
  });

  // The judge's scale is Lambda's own, and the dev has no reliable way to
  // work out where Lambda's package is, so design-screen names it in full.
  it.each([
    ["Lambda's design-screen", undefined],
    ["the codebase's design-screen", 'Grade with {severityFile}.'],
  ])(
    'names the severity scale by its absolute path in %s',
    (_name, override) => {
      const planner = tmp();
      const worktree = tmp();

      try {
        if (override !== undefined) {
          write(planner, '.lambda/planning/design-screen.md', override);
        }

        writePodInstructions({
          podId: 'ice-town-1a2b',
          devCwd: worktree,
          managerCwd: path.join(
            worktree,
            '.lambda',
            'managers',
            'ice-town-1a2b'
          ),
          projectDir: planner,
          owner: 'Leslie Knope',
        });

        const text = fs.readFileSync(
          path.join(worktree, '.claude', 'commands', 'design-screen.md'),
          'utf8'
        );
        const severityFile = path.join(
          lambdaPackageDir(),
          'instructions',
          'design',
          'visual-severity.md'
        );

        expect(path.isAbsolute(severityFile)).toBe(true);
        expect(fs.existsSync(severityFile)).toBe(true);
        expect(text).toContain(severityFile);
        expect(text).not.toContain('{severityFile}');
      } finally {
        fs.rmSync(planner, { recursive: true, force: true });
        fs.rmSync(worktree, { recursive: true, force: true });
      }
    }
  );
});

describe('removePodInstructions', () => {
  it("takes only the pod's own files and section, keeping a shared file, an older list and the codebase's lines", () => {
    const worktree = tmp();
    const commands = path.join(worktree, '.claude', 'commands');
    ['pod-phase.md', 'start.md', 'check-ticket.md', 'old.md'].forEach((file) =>
      write(commands, file, file)
    );
    write(
      commands,
      '.gitignore',
      'notes.md\n# Written by lambda pod for this worktree only.\n.gitignore\nold.md\n'
    );
    writeCommandsIgnore(worktree, 'ice-town-1a2b', [
      'pod-phase.md',
      'check-ticket.md',
    ]);
    writeCommandsIgnore(worktree, 'build-a1b2', [
      'start.md',
      'check-ticket.md',
    ]);

    removePodInstructions(worktree, 'ice-town-1a2b');

    expect(fs.existsSync(path.join(commands, 'pod-phase.md'))).toBe(false);
    ['start.md', 'check-ticket.md', 'old.md'].forEach((file) =>
      expect(fs.existsSync(path.join(commands, file))).toBe(true)
    );
    expect(ourCommandFiles(worktree, 'ice-town-1a2b')).toEqual([]);
    expect(ourCommandFiles(worktree, 'build-a1b2')).toEqual([
      'start.md',
      'check-ticket.md',
    ]);
    expect(ourCommandFiles(worktree).sort()).toEqual([
      'check-ticket.md',
      'old.md',
      'start.md',
    ]);
    expect(
      fs.readFileSync(path.join(commands, '.gitignore'), 'utf8').split('\n')[0]
    ).toBe('notes.md');
  });
});
