/**
 * The pod's instructions in a real `git worktree add --detach` checkout: every
 * command where its agent finds it, nothing showing as a change to commit,
 * the main checkout untouched, and a project's own command never overwritten.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadProjectConfig } from '../../config/projectConfig';
import { type Pod, createPodStore } from '../../pod-store';
import { runNew, runSync } from '../lifecycle';
import { setOwnerName, usePodProject } from './podProject';

const saved = { ...process.env };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=leslie@pawnee.gov',
      '-c',
      'user.name=Leslie Knope',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

const write = (root: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** A committed git project with these files; returns its root. */
const gitProject = (files: Record<string, string> = {}): string => {
  const root = usePodProject();
  Object.entries(files).forEach(([file, text]) => write(root, file, text));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'start');

  return root;
};

/** `lambda pod new --no-launch` in the current project; the pod. */
const newPod = async (root: string): Promise<Pod> => {
  const project = loadProjectConfig(root);

  if (project === null) {
    throw new Error('No project.');
  }

  await runNew(
    'ice-town',
    { launch: false },
    {
      project,
      tickets: () => {
        throw new Error('No tickets in this test.');
      },
      print: () => undefined,
    }
  );
  const store = createPodStore(path.join(root, '.lambda', 'pods'));
  const [id] = store.listPodIds();

  if (id === undefined) {
    throw new Error('No pod.');
  }

  return store.requirePod(id);
};

beforeEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  delete process.env.POD_ID;
  process.env.LAMBDA_POD_WORKTREES = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-worktrees-'))
  );
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...saved };
  setOwnerName(undefined);
  jest.restoreAllMocks();
});

