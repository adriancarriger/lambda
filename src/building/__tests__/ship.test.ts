import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeLambdaGitignore } from '../../commands/init';
import {
  type Project,
  ProjectConfigSchema,
  resolvePodsRoot,
} from '../../config/projectConfig';
import { type Pod, createPodStore } from '../../pod-store';
import { createTicketSource } from '../../tickets/context';
import { type TicketSource } from '../../tickets/source';
import { ensureVerdictsDir, recordVerdict } from '../../verdict/store';
import { blockTicket } from '../blocked';
import { markShippedGroupsDone } from '../groups';
import { type ShipDeps, runShip } from '../ship';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

interface Setup {
  root: string;
  tickets: TicketSource;
  project: Project;
  ship: (id?: string) => Promise<number>;
  shell: string[];
  out: string[];
  err: string[];
}

const setUp = async (
  options: {
    /** The ticket being shipped (default `3`). */
    id?: string;
    title?: string;
    git?: boolean;
    config?: Record<string, unknown>;
    verdict?: 'COMPLETE' | 'INCOMPLETE' | null;
    shellExit?: (command: string) => number;
    /** The tickets as a tracker's (Linear), each status update recorded. */
    tracker?: string[];
  } = {}
): Promise<Setup> => {
  const id = options.id ?? '3';
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-ship-'))
  );
  const rawConfig = { name: 'Pawnee Parks app', ...(options.config ?? {}) };
  fs.writeFileSync(path.join(root, 'lambda.json'), JSON.stringify(rawConfig));
  fs.writeFileSync(
    path.join(root, 'TASKS.md'),
    `- [ ] ${id}: ${options.title ?? 'Trail markers'}\n`
  );
  writeLambdaGitignore(root);

  if (options.git !== false) {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'leslie@pawnee.gov']);
    git(root, ['config', 'user.name', 'Leslie Knope']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'start']);
  }

  const config = ProjectConfigSchema.parse(rawConfig);
  const project: Project = {
    root,
    file: path.join(root, 'lambda.json'),
    config,
  };
  const files = createTicketSource({
    root,
    config: config.tickets,
    tokens: undefined,
    env: {},
    fetch: globalThis.fetch,
    runner: { name: 'Leslie Knope' },
  });
  await files.update(id, { status: 'building' });
  const updates = options.tracker;
  const tickets: TicketSource =
    updates === undefined
      ? files
      : {
          ...files,
          kind: 'linear',
          update: (id, input) => {
            updates.splice(updates.length, 0, `${id} ${input.status ?? ''}`);

            return files.update(id, input);
          },
        };

  if (options.verdict !== null) {
    recordVerdict(root, {
      ticketId: id,
      verdict: options.verdict ?? 'COMPLETE',
      failedDimensions: options.verdict === 'INCOMPLETE' ? ['Test Plan'] : [],
      deviations: [],
      recordedAt: '2026-10-23T10:00:00.000Z',
    });
  }

  const shell: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: ShipDeps = {
    project,
    tickets,
    env: {},
    runShell: async (command) => {
      shell.splice(shell.length, 0, command);

      return options.shellExit?.(command) ?? 0;
    },
    print: (line) => {
      out.splice(out.length, 0, line);
    },
    printError: (line) => {
      err.splice(err.length, 0, line);
    },
    now: () => '2026-10-23T10:00:00.000Z',
  };

  return {
    root,
    tickets,
    project,
    ship: (shipId = id) => runShip(shipId, deps),
    shell,
    out,
    err,
  };
};

const change = (root: string) =>
  fs.writeFileSync(path.join(root, 'park-hours.md'), 'Open 8 to 8.\n');

const events = (root: string): Record<string, unknown>[] => {
  const file = path.join(root, '.lambda', 'events.jsonl');

  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    : [];
};

/** A building pod whose current run is ticket 3, on its ship step. */
const buildingPod = (project: Project): string => {
  const store = createPodStore(resolvePodsRoot(project));
  const pod: Pod = {
    id: 'parks-1a2b',
    slug: 'parks',
    createdAt: '2026-10-23T09:00:00.000Z',
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: project.root,
    ownsWorktree: false,
    managerCwd: path.join(project.root, '.lambda', 'managers', 'parks-1a2b'),
    devCwd: project.root,
    agentCommand: 'claude',
    sessions: {},
    kind: 'building',
  };
  store.writePod(pod);
  store.writeBuilding(pod.id, {
    runs: [
      {
        id: '3',
        title: 'Trail markers',
        step: 'ship',
        attempt: 2,
        startedAt: '2026-10-23T09:30:00.000Z',
        claim: 'claimed',
      },
    ],
    upNext: [],
  });

  return pod.id;
};

