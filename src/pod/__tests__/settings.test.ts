import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerDesignCommand } from '../../commands/design';
import { createPodStore } from '../../pod-store';
import {
  PRODUCT_MANAGER_SETTINGS,
  agentCommandLine,
  writePodSettings,
} from '../launch';
import './podProject';

const POD = 'pawnee-a1b2';

const DENY = [
  'Workflow',
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(lambda ship:*)',
  'Bash(lambda pod delete:*)',
];

const FORK_ONLY_DENY = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Artifact',
  'Bash(lambda pod question:*)',
  'Bash(lambda pod checkpoint:*)',
  'Bash(lambda tickets create:*)',
  'Bash(lambda tickets update:*)',
  'Bash(lambda tickets comment:*)',
  'Bash(lambda tickets push:*)',
  'Bash(lambda design capability:*)',
  'Bash(lambda design canvas:*)',
  'Bash(lambda design render:*)',
  'Bash(lambda design walk:*)',
  'Bash(lambda design snapshot:*)',
  'Bash(lambda design round:*)',
  'Bash(lambda design redesign:*)',
  'Bash(lambda design runtime import:*)',
  'Bash(lambda design system:*)',
  'Bash(lambda shot:*)',
  'Bash(lambda tickets scenarios push:*)',
  'Bash(lambda tickets attach:*)',
  'Bash(lambda verdict visual record:*)',
];

interface Settings {
  permissions: { allow: string[]; deny: string[] };
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
}

const written = (
  cli: string | undefined,
  projectRoot: string = fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-'))
): { main: Settings; fork: Settings } => {
  const store = createPodStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-settings-'))
  );
  writePodSettings(store, POD, { projectRoot, cli });
  const read = (name: string): Settings =>
    JSON.parse(fs.readFileSync(store.file(POD, name), 'utf8'));

  return { main: read('settings.json'), fork: read('fork-settings.json') };
};

