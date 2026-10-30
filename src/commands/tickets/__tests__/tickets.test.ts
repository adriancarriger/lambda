import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import { type TicketsDeps, registerTicketsCommand } from '..';
import { ProjectConfigSchema } from '../../../config/projectConfig';
import { type Question } from '../../../pod-store/schemas';
import { createPodStore } from '../../../pod-store/store';
import { createTicketSource } from '../../../tickets/context';

const TASKS = [
  '- [ ] PAWNEE-1: Park map page',
  '  - [x] PAWNEE-1a: Map tiles',
  '  - [ ] PAWNEE-1b: Pins for each park',
  '- [B] PAWNEE-2: Volunteer sign-up form (blocked: Ann Perkins is out)',
  '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
  '',
].join('\n');

const setUp = (
  tasks: string,
  files: Record<string, string> = {},
  env: Record<string, string> = {},
  podStore: TicketsDeps['podStore'] = () => {
    throw new Error('No pod store in this test.');
  }
) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tickets-cli-'))
  );
  fs.writeFileSync(path.join(root, 'TASKS.md'), tasks);
  Object.entries(files).forEach(([file, text]) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  });
  const config = ProjectConfigSchema.parse({
    name: 'Pawnee Parks app',
    tickets: { source: 'markdown', prefix: 'PAWNEE' },
  });
  const printed: string[] = [];
  const deps: TicketsDeps = {
    project: { root, file: path.join(root, 'lambda.json'), config },
    machine: { owner: { name: 'Leslie' } },
    source: createTicketSource({
      root,
      config: config.tickets,
      tokens: undefined,
      env: {},
      fetch: globalThis.fetch,
      runner: { name: 'Leslie Knope' },
    }),
    env,
    podStore,
    readStdin: () => 'Fill the pit.',
    print: (text) => {
      printed.splice(printed.length, 0, text);
    },
  };
  const program = new Command().exitOverride();
  registerTicketsCommand(program, () => deps);

  const run = (...args: string[]) =>
    program.parseAsync(['node', 'lambda', 'tickets', ...args]);

  return {
    root,
    deps,
    printed,
    run,
    /**
     * The exit code `lambda` would give, as `run` in cli.ts works it out:
     * `process.exitCode` when the command finishes, 1 when it throws.
     */
    exitCode: (...args: string[]): Promise<number> =>
      run(...args).then(
        () => Number(process.exitCode ?? 0),
        () => 1
      ),
  };
};

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** A pod store with one answered question and one open one. */
const podStoreWith = (): TicketsDeps['podStore'] => {
  const store = createPodStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tickets-pod-'))
  );
  const question = (id: string, status: Question['status']): Question => ({
    id,
    podId: 'pawnee-a1b2',
    kind: 'question',
    phase: 3,
    status,
    blocksCheckpoint: false,
    dependsOn: [],
    createdAt: '2026-10-10T00:00:00.000Z',
    options: [],
  });
  store.writeQuestion(question('q1', 'answered'));
  store.writeQuestion(question('q2', 'open'));

  return () => store;
};