const groupLine = (root: string, line: Record<string, unknown>) =>
  fs.appendFileSync(
    path.join(root, '.lambda', 'events.jsonl'),
    `${JSON.stringify(line)}\n`
  );

const groupAdd = (root: string, ticket: string) =>
  groupLine(root, {
    type: 'group.add',
    groupId: 'g1',
    ticket,
    at: '2026-10-23T09:00:00.000Z',
  });

const groupShipped = (root: string) =>
  groupLine(root, {
    type: 'group.shipped',
    groupId: 'g1',
    at: '2026-10-23T10:30:00.000Z',
  });

const noLog = () => undefined;

const runOf = (project: Project, podId: string) =>
  createPodStore(resolvePodsRoot(project)).readBuilding(podId).runs[0];

describe('lambda ship: the gate', () => {
  it('runs nothing without a COMPLETE verdict', async () => {
    const missing = await setUp({
      verdict: null,
      config: { commands: { ship: 'deploy {spec}' } },
    });

    expect(await missing.ship()).toBe(1);
    expect(missing.shell).toEqual([]);
    expect(missing.err).toEqual([
      '✗ 3 Trail markers has no COMPLETE check-ticket verdict.',
      '  Run the check-ticket step first.',
    ]);

    const incomplete = await setUp({ verdict: 'INCOMPLETE' });
    change(incomplete.root);

    expect(await incomplete.ship()).toBe(1);
    expect(incomplete.err).toEqual([
      "✗ 3 Trail markers's last check-ticket verdict was INCOMPLETE.",
      '  Failed: Test Plan',
    ]);
    expect(git(incomplete.root, ['log', '--oneline'])).not.toContain('3:');
  });

  it('refuses a ticket already done, running nothing', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    await setup.tickets.update('3', { status: 'done' });

    expect(await setup.ship()).toBe(1);
    expect(setup.shell).toEqual([]);
    expect(setup.err).toEqual([
      '✗ 3 is already done, so it was not shipped again.',
    ]);
  });

  it("refuses a ticket that isn't the building pod's current one, committing nothing", async () => {
    const setup = await setUp();
    fs.appendFileSync(
      path.join(setup.root, 'TASKS.md'),
      '- [ ] 4: Lot 48 photos\n'
    );
    git(setup.root, ['add', '-A']);
    git(setup.root, ['commit', '-q', '-m', 'ticket 4']);
    const podId = buildingPod(setup.project);
    createPodStore(resolvePodsRoot(setup.project)).writeBuilding(podId, {
      runs: [
        {
          id: '4',
          title: 'Lot 48 photos',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-23T09:40:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    fs.writeFileSync(path.join(setup.root, 'lot-48.md'), 'The photos.\n');

    expect(await setup.ship()).toBe(1);
    expect(setup.err).toEqual([
      "✗ 3 isn't the ticket a building pod is on now (4), so it was not shipped.",
    ]);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('2');
    expect((await setup.tickets.get('3')).status).toBe('building');
  });

  it('refuses a ticket its building pod stopped on, even with nothing else being built', async () => {
    const setup = await setUp();
    const podId = buildingPod(setup.project);
    createPodStore(resolvePodsRoot(setup.project)).writeBuilding(podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-23T09:40:00.000Z',
          claim: 'claimed',
          blocked: {
            at: '2026-10-23T09:50:00.000Z',
            what: 'Trail markers',
            problem:
              "Removed from Lambda in Linear: 3 lost Lambda's label while it was being built.",
            options: '1) Add the label back  2) Leave it out',
            recommendation: 'Leave it out.',
            messageId: 'm-blocked',
          },
        },
      ],
      upNext: [],
    });
    fs.writeFileSync(path.join(setup.root, 'pickup.md'), 'The times.\n');

    expect(await setup.ship()).toBe(1);
    expect(setup.err).toEqual([
      `✗ 3 is blocked in building pod ${podId}, so it was not shipped: Removed from Lambda in Linear: 3 lost Lambda's label while it was being built.`,
    ]);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('1');
    expect((await setup.tickets.get('3')).status).toBe('building');
  });

  it('refuses a verdict file it cannot read', async () => {
    const unreadable = await setUp({ verdict: null });
    fs.writeFileSync(
      path.join(ensureVerdictsDir(unreadable.root), '3.json'),
      'not json'
    );

    expect(await unreadable.ship()).toBe(1);
    expect(unreadable.err).toEqual([
      expect.stringMatching(
        /^✗ 3 Trail markers: the check-ticket verdict couldn't be read \(.+\)\.$/
      ),
    ]);
  });
});