describe("a pod's commands", () => {
  it('reach both agents, show as no change in the worktree, and leave the main checkout alone', async () => {
    const root = gitProject();
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const excludeBefore = fs.existsSync(exclude) ? read(exclude) : '';

    const pod = await newPod(root);
    const worktreeCommands = path.join(pod.devCwd, '.claude', 'commands');
    const managerCommands = path.join(pod.managerCwd, '.claude', 'commands');

    ['pod-phase.md', 'human-chat.md', 'red-flags.md', 'freeform.md'].forEach(
      (file) =>
        expect(fs.existsSync(path.join(worktreeCommands, file))).toBe(true)
    );
    ['checkpoint-complete.md', 'pod-request-done.md', 'pod-skip.md'].forEach(
      (file) =>
        expect(fs.existsSync(path.join(managerCommands, file))).toBe(true)
    );
    expect(read(path.join(worktreeCommands, '.gitignore'))).toMatch(
      /^\.gitignore$[\s\S]*^pod-phase\.md$[\s\S]*^human-chat\.md$/m
    );
    expect(git(pod.devCwd, 'status', '--porcelain', '-uall')).toBe('');
    expect(fs.existsSync(exclude) ? read(exclude) : '').toBe(excludeBefore);

    // A command the person adds to the main checkout still shows up there.
    write(root, '.claude/commands/pod-phase.md', 'my own phase\n');
    expect(git(root, 'status', '--porcelain', '-uall')).toContain(
      '.claude/commands/pod-phase.md'
    );
  });

  it("fills the owner in, and never names a person who isn't set", async () => {
    const pod = await newPod(gitProject());

    const chat = read(
      path.join(pod.devCwd, '.claude', 'commands', 'human-chat.md')
    );
    expect(chat).not.toContain('{owner}');
    expect(chat).toContain('# From the owner, directly');
  });

  it("uses the codebase's .lambda/planning override, and a workflow step's own command", async () => {
    const root = gitProject({
      '.lambda/planning/human-chat.md': 'Our own chat rules.\n',
      '.lambda/planning/a11y-check.md':
        'Check every screen with a screen reader.\n',
      '.lambda/planning/workflow.json': JSON.stringify({
        extends: 'standard',
        add: [
          {
            id: 'a11y-check',
            label: 'Accessibility',
            run: '/a11y-check {tickets}',
            after: 'ux-review',
          },
        ],
      }),
    });

    const pod = await newPod(root);
    const commands = path.join(pod.devCwd, '.claude', 'commands');

    expect(read(path.join(commands, 'human-chat.md'))).toBe(
      'Our own chat rules.\n'
    );
    expect(read(path.join(commands, 'a11y-check.md'))).toBe(
      'Check every screen with a screen reader.\n'
    );
    expect(
      read(path.join(pod.managerCwd, '.claude', 'commands', 'a11y-check.md'))
    ).toBe('Check every screen with a screen reader.\n');
  });

  it("never overwrites the codebase's own tracked command, at launch or sync, and the manager gets it", async () => {
    const theirs = '# Our human-chat\n\nAnswer in haiku.\n';
    const root = gitProject({ '.claude/commands/human-chat.md': theirs });

    const pod = await newPod(root);
    const commands = path.join(pod.devCwd, '.claude', 'commands');

    expect(read(path.join(commands, 'human-chat.md'))).toBe(theirs);
    expect(
      read(path.join(pod.managerCwd, '.claude', 'commands', 'human-chat.md'))
    ).toBe(theirs);
    expect(read(path.join(commands, '.gitignore')).split('\n')).not.toContain(
      'human-chat.md'
    );

    runSync(pod.id);

    expect(read(path.join(commands, 'human-chat.md'))).toBe(theirs);
    expect(git(pod.devCwd, 'status', '--porcelain', '-uall')).toBe('');
  });

  it("gives the dev Lambda's own /pod-phase, as the manager has it, over a tracked project copy", async () => {
    const theirs = '# Our pod-phase\n\nRun the old process.\n';
    const root = gitProject({ '.claude/commands/pod-phase.md': theirs });

    const pod = await newPod(root);
    const devCopy = path.join(
      pod.devCwd,
      '.claude',
      'commands',
      'pod-phase.md'
    );
    const managerCopy = path.join(
      pod.managerCwd,
      '.claude',
      'commands',
      'pod-phase.md'
    );

    expect(read(devCopy)).not.toBe(theirs);
    expect(read(devCopy)).toBe(read(managerCopy));
    expect(git(pod.devCwd, 'status', '--porcelain', '-uall')).toBe('');

    runSync(pod.id);

    expect(read(devCopy)).toBe(read(managerCopy));
    expect(git(pod.devCwd, 'status', '--porcelain', '-uall')).toBe('');
    expect(read(path.join(root, '.claude', 'commands', 'pod-phase.md'))).toBe(
      theirs
    );
  });

  it('refuses an untracked project copy of a locked command rather than overwrite it', async () => {
    const root = usePodProject();
    write(root, '.claude/commands/pod-phase.md', 'my own phase\n');

    await expect(newPod(root)).rejects.toThrow(
      "would hide Lambda's own /pod-phase from the pod's dev"
    );
    expect(read(path.join(root, '.claude', 'commands', 'pod-phase.md'))).toBe(
      'my own phase\n'
    );
  });

  it("in a folder that isn't a git repo, sync rewrites Lambda's own copies instead of reading them back", async () => {
    const root = usePodProject();

    const pod = await newPod(root);
    const chat = path.join(pod.devCwd, '.claude', 'commands', 'human-chat.md');
    expect(pod.ownsWorktree).toBe(false);
    expect(read(chat)).toContain('# From the owner, directly');

    setOwnerName('Leslie Knope');
    runSync(pod.id);

    expect(read(chat)).toContain('# From Leslie Knope, directly');
    expect(
      read(path.join(pod.managerCwd, '.claude', 'commands', 'human-chat.md'))
    ).toContain('# From Leslie Knope, directly');
  });

  it('appends to a tracked .claude/commands/.gitignore without changing it for git, and sync puts it back', async () => {
    const root = gitProject({ '.claude/commands/.gitignore': 'scratch.md\n' });

    const pod = await newPod(root);
    const ignore = path.join(pod.devCwd, '.claude', 'commands', '.gitignore');

    expect(read(ignore)).toMatch(/^scratch\.md\n/);
    expect(read(ignore)).toContain('pod-phase.md');
    expect(git(pod.devCwd, 'status', '--porcelain', '-uall')).toBe('');

    runSync(pod.id);

    expect(read(ignore)).toMatch(/^scratch\.md\n/);
    expect(read(ignore)).toContain('pod-phase.md');
    expect(git(pod.devCwd, 'status', '--porcelain', '-uall')).toBe('');
  });
});