describe('lambda tickets', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('lists the queue with Lambda states and block reasons', async () => {
    const cli = setUp(TASKS, {
      'tickets/PAWNEE-1.md': '---\nstatus: building\n---\n# Park map page\n',
      'tickets/PAWNEE-3.md': '---\nstatus: planning\n---\n# Lot 48\n',
    });
    await cli.run('list');

    expect(cli.printed.join('\n').split('\n')).toEqual([
      'Pawnee Parks app · markdown (TASKS.md)',
      '  PAWNEE-1   Park map page             building',
      '    PAWNEE-1a  Map tiles               done',
      '    PAWNEE-1b  Pins for each park      ready',
      '  PAWNEE-2   Volunteer sign-up form    blocked',
      '             (blocked: Ann Perkins is out)',
      '  PAWNEE-3   Lot 48 pit photo gallery  planning',
    ]);
  });

  it('prints the next ticket, or says none is ready', async () => {
    const ready = setUp(TASKS);
    await ready.run('next');

    expect(ready.printed).toEqual(['PAWNEE-1b  Pins for each park']);

    const none = setUp('- [x] PAWNEE-1: Park map page\n');

    expect(await none.exitCode('next')).toBe(0);
    expect(none.printed).toEqual(['No ticket is ready.']);
  });

  it('prints the ticket shape with --json', async () => {
    const cli = setUp(TASKS);
    await cli.run('get', 'PAWNEE-2', '--json');

    expect(JSON.parse(cli.printed[0] ?? '')).toEqual({
      id: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
      status: 'blocked',
      labels: [],
      parent: null,
      children: [],
      blockedBy: [],
      blockReason: 'Ann Perkins is out',
      reporter: null,
      url: null,
      priority: 'none',
      assignee: null,
      project: null,
      updatedAt: null,
      description: '',
    });
  });

  it('prints list and next as the ticket shape with --json', async () => {
    const cli = setUp(TASKS);
    await cli.run('list', '--json');
    await cli.run('next', '--json');

    const [list, next] = cli.printed.map((text): unknown => JSON.parse(text));

    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(list)
        .map((ticket) => ticket.id)
    ).toEqual(['PAWNEE-1', 'PAWNEE-1a', 'PAWNEE-1b', 'PAWNEE-2', 'PAWNEE-3']);
    expect(next).toEqual({
      id: 'PAWNEE-1b',
      title: 'Pins for each park',
      status: 'ready',
      labels: [],
      parent: 'PAWNEE-1',
      children: [],
      blockedBy: [],
      blockReason: null,
      reporter: null,
      url: null,
      priority: 'none',
      assignee: null,
      project: null,
      updatedAt: null,
    });

    const none = setUp('- [x] PAWNEE-1: Park map page\n');
    await none.run('next', '--json');

    expect(none.printed).toEqual(['null']);
  });

  it('prints get as "<id>  <title>  <status>", then the description', async () => {
    const cli = setUp(TASKS, {
      'tickets/PAWNEE-3.md':
        '# Lot 48 pit photo gallery\n\nPhotos of the pit, before Ann fills it.\n',
    });
    await cli.run('get', 'PAWNEE-3');

    expect(cli.printed).toEqual([
      'PAWNEE-3  Lot 48 pit photo gallery  ready\n\nPhotos of the pit, before Ann fills it.',
    ]);
  });

  it("doesn't gate update --status blocked inside a pod: it's a state, not a dependency", async () => {
    const cli = setUp(TASKS, {}, { POD_ID: 'pawnee-a1b2' });
    await cli.run(
      'update',
      'PAWNEE-3',
      '--status',
      'blocked',
      '--reason',
      'Ann Perkins is out'
    );

    expect(cli.printed).toEqual([
      'PAWNEE-3  Lot 48 pit photo gallery  blocked',
    ]);
    expect(fs.readFileSync(path.join(cli.root, 'TASKS.md'), 'utf8')).toContain(
      '- [B] PAWNEE-3: Lot 48 pit photo gallery (blocked: Ann Perkins is out)'
    );
  });

  it('creates from stdin and prints the new id', async () => {
    const cli = setUp(TASKS);
    await cli.run('create', '--title', 'Lot 48', '--description-stdin');

    expect(cli.printed).toEqual(['PAWNEE-4']);
    expect(
      fs.readFileSync(path.join(cli.root, 'tickets', 'PAWNEE-4.md'), 'utf8')
    ).toContain('# Lot 48\n\nFill the pit.');
  });

  it('refuses a title or reason that spans lines before any source sees it', async () => {
    const cli = setUp(TASKS);
    const create = jest.spyOn(cli.deps.source, 'create');
    const update = jest.spyOn(cli.deps.source, 'update');

    await expect(
      cli.run('create', '--title', 'Real title\n- [x] PAWNEE-99: Fake')
    ).rejects.toThrow("--title can't span lines.");
    await expect(
      cli.run('update', 'PAWNEE-3', '--title', 'Lot 48\r\npit')
    ).rejects.toThrow("--title can't span lines.");
    // A fresh program: commander keeps the last run's --title.
    const again = setUp(TASKS);
    const updateAgain = jest.spyOn(again.deps.source, 'update');

    await expect(
      again.run(
        'update',
        'PAWNEE-3',
        '--status',
        'blocked',
        '--reason',
        "Waiting on Ann.\nShe's back Monday."
      )
    ).rejects.toThrow("--reason can't span lines.");
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateAgain).not.toHaveBeenCalled();
    expect(read(path.join(again.root, 'TASKS.md'))).toBe(TASKS);
    expect(read(path.join(cli.root, 'TASKS.md'))).toBe(TASKS);
    expect(fs.existsSync(path.join(cli.root, 'tickets'))).toBe(false);
  });

  it("refuses a status that isn't one of Lambda's", async () => {
    const cli = setUp(TASKS);

    await expect(
      cli.run('update', 'PAWNEE-3', '--status', 'todo')
    ).rejects.toThrow(
      '"todo" isn\'t a status. Use one of: inbox, planning, ready, building, blocked, done, canceled.'
    );
  });

  it('gates block inside a pod, and says markdown has nothing to push', async () => {
    const pod = setUp(TASKS, {}, { POD_ID: 'pawnee-a1b2' });

    await expect(
      pod.run('block', 'PAWNEE-3', '--by', 'PAWNEE-1')
    ).rejects.toThrow('A pod changes a dependency only after Leslie says so');

    const cli = setUp(TASKS);
    await cli.run('push', 'PAWNEE-1');

    expect(cli.printed).toEqual([
      'Nothing to push: markdown tickets are already the files.',
    ]);
  });

  it.each([
    [
      ['update', 'PAWNEE-3', '--reason', 'Ann Perkins is out'],
      '--reason goes with --status blocked.',
    ],
    [
      ['update', 'PAWNEE-3', '--status', 'ready', '--reason', 'Fence'],
      '--reason goes with --status blocked.',
    ],
    [
      ['update', 'PAWNEE-3'],
      'Nothing to update: pass --status, --title, --label, --priority or --computer.',
    ],
    [
      ['block', 'PAWNEE-3', '--by', 'PAWNEE-3'],
      "PAWNEE-3 can't be blocked by itself.",
    ],
  ])('refuses %j, exits 1 and writes nothing', async (args, message) => {
    const cli = setUp(TASKS);

    await expect(cli.run(...args)).rejects.toThrow(message);
    expect(await cli.exitCode(...args)).toBe(1);
    expect(read(path.join(cli.root, 'TASKS.md'))).toBe(TASKS);
    expect(fs.existsSync(path.join(cli.root, 'tickets'))).toBe(false);
    expect(cli.printed).toEqual([]);
  });

  it('gates unblock inside a pod, and lets it through on an answered question', async () => {
    const files = {
      'tickets/PAWNEE-3.md': '---\nblockedBy: [PAWNEE-1]\n---\n# Lot 48\n',
    };
    const cli = setUp(TASKS, files, { POD_ID: 'pawnee-a1b2' }, podStoreWith());
    const ticketFile = path.join(cli.root, 'tickets', 'PAWNEE-3.md');

    expect(await cli.exitCode('unblock', 'PAWNEE-3', '--by', 'PAWNEE-1')).toBe(
      1
    );
    await expect(
      cli.run('unblock', 'PAWNEE-3', '--by', 'PAWNEE-1', '--qid', 'q2')
    ).rejects.toThrow("q2 is open — Leslie hasn't answered it yet.");
    expect(read(ticketFile)).toBe(files['tickets/PAWNEE-3.md']);

    expect(
      await cli.exitCode(
        'unblock',
        'PAWNEE-3',
        '--by',
        'PAWNEE-1',
        '--qid',
        'q1'
      )
    ).toBe(0);
    expect(cli.printed).toEqual(['PAWNEE-3 is no longer blocked by PAWNEE-1.']);
    expect(read(ticketFile)).toBe('# Lot 48\n');
  });
});

describe('lambda tickets: priority and computer', () => {
  it('sets priority and the computer, and none unassigns', async () => {
    const cli = setUp(TASKS);
    await cli.run(
      'update',
      'PAWNEE-3',
      '--priority',
      'high',
      '--computer',
      "Leslie's MacBook Pro"
    );
    await cli.run('get', 'PAWNEE-3', '--json');

    expect(JSON.parse(cli.printed.at(-1) ?? '')).toMatchObject({
      priority: 'high',
      assignee: "Leslie's MacBook Pro",
    });

    await cli.run('update', 'PAWNEE-3', '--computer', 'none');
    await cli.run('get', 'PAWNEE-3', '--json');

    expect(JSON.parse(cli.printed.at(-1) ?? '').assignee).toBeNull();
  });

  it('refuses a priority it does not know', async () => {
    const cli = setUp(TASKS);

    await expect(
      cli.run('update', 'PAWNEE-3', '--priority', 'someday')
    ).rejects.toThrow("isn't a priority");
  });
});