describe("lambda ship: the codebase's own ship command", () => {
  it('runs it with {spec} as the shell-quoted ticket id, then marks the ticket done', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    const podId = buildingPod(setup.project);

    expect(await setup.ship()).toBe(0);
    expect(setup.shell).toEqual(["deploy '3'"]);
    expect(runOf(setup.project, podId)?.shippedAt).toBe(
      '2026-10-23T10:00:00.000Z'
    );
    expect((await setup.tickets.get('3')).status).toBe('done');
  });

  it('closes the ship step itself, so the shipped ticket gets its time', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    const podId = buildingPod(setup.project);

    expect(await setup.ship()).toBe(0);
    expect(
      createPodStore(resolvePodsRoot(setup.project)).readSteps(podId)
    ).toEqual([
      expect.objectContaining({
        at: '2026-10-23T10:00:00.000Z',
        step: 'ship',
        event: 'done',
        pass: 2,
        ticket: '3',
      }),
    ]);
  });

  it('keeps a ticket in an open shipping-together group not done', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    const podId = buildingPod(setup.project);
    fs.appendFileSync(
      path.join(setup.root, '.lambda', 'events.jsonl'),
      `${JSON.stringify({
        type: 'group.add',
        groupId: 'g1',
        ticket: '3',
        at: '2026-10-23T09:00:00.000Z',
      })}\n`
    );

    expect(await setup.ship()).toBe(0);
    expect(runOf(setup.project, podId)?.shippedAt).toBeDefined();
    expect((await setup.tickets.get('3')).status).toBe('building');

    // The runner marks it done only once the project says the group shipped.
    await markShippedGroupsDone(setup.root, setup.tickets, { log: noLog });
    expect((await setup.tickets.get('3')).status).toBe('building');

    groupShipped(setup.root);
    await markShippedGroupsDone(setup.root, setup.tickets, { log: noLog });
    expect((await setup.tickets.get('3')).status).toBe('done');
  });

  it('marks a grouped ticket shipped by hand, with no building pod, done when its group ships', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    groupAdd(setup.root, '3');

    expect(await setup.ship()).toBe(0);
    expect((await setup.tickets.get('3')).status).toBe('building');

    groupShipped(setup.root);
    await markShippedGroupsDone(setup.root, setup.tickets, { log: noLog });
    expect((await setup.tickets.get('3')).status).toBe('done');
  });

  it('asks the tracker about a shipped grouped ticket once, not on every tick', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    groupAdd(setup.root, '3');
    expect(await setup.ship()).toBe(0);
    groupShipped(setup.root);
    const asked: string[] = [];
    const counted = {
      get: (id: string) => {
        asked.splice(asked.length, 0, id);

        return setup.tickets.get(id);
      },
      update: setup.tickets.update,
    };

    expect(
      await markShippedGroupsDone(setup.root, counted, { log: noLog })
    ).toEqual(['3']);
    await markShippedGroupsDone(setup.root, counted, { log: noLog });
    await markShippedGroupsDone(setup.root, counted, { log: noLog });
    // Something else reported: the file changed, but 3 is known done.
    groupLine(setup.root, { type: 'ship.start', ticket: '4' });
    await markShippedGroupsDone(setup.root, counted, { log: noLog });

    expect(asked).toEqual(['3']);
  });

  it('leaves a grouped ticket that never shipped as it is, whatever its group says', async () => {
    const setup = await setUp();
    groupAdd(setup.root, '3');
    groupShipped(setup.root);

    await markShippedGroupsDone(setup.root, setup.tickets, { log: noLog });

    expect((await setup.tickets.get('3')).status).toBe('building');
  });

  it('still reports a ship that went out when the ticket then fails to be marked done', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
    });
    const podId = buildingPod(setup.project);
    setup.tickets.update = async () => {
      throw new Error('Linear answered 500: Internal server error');
    };

    expect(await setup.ship()).toBe(0);
    expect(setup.shell).toEqual(["deploy '3'"]);
    expect(runOf(setup.project, podId)?.shippedAt).toBe(
      '2026-10-23T10:00:00.000Z'
    );
    expect(
      events(setup.root)
        .filter((event) => event.type === 'ship.end')
        .map((event) => event.result)
    ).toEqual(['pass']);
    expect(setup.err.join('\n')).toContain(
      "3 shipped, but it couldn't be marked done: Linear answered 500: Internal server error"
    );
  });

  it('ships nothing when it fails, keeping the claim', async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
      shellExit: () => 1,
    });
    const podId = buildingPod(setup.project);

    expect(await setup.ship()).toBe(1);
    expect(runOf(setup.project, podId)?.shippedAt).toBeUndefined();
    expect(runOf(setup.project, podId)?.claim).toBe('claimed');
    expect((await setup.tickets.get('3')).status).toBe('building');
  });
});