describe('pod settings', () => {
  it("allows Lambda's commands and the codebase CLI exactly as lambda.json writes it", () => {
    const { main } = written('./bin/lambda');

    expect(main.permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(lambda pod:*)',
        'Bash(lambda tickets:*)',
        'Bash(lambda knowledge:*)',
        'Bash(./bin/lambda:*)',
      ])
    );
  });

  it("adds lambda.json's pods.deny to every agent and pods.forkDeny to forks, never widening", () => {
    const store = createPodStore(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-settings-'))
    );
    writePodSettings(store, POD, {
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-')),
      cli: 'trailmap',
      deny: ['Bash(trailmap release:*)'],
      forkDeny: ['Bash(trailmap publish:*)'],
    });
    const read = (name: string): Settings =>
      JSON.parse(fs.readFileSync(store.file(POD, name), 'utf8'));
    const main = read('settings.json');
    const fork = read('fork-settings.json');

    expect(main.permissions.allow).toContain('Bash(trailmap:*)');
    expect(main.permissions.deny).toEqual(
      expect.arrayContaining([...DENY, 'Bash(trailmap release:*)'])
    );
    expect(main.permissions.deny).not.toContain('Bash(trailmap publish:*)');
    expect(fork.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(trailmap release:*)',
        'Bash(trailmap publish:*)',
      ])
    );
    expect(fork.permissions.allow).not.toContain('Bash(trailmap publish:*)');
  });

  it('has no codebase CLI rule when lambda.json names none', () => {
    const { main } = written(undefined);

    // Exactly the pod's own rules: no CLI rule of any name slips in.
    expect(main.permissions.allow).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'Bash(lambda pod:*)',
      'Bash(lambda tickets:*)',
      'Bash(lambda knowledge:*)',
      'Artifact',
      'Bash(lambda design:*)',
      'Bash(lambda shot:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(grep:*)',
      'Bash(rg:*)',
      'Bash(find:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(wc:*)',
      'Bash(sed -n:*)',
    ]);
    expect(written('./bin/lambda').main.permissions.allow).toEqual([
      ...main.permissions.allow,
      'Bash(./bin/lambda:*)',
    ]);
  });

  it('denies exactly the five rules and the design system manifest, naming no other tool', () => {
    const { main } = written('./bin/lambda');

    expect(main.permissions.deny).toEqual([
      ...DENY,
      'Bash(lambda design system manifest:*)',
    ]);
  });

  it('keeps lambda pod delete denied even when the codebase CLI is lambda itself', () => {
    const { main, fork } = written('lambda');

    expect(main.permissions.allow).toContain('Bash(lambda:*)');
    expect(main.permissions.deny).toContain('Bash(lambda pod delete:*)');
    expect(main.permissions.allow).not.toContain('Bash(lambda pod delete:*)');
    expect(fork.permissions.deny).toContain('Bash(lambda pod delete:*)');
  });

  it("makes forks read-only: every fork deny is also out of the fork's allow list", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-'));
    fs.mkdirSync(path.join(projectRoot, '.claude'));
    // A project allow can't re-grant what a fork is denied.
    fs.writeFileSync(
      path.join(projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Edit', 'Bash(npm test:*)'] } })
    );
    const { main, fork } = written('lambda', projectRoot);

    expect(fork.permissions.deny).toEqual([...DENY, ...FORK_ONLY_DENY]);
    FORK_ONLY_DENY.forEach((rule) =>
      expect(fork.permissions.allow).not.toContain(rule)
    );
    expect(main.permissions.allow).toContain('Bash(npm test:*)');
    expect(fork.permissions.allow).toContain('Bash(npm test:*)');
  });

  it('lets the dev design and photograph, and keeps every design write from a fork', () => {
    const { main, fork } = written('lambda');

    expect(main.permissions.allow).toEqual(
      expect.arrayContaining([
        'Artifact',
        'Bash(lambda design:*)',
        'Bash(lambda shot:*)',
      ])
    );
    expect(fork.permissions.deny).toEqual(
      expect.arrayContaining([
        'Artifact',
        'Bash(lambda design redesign:*)',
        'Bash(lambda design round:*)',
        'Bash(lambda design snapshot:*)',
        'Bash(lambda design walk:*)',
        'Bash(lambda design system:*)',
        'Bash(lambda design capability:*)',
        'Bash(lambda tickets scenarios push:*)',
        'Bash(lambda tickets attach:*)',
      ])
    );
    expect(fork.permissions.allow).not.toContain('Artifact');
    // Every design and shot rule names the CLI it was given, no other.
    expect(
      [...main.permissions.allow, ...fork.permissions.deny].filter(
        (rule) =>
          /^Bash\(.*\b(design|shot)\b/.test(rule) &&
          !rule.startsWith('Bash(lambda ')
      )
    ).toEqual([]);
  });

  it('keeps every design and shot write from a fork, allowing only the read-only commands', () => {
    const { fork } = written('lambda');
    const program = new Command();
    registerDesignCommand(program);
    const leaves = (command: Command, prefix: string): string[] =>
      command.commands.length === 0
        ? [prefix]
        : command.commands.flatMap((sub) =>
            leaves(sub, `${prefix} ${sub.name()}`)
          );
    const readOnly = ['lambda design brief', 'lambda design runtime status'];

    // A rule `Bash(<prefix>:*)` covers every command that starts with it.
    const covered = (rules: string[], leaf: string): boolean =>
      rules.some((rule) => {
        const prefix = /^Bash\((.+):\*\)$/.exec(rule)?.[1];

        return (
          prefix !== undefined &&
          (leaf === prefix || leaf.startsWith(`${prefix} `))
        );
      });

    // A deny beats any allow (the codebase CLI's `Bash(lambda:*)` included).
    leaves(program.commands[0], 'lambda design').forEach((leaf) =>
      expect({ leaf, denied: covered(fork.permissions.deny, leaf) }).toEqual({
        leaf,
        denied: !readOnly.includes(leaf),
      })
    );
    readOnly.forEach((leaf) =>
      expect(fork.permissions.allow).toContain(`Bash(${leaf}:*)`)
    );
    // A photo (`lambda shot <id>`) can't be told apart from a search by
    // prefix, so the whole command is denied; a fork reads scenario files.
    expect(fork.permissions.deny).toContain('Bash(lambda shot:*)');
    expect(fork.permissions.allow).not.toContain('Bash(lambda design:*)');
    expect(fork.permissions.allow).not.toContain('Bash(lambda shot:*)');
  });

  it("doesn't let the Product manager publish or run a design command", () => {
    const { allow, deny } = PRODUCT_MANAGER_SETTINGS.permissions;

    expect(deny).toEqual(
      expect.arrayContaining(['Artifact', 'Bash(lambda design:*)'])
    );
    expect(allow).not.toContain('Artifact');
  });

  it('starts a planning dev, and a fork that designs, as interactive claude, never claude -p', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-launch-'));
    process.env.LAMBDA_PODS_ROOT = root;
    const store = createPodStore(root);
    store.writePod({
      id: POD,
      slug: 'pawnee',
      createdAt: '2026-10-03T00:00:00.000Z',
      status: 'active',
      phase: 4,
      completedCheckpoints: [],
      worktreePath: '/tmp/pawnee',
      ownsWorktree: false,
      managerCwd: '/tmp/pawnee',
      devCwd: '/tmp/pawnee',
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    const pod = store.requirePod(POD);
    const lines = [
      agentCommandLine(pod, store, 'dev', { kind: 'fresh', sessionId: 'd' }),
      agentCommandLine(pod, store, 'dev', { kind: 'resume', sessionId: 'd' }),
      agentCommandLine(pod, store, 'fork-q1', {
        kind: 'fork',
        fromSessionId: 'd',
      }),
    ];

    lines.forEach((line) => {
      expect(line).toMatch(/ claude --(session-id|resume) /);
      expect(line.split(' ')).not.toContain('-p');
      expect(line.split(' ')).not.toContain('--print');
    });
  });

  it("lets the planning dev build main's design system for designs, but never write its manifest", () => {
    const { main, fork } = written('lambda');
    // A deny beats any allow, so `Bash(lambda design:*)` can't re-grant it.
    const denies = (rules: string[], command: string): boolean =>
      rules.some((rule) => {
        const prefix = /^Bash\((.+):\*\)$/.exec(rule)?.[1];

        return (
          prefix !== undefined &&
          (command === prefix || command.startsWith(`${prefix} `))
        );
      });

    expect(main.permissions.allow).toContain('Bash(lambda design:*)');
    expect(
      denies(main.permissions.deny, 'lambda design system manifest write')
    ).toBe(true);
    expect(
      denies(main.permissions.deny, 'lambda design system build --from abc1234')
    ).toBe(false);
    expect(
      denies(main.permissions.deny, 'lambda design system prepare /tmp/c')
    ).toBe(false);
    expect(main.permissions.allow).not.toContain(
      'Bash(lambda design system manifest:*)'
    );
    // A fork runs no design system command at all: build and manifest write
    // are both denied through `Bash(lambda design system:*)`.
    [
      'lambda design system build',
      'lambda design system manifest write',
    ].forEach((command) =>
      expect(denies(fork.permissions.deny, command)).toBe(true)
    );
  });

  it('hooks call lambda pod hook prompt-submit and stop', () => {
    const { main, fork } = written(undefined);

    [main, fork].forEach((settings) => {
      expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
        'lambda pod hook prompt-submit'
      );
      expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
        'lambda pod hook stop'
      );
    });
  });
});