describe('lambda ship: the default ship', () => {
  it('makes one "<id>: <title>" commit on the checked-out branch, pushes nothing, and marks it done', async () => {
    const setup = await setUp();
    change(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(git(setup.root, ['log', '--format=%s', '-1'])).toBe(
      '3: Trail markers'
    );
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('2');
    expect(git(setup.root, ['remote'])).toBe('');
    expect((await setup.tickets.get('3')).status).toBe('done');
    expect(git(setup.root, ['status', '--porcelain'])).toBe('');
  });

  it('refuses a folder that is not a git repository', async () => {
    const setup = await setUp({ git: false });
    change(setup.root);

    expect(await setup.ship()).toBe(1);
    expect(setup.err).toEqual([
      "This folder isn't a git repository, so Lambda can't ship it. Add a `ship` command to lambda.json.",
    ]);
    expect((await setup.tickets.get('3')).status).toBe('building');
  });

  it('ships nothing when the tests fail', async () => {
    const setup = await setUp({
      config: { commands: { test: 'npm test' } },
      shellExit: () => 1,
    });
    change(setup.root);

    expect(await setup.ship()).toBe(1);
    expect(setup.shell).toEqual(['npm test']);
    expect(setup.err).toEqual(['Tests failed, so nothing was shipped.']);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('1');
    expect((await setup.tickets.get('3')).status).toBe('building');
  });

  it('ships nothing when the commit itself fails, keeping the claim', async () => {
    const setup = await setUp();
    const podId = buildingPod(setup.project);
    change(setup.root);
    // The codebase's own pre-commit hook rejects it.
    const hook = path.join(setup.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    expect(await setup.ship()).toBe(1);
    expect(setup.err.at(-1)).toBe('The commit failed, so nothing was shipped.');
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('1');
    expect(runOf(setup.project, podId)?.shippedAt).toBeUndefined();
    expect(runOf(setup.project, podId)?.claim).toBe('claimed');
    expect((await setup.tickets.get('3')).status).toBe('building');
    expect(events(setup.root).at(-1)).toMatchObject({
      type: 'ship.end',
      result: 'fail',
    });
  });

  it("never sets a tracker's ticket done before its commit exists", async () => {
    const updates: string[] = [];
    const failing = await setUp({ tracker: updates });
    change(failing.root);
    const hook = path.join(failing.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    expect(await failing.ship()).toBe(1);
    expect(updates).toEqual([]);

    const passing = await setUp({ tracker: updates });
    change(passing.root);

    expect(await passing.ship()).toBe(0);
    expect(updates).toEqual(['3 done']);
    expect(git(passing.root, ['log', '--format=%s', '-1'])).toBe(
      '3: Trail markers'
    );
  });

  it('refuses when nothing changed but the ticket file pick-up wrote', async () => {
    const setup = await setUp();

    expect(await setup.ship()).toBe(1);
    expect(setup.err).toEqual(["Nothing changed, so there's nothing to ship."]);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('1');
    expect((await setup.tickets.get('3')).status).toBe('building');
  });

  it('commits a title literally, never through a shell', async () => {
    const title = 'Fix "quotes" $(touch pwned)';
    const setup = await setUp({ title });
    change(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(git(setup.root, ['log', '--format=%s', '-1'])).toBe(`3: ${title}`);
    expect(fs.existsSync(path.join(setup.root, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });

  it('reports ship.start, a stage per part and ship.end, tagged with the ticket and attempt', async () => {
    const setup = await setUp({ config: { commands: { test: 'npm test' } } });
    change(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(
      events(setup.root).map((event) => [
        event.type,
        event.name ?? null,
        event.ticket,
        event.attempt,
      ])
    ).toEqual([
      ['ship.start', null, '3', 1],
      ['stage.start', 'test', '3', 1],
      ['stage.end', 'test', '3', 1],
      ['stage.start', 'commit', '3', 1],
      ['stage.end', 'commit', '3', 1],
      ['ship.end', null, '3', 1],
    ]);
  });

  it('never commits the verdicts or the manager folder', async () => {
    const setup = await setUp();
    const manager = path.join(setup.root, '.lambda', 'managers', 'parks-1a2b');
    fs.mkdirSync(manager, { recursive: true });
    fs.writeFileSync(
      path.join(setup.root, '.lambda', 'managers', '.gitignore'),
      '*\n'
    );
    fs.writeFileSync(
      path.join(manager, 'CLAUDE.md'),
      '# Engineering manager\n'
    );
    change(setup.root);

    expect(await setup.ship()).toBe(0);

    const committed = git(setup.root, ['show', '--name-only', '--format=']);
    expect(committed).not.toContain('.lambda/verdicts');
    expect(committed).not.toContain('.lambda/managers');
    expect(committed).toContain('park-hours.md');
  });

  it('never commits a verdict in a custom verdicts.dir', async () => {
    const setup = await setUp({ config: { verdicts: { dir: 'checks' } } });
    change(setup.root);

    expect(fs.existsSync(path.join(setup.root, 'checks', '3.json'))).toBe(true);
    expect(await setup.ship()).toBe(0);
    expect(git(setup.root, ['show', '--name-only', '--format='])).not.toContain(
      'checks/3.json'
    );
  });
});

describe('lambda ship: a shell call that throws', () => {
  it('still reports the stage and the ship ended, failed, and throws', async () => {
    const setup = await setUp({
      config: { commands: { test: 'npm test' } },
      shellExit: () => {
        throw new Error('spawn sh ENOENT');
      },
    });
    change(setup.root);

    await expect(setup.ship()).rejects.toThrow('spawn sh ENOENT');
    expect(
      events(setup.root).map((event) => [
        event.type,
        event.name ?? null,
        event.result ?? null,
      ])
    ).toEqual([
      ['ship.start', null, null],
      ['stage.start', 'test', null],
      ['stage.end', 'test', 'fail'],
      ['ship.end', null, 'fail'],
    ]);
  });

  it("reports the ship ended, failed, when the codebase's own ship command throws", async () => {
    const setup = await setUp({
      config: { commands: { ship: 'deploy {spec}' } },
      shellExit: () => {
        throw new Error('spawn sh ENOENT');
      },
    });

    await expect(setup.ship()).rejects.toThrow('spawn sh ENOENT');
    expect(
      events(setup.root).map((event) => [event.type, event.result ?? null])
    ).toEqual([
      ['ship.start', null],
      ['ship.end', 'fail'],
    ]);
  });
});

describe('lambda ship after a ticket was blocked mid-build', () => {
  it("commits only the next ticket's work: the blocked one's is set aside in git stash", async () => {
    const setup = await setUp();
    fs.appendFileSync(
      path.join(setup.root, 'TASKS.md'),
      '- [ ] 4: Lot 48 photos\n'
    );
    git(setup.root, ['add', '-A']);
    git(setup.root, ['commit', '-q', '-m', 'ticket 4']);
    await setup.tickets.update('4', { status: 'building' });
    const store = createPodStore(resolvePodsRoot(setup.project));
    const podId = buildingPod(setup.project);
    store.writeBuilding(podId, {
      runs: [
        {
          id: '4',
          title: 'Lot 48 photos',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-23T09:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    fs.writeFileSync(path.join(setup.root, 'lot-48.md'), 'Half the photos.\n');

    await blockTicket({
      store,
      podId,
      ticketId: '4',
      parts: {
        what: 'Lot 48 photos',
        problem: 'The photo storage key is missing',
        options: '1) add the key  2) skip photos',
        recommendation: 'add the key',
      },
      source: setup.tickets,
    });
    change(setup.root);

    expect(await setup.ship()).toBe(0);
    const committed = git(setup.root, ['show', '--name-only', '--format=']);
    expect(committed).toContain('park-hours.md');
    expect(committed).not.toContain('lot-48.md');
    expect(git(setup.root, ['stash', 'list'])).toContain('lambda: 4 blocked');
    expect(
      git(setup.root, [
        'stash',
        'show',
        '--include-untracked',
        '--name-only',
        'stash@{0}',
      ])
    ).toContain('lot-48.md');
    expect(store.readThread(podId).at(-1)?.text).toContain('lambda: 4 blocked');
  });
});

describe('lambda ship: screenshot scenarios the ticket brought', () => {
  const ID = 'PAWNEE-5';
  const NAME = 'trail-closed.scenario.json';
  const TRACKED = `.lambda/scenarios/${NAME}`;
  const setUpTicket = (options: Parameters<typeof setUp>[0] = {}) =>
    setUp({ id: ID, title: 'Trail closed notice', ...options });
  const pendingDir = (root: string) =>
    path.join(root, '.lambda', 'scenarios-pending', ID);
  const trackedFile = (root: string) => path.join(root, TRACKED);
  /** A pre-commit hook that records what was staged, then fails the commit. */
  const failCommitRecordingStaged = (root: string): (() => string[]) => {
    const seen = path.join(root, '.git', 'staged-at-commit.txt');
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(
      hook,
      `#!/bin/sh\ngit diff --cached --name-only > "${seen}"\nexit 1\n`
    );
    fs.chmodSync(hook, 0o755);

    return () =>
      fs
        .readFileSync(seen, 'utf8')
        .split('\n')
        .filter((line) => line !== '');
  };
  const bringScenario = (root: string, text = '{"brought":true}\n') => {
    fs.mkdirSync(pendingDir(root), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda', 'scenarios-pending', '.gitignore'),
      '*\n'
    );
    fs.writeFileSync(path.join(pendingDir(root), NAME), text);
  };
  const committed = (root: string): string[] =>
    git(root, ['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .filter((line) => line !== '');

  it('commits them into the tracked library and removes the pending folder', async () => {
    const setup = await setUpTicket();
    change(setup.root);
    bringScenario(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(git(setup.root, ['log', '--format=%s', '-1'])).toBe(
      `${ID}: Trail closed notice`
    );
    expect(committed(setup.root)).toContain(TRACKED);
    expect(
      committed(setup.root).filter((file) => file.includes('scenarios-pending'))
    ).toEqual([]);
    expect(fs.existsSync(pendingDir(setup.root))).toBe(false);
  });

  it('ships a ticket whose only change is its scenarios', async () => {
    const setup = await setUpTicket();
    bringScenario(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(setup.err).toEqual([]);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('2');
    expect(committed(setup.root)).toContain(TRACKED);
    expect(fs.readFileSync(trackedFile(setup.root), 'utf8')).toBe(
      '{"brought":true}\n'
    );
    expect(fs.existsSync(pendingDir(setup.root))).toBe(false);
    expect((await setup.tickets.get(ID)).status).toBe('done');
  });

  it('ships nothing when its only scenarios are already in the library', async () => {
    const setup = await setUpTicket();
    fs.mkdirSync(path.dirname(trackedFile(setup.root)), { recursive: true });
    fs.writeFileSync(trackedFile(setup.root), '{"library":true}\n');
    git(setup.root, ['add', '-A']);
    git(setup.root, ['commit', '-q', '-m', 'library']);
    bringScenario(setup.root);

    expect(await setup.ship()).toBe(1);
    expect(setup.err).toEqual(["Nothing changed, so there's nothing to ship."]);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('2');
    expect(fs.readFileSync(trackedFile(setup.root), 'utf8')).toBe(
      '{"library":true}\n'
    );
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
  });

  it('leaves a scenario already in the library as it is', async () => {
    const setup = await setUpTicket();
    fs.mkdirSync(path.dirname(trackedFile(setup.root)), { recursive: true });
    fs.writeFileSync(trackedFile(setup.root), '{"library":true}\n');
    git(setup.root, ['add', '-A']);
    git(setup.root, ['commit', '-q', '-m', 'library']);
    change(setup.root);
    bringScenario(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(fs.readFileSync(trackedFile(setup.root), 'utf8')).toBe(
      '{"library":true}\n'
    );
    expect(setup.out).toContain(
      'Scenarios: trail-closed already in the library — left as is'
    );
    expect(fs.existsSync(pendingDir(setup.root))).toBe(false);
  });

  it('takes the added file out again when the tests fail', async () => {
    const setup = await setUpTicket({
      config: { commands: { test: 'pnpm test' } },
      shellExit: () => 1,
    });
    change(setup.root);
    bringScenario(setup.root);

    expect(await setup.ship()).toBe(1);
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('1');
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
  });

  it('moves them in, then takes the added file out again when the commit fails', async () => {
    const setup = await setUpTicket();
    change(setup.root);
    bringScenario(setup.root);
    const stagedAtCommit = failCommitRecordingStaged(setup.root);

    expect(await setup.ship()).toBe(1);
    // Added: staged for the commit, with the ticket's work.
    expect(stagedAtCommit()).toEqual(
      expect.arrayContaining([TRACKED, 'park-hours.md'])
    );
    expect(setup.out).toContain(
      'Scenarios: adding 1 screenshot scenario to the library.'
    );
    // Then removed: neither on disk nor in the index, the pending copy kept.
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
    expect(git(setup.root, ['ls-files', '--', '.lambda/scenarios'])).toBe('');
    expect(git(setup.root, ['status', '--porcelain'])).not.toContain(
      'scenarios/'
    );
    expect(git(setup.root, ['rev-list', '--count', 'main'])).toBe('1');
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
    expect((await setup.tickets.get(ID)).status).toBe('building');
  });

  it('takes the added file out again when the ticket file cannot be marked done', async () => {
    const setup = await setUpTicket();
    change(setup.root);
    bringScenario(setup.root);
    setup.tickets.update = async () => {
      throw new Error('TASKS.md is locked');
    };

    await expect(setup.ship()).rejects.toThrow('TASKS.md is locked');
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
    expect(git(setup.root, ['ls-files', '--', '.lambda/scenarios'])).toBe('');
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
  });

  it('takes the scenario out again when it was the only change and the commit fails', async () => {
    const setup = await setUpTicket();
    bringScenario(setup.root);
    const stagedAtCommit = failCommitRecordingStaged(setup.root);

    expect(await setup.ship()).toBe(1);
    expect(stagedAtCommit()).toContain(TRACKED);
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
    expect(git(setup.root, ['ls-files', '--', '.lambda/scenarios'])).toBe('');
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
  });

  it("sets the ticket back and takes the added file out when the commit fails and git can't unstage it", async () => {
    const setup = await setUpTicket();
    change(setup.root);
    bringScenario(setup.root);
    // The hook fails the commit and leaves an index git can't read, so the
    // `git rm --cached` that unstages the scenario fails too.
    const hook = path.join(setup.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nprintf broken > "${path.join(
        setup.root,
        '.git',
        'index'
      )}"\nexit 1\n`
    );
    fs.chmodSync(hook, 0o755);

    expect(await setup.ship()).toBe(1);
    expect((await setup.tickets.get(ID)).status).toBe('building');
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
    expect(setup.err.join('\n')).toMatch(/couldn't unstage/);
    expect(setup.err.at(-1)).toBe('The commit failed, so nothing was shipped.');
  });

  it('takes the added file out again when `git add` fails', async () => {
    const setup = await setUpTicket();
    change(setup.root);
    bringScenario(setup.root);
    // Another git holds the index: `git status` still reads it, `git add` can't.
    fs.writeFileSync(path.join(setup.root, '.git', 'index.lock'), '');

    await expect(setup.ship()).rejects.toThrow(/index\.lock/);
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
    expect((await setup.tickets.get(ID)).status).toBe('building');
  });

  it("leaves the pending folder to a project's own ship command", async () => {
    const setup = await setUpTicket({
      config: { commands: { ship: 'pnpm release {spec}' } },
    });
    bringScenario(setup.root);

    expect(await setup.ship()).toBe(0);
    expect(fs.existsSync(path.join(pendingDir(setup.root), NAME))).toBe(true);
    expect(fs.existsSync(trackedFile(setup.root))).toBe(false);
  });
});
