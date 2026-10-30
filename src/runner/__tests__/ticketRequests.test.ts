import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SummaryRun } from '../../app/server/ticketSummary';
import {
  buildingPodStore,
  fakeSource,
  ticket,
} from '../../building/__tests__/fakes';
import type { PodStore, Question } from '../../pod-store';
import { createMarkdownSource } from '../../tickets/markdown';
import type { TicketSource } from '../../tickets/source';
import { recordVerdict } from '../../verdict/store';
import type { LambdaCli } from '../podHost';
import {
  commitFiles,
  createTicketRequests,
  shippedCommits,
  ticketTalk,
} from '../ticketRequests';

/**
 * The runner's Tickets answers: the source's tickets plus the ones only a
 * planning pod's checkpoint names, a ticket's page, and the two requests
 * that run `lambda` for the app.
 */

type Row = NonNullable<
  NonNullable<Question['checkpoint']>['planTickets']
>[number];

const made: { root: string; store: PodStore }[] = [];

const project = () => {
  const one = buildingPodStore();
  fs.writeFileSync(
    path.join(one.root, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks app' })
  );
  made.splice(made.length, 0, one);

  return one;
};

/** A planning pod whose checkpoint (at `createdAt`) plans `rows`. */
const planningPod = (
  store: PodStore,
  podId: string,
  title: string,
  checkpoints: { id: string; createdAt: string; rows: Row[] }[]
): void => {
  store.writePod({
    id: podId,
    slug: 'plan',
    title,
    createdAt: '2026-10-20T10:00:00.000Z',
    status: 'active',
    phase: 3,
    completedCheckpoints: [],
    worktreePath: '/tmp/plan',
    ownsWorktree: false,
    managerCwd: '/tmp/plan',
    devCwd: '/tmp/plan',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  });
  checkpoints.forEach((checkpoint) =>
    store.writeQuestion({
      id: checkpoint.id,
      podId,
      kind: 'checkpoint',
      phase: 3,
      status: 'answered',
      blocksCheckpoint: true,
      dependsOn: [],
      createdAt: checkpoint.createdAt,
      options: [],
      checkpoint: { cp: 3, decisionIds: [], planTickets: checkpoint.rows },
    })
  );
};

const noLambda: LambdaCli = async () => {
  throw new Error('lambda was not expected to run');
};

const failingSummary: SummaryRun = async () => ({ exitCode: 1, stdout: '' });

const requests = (
  source: TicketSource = fakeSource([ticket('1'), ticket('2')]),
  lambda: LambdaCli = noLambda,
  log: (line: string) => void = () => undefined
) =>
  createTicketRequests({
    lambda,
    log,
    openSource: () => source,
    summaryRun: () => failingSummary,
  });

beforeEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
});

afterEach(() => {
  made
    .splice(0)
    .forEach(({ root }) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('list', () => {
  it("adds a planned ticket the source lacks once, as the pod's, and never repeats one the source has", async () => {
    const { root, store } = project();
    planningPod(store, 'plan-a1b2', 'Trail markers', [
      {
        id: 'q1',
        createdAt: '2026-10-20T11:00:00.000Z',
        rows: [
          { id: '2', title: 'Already in the source' },
          { id: '9', title: 'Lot 48 photos' },
        ],
      },
    ]);

    const { tickets } = await requests().list({
      type: 'tickets',
      folder: root,
      projectId: 'p1',
    });

    expect(tickets.map((one) => [one.id, one.source])).toEqual([
      ['1', 'markdown'],
      ['2', 'markdown'],
      ['9', 'pod'],
    ]);
    expect(tickets[2]).toMatchObject({
      title: 'Lot 48 photos',
      status: 'planning',
      podId: 'plan-a1b2',
      projectId: 'p1',
    });
  });

  it('takes the latest checkpoint when two plan the same ticket', async () => {
    const { root, store } = project();
    planningPod(store, 'plan-a1b2', 'Trail markers', [
      // Ids and write order both run against time: only createdAt decides.
      {
        id: 'q1',
        createdAt: '2026-10-21T11:00:00.000Z',
        rows: [{ id: '9', title: 'Lot 48 photos, final' }],
      },
      {
        id: 'q2',
        createdAt: '2026-10-20T11:00:00.000Z',
        rows: [{ id: '9', title: 'Lot 48 photos, draft' }],
      },
    ]);

    const { tickets } = await requests().list({
      type: 'tickets',
      folder: root,
      projectId: 'p1',
    });

    expect(tickets.filter((one) => one.id === '9')).toEqual([
      expect.objectContaining({ title: 'Lot 48 photos, final' }),
    ]);
  });

  it('takes the latest checkpoint across pods, not the last pod listed', async () => {
    const { root, store } = project();
    planningPod(store, 'plan-a1b2', 'Trail markers', [
      {
        id: 'q1',
        createdAt: '2026-10-21T11:00:00.000Z',
        rows: [{ id: '9', title: 'Lot 48 photos, replanned' }],
      },
    ]);
    planningPod(store, 'plan-z9y8', 'Harvest festival', [
      {
        id: 'q1',
        createdAt: '2026-10-20T11:00:00.000Z',
        rows: [{ id: '9', title: 'Lot 48 photos, first plan' }],
      },
    ]);

    const { tickets } = await requests().list({
      type: 'tickets',
      folder: root,
      projectId: 'p1',
    });

    expect(tickets.filter((one) => one.id === '9')).toEqual([
      expect.objectContaining({
        title: 'Lot 48 photos, replanned',
        podId: 'plan-a1b2',
      }),
    ]);
  });

  it("skips a pod whose pod.json can't be read, logs it, and lists the rest", async () => {
    const { root, store } = project();
    planningPod(store, 'plan-a1b2', 'Trail markers', [
      {
        id: 'q1',
        createdAt: '2026-10-20T11:00:00.000Z',
        rows: [{ id: '9', title: 'Lot 48 photos' }],
      },
    ]);
    fs.mkdirSync(path.join(store.root, 'plan-0000'));
    fs.writeFileSync(path.join(store.root, 'plan-0000', 'pod.json'), '{ nope');
    const logged: string[] = [];

    const { tickets } = await requests(undefined, noLambda, (line) =>
      logged.splice(logged.length, 0, line)
    ).list({ type: 'tickets', folder: root, projectId: 'p1' });

    expect(tickets.map((one) => one.id)).toEqual(['1', '2', '9']);
    expect(logged.some((line) => line.includes('plan-0000'))).toBe(true);
  });

  it('refuses a request with no folder', async () => {
    await expect(
      requests().list({ type: 'tickets', projectId: 'p1' })
    ).rejects.toThrow('Missing "folder"');
  });
});

describe('get', () => {
  it("names the pod that planned it, its planned summary and the ticket's verdict", async () => {
    const { root, store } = project();
    planningPod(store, 'plan-a1b2', 'Trail markers', [
      {
        id: 'q1',
        createdAt: '2026-10-20T11:00:00.000Z',
        rows: [
          {
            id: '1',
            title: 'Park hours',
            name: '1 - Park hours page',
            today: 'Hours are on a PDF.',
            after: 'Hours are on the page.',
          },
        ],
      },
    ]);
    recordVerdict(root, {
      ticketId: '1',
      verdict: 'COMPLETE',
      failedDimensions: [],
      deviations: [],
      recordedAt: '2026-10-23T10:00:00.000Z',
    });

    const page = await requests().get({
      type: 'ticket',
      folder: root,
      projectId: 'p1',
      ticketId: '1',
    });

    expect(page.plannedIn).toEqual({
      podId: 'plan-a1b2',
      title: 'Trail markers',
    });
    expect(page.verdict).toBe('COMPLETE');
    expect(page.summary).toEqual({
      state: 'ready',
      name: '1 - Park hours page',
      today: 'Hours are on a PDF.',
      after: 'Hours are on the page.',
    });
    expect(page.ticket).toMatchObject({
      id: '1',
      description: 'What ticket 1 does.',
    });
  });

  it('answers no pod and no verdict for a ticket nothing planned or checked', async () => {
    const { root } = project();

    const page = await requests().get({
      type: 'ticket',
      folder: root,
      projectId: 'p1',
      ticketId: '2',
    });

    expect(page.plannedIn).toBeNull();
    expect(page.verdict).toBeNull();
  });

  it("logs to the runner why a ticket's summary couldn't be written", async () => {
    const { root } = project();
    const logged: string[] = [];

    await requests(undefined, noLambda, (line) =>
      logged.splice(logged.length, 0, line)
    ).get({ type: 'ticket', folder: root, projectId: 'p1', ticketId: '2' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logged).toEqual(['No summary for 2: it exited 1']);
  });

  it('opens a ticket only a planning pod has, from its checkpoint', async () => {
    const { root, store } = project();
    planningPod(store, 'plan-a1b2', 'Trail markers', [
      {
        id: 'q1',
        createdAt: '2026-10-20T11:00:00.000Z',
        rows: [
          {
            id: '9',
            title: 'Lot 48 photos',
            today: 'Lot 48 has no photos.',
            after: 'Lot 48 has photos.',
          },
        ],
      },
    ]);

    const page = await requests().get({
      type: 'ticket',
      folder: root,
      projectId: 'p1',
      ticketId: '9',
    });

    expect(page.ticket).toMatchObject({
      id: '9',
      title: 'Lot 48 photos',
      status: 'planning',
      source: 'pod',
      podId: 'plan-a1b2',
      url: null,
    });
    expect(page.summary).toEqual({
      state: 'ready',
      name: 'Lot 48 photos',
      today: 'Lot 48 has no photos.',
      after: 'Lot 48 has photos.',
    });
    expect(page.plannedIn).toEqual({
      podId: 'plan-a1b2',
      title: 'Trail markers',
    });
  });

  it('still refuses a ticket neither the source nor a pod has', async () => {
    const { root } = project();

    await expect(
      requests().get({
        type: 'ticket',
        folder: root,
        projectId: 'p1',
        ticketId: '9',
      })
    ).rejects.toThrow("9 isn't a ticket I can read.");
  });
});

describe('talk', () => {
  it("runs talk-ticket with the owner's words after --, and answers its last line's JSON", async () => {
    const { root } = project();
    const calls: { args: string[]; cwd: string }[] = [];
    const lambda: LambdaCli = async (args, options) => {
      calls.splice(calls.length, 0, { args, cwd: options.cwd });

      return 'Talking about 3\n{"podId":"talk-3-a1b2"}';
    };

    await expect(
      requests(undefined, lambda).talk({
        type: 'talk',
        folder: root,
        ticketId: '3',
        text: '--help; why did the test fail?',
      })
    ).resolves.toEqual({ podId: 'talk-3-a1b2' });
    expect(calls).toEqual([
      {
        args: [
          'pod',
          'talk-ticket',
          '3',
          '--',
          '--help; why did the test fail?',
        ],
        cwd: root,
      },
    ]);
  });

  it("names what lambda said when its answer isn't JSON", async () => {
    const lambda: LambdaCli = async () => 'There is no ticket 3.';

    await expect(
      requests(undefined, lambda).talk({
        type: 'talk',
        folder: '/tmp/x',
        ticketId: '3',
        text: 'hi',
      })
    ).rejects.toThrow('lambda pod talk-ticket said: There is no ticket 3.');
  });

  it('refuses a request with no text, before running anything', async () => {
    await expect(
      requests().talk({ type: 'talk', folder: '/tmp/x', ticketId: '3' })
    ).rejects.toThrow('Missing "text"');
  });
});

describe('startBuilding', () => {
  it("builds for the mothership's project id, in the codebase's folder", async () => {
    const ran: { args: string[]; cwd: string }[] = [];
    const lambda: LambdaCli = async (args, options) => {
      ran.splice(ran.length, 0, { args, cwd: options.cwd });

      return 'Created Lambda build-c3d4';
    };

    await requests(undefined, lambda).startBuilding({
      type: 'building-start',
      folder: '/tmp/pawnee',
      projectId: 'prj_pawnee',
    });

    expect(ran).toEqual([
      {
        args: ['pod', 'build', '--project-id', 'prj_pawnee'],
        cwd: '/tmp/pawnee',
      },
    ]);
  });

  it('makes the pod paused when the mothership asks for it paused', async () => {
    const ran: string[][] = [];
    const lambda: LambdaCli = async (args) => {
      ran.splice(ran.length, 0, args);

      return 'Created Lambda build-c3d4 (paused: it takes no ticket until resumed)';
    };

    await expect(
      requests(undefined, lambda).startBuilding({
        type: 'building-start',
        folder: '/tmp/pawnee',
        projectId: 'prj_pawnee',
        paused: true,
      })
    ).resolves.toBe('build-c3d4');
    expect(ran).toEqual([
      ['pod', 'build', '--project-id', 'prj_pawnee', '--paused'],
    ]);
  });

  it('refuses a request with no project id, before running anything', async () => {
    await expect(
      requests().startBuilding({ type: 'building-start', folder: '/tmp/x' })
    ).rejects.toThrow('Missing "projectId"');
  });

  it('answers the pod lambda pod build made', async () => {
    const lambda: LambdaCli = async () =>
      'Writing settings\nCreated Lambda build-c3d4\nLaunching';

    await expect(
      requests(undefined, lambda).startBuilding({
        type: 'start-building',
        folder: '/tmp/x',
        projectId: 'prj_pawnee',
      })
    ).resolves.toBe('build-c3d4');
  });

  it("refuses with lambda's own words when it made no pod", async () => {
    const lambda: LambdaCli = async () =>
      "Leslie's Mac is already building Bakery site.\n";

    await expect(
      requests(undefined, lambda).startBuilding({
        type: 'start-building',
        folder: '/tmp/x',
        projectId: 'prj_pawnee',
      })
    ).rejects.toThrow("Leslie's Mac is already building Bakery site.");
  });

  it('says it made no pod when lambda said nothing', async () => {
    const lambda: LambdaCli = async () => '  \n';

    await expect(
      requests(undefined, lambda).startBuilding({
        type: 'start-building',
        folder: '/tmp/x',
        projectId: 'prj_pawnee',
      })
    ).rejects.toThrow('lambda pod build made no pod.');
  });
});

describe("the Tickets screen's edits", () => {
  const markdownProject = (tasks: string) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-edits-'))
    );
    fs.writeFileSync(path.join(root, 'TASKS.md'), tasks);
    const source = createMarkdownSource({
      root,
      config: { source: 'markdown', prefix: 'PAWNEE' },
      tokens: undefined,
      env: {},
      fetch: () => {
        throw new Error('No network');
      },
      runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
    });

    return { root, source, edits: requests(source) };
  };
  const TOP = [
    '- [ ] PAWNEE-1: Park map page',
    '- [ ] PAWNEE-2: Volunteer sign-up form',
    '- [ ] PAWNEE-3: Contact page',
    '',
  ].join('\n');

  it('changes priority, computer and status, and answers with the ticket after', async () => {
    const { edits } = markdownProject(TOP);
    const after = await edits.update({
      type: 'ticket-update',
      folder: '/unused',
      projectId: 'prj_1',
      ticketId: 'PAWNEE-2',
      changes: {
        priority: 'high',
        assignee: "Leslie's MacBook Pro",
        status: 'blocked',
      },
    });

    expect(after).toMatchObject({
      id: 'PAWNEE-2',
      priority: 'high',
      assignee: "Leslie's MacBook Pro",
      status: 'blocked',
    });
  });

  it('refuses Building and Shipped, and any status change on a ticket the build has', async () => {
    const { edits, source } = markdownProject(TOP);
    const update = (ticketId: string, status: 'building' | 'ready') =>
      edits.update({
        type: 'ticket-update',
        folder: '/unused',
        projectId: 'prj_1',
        ticketId,
        changes: { status },
      });

    await expect(update('PAWNEE-1', 'building')).rejects.toThrow(
      'set by the build'
    );
    await source.update('PAWNEE-1', { status: 'building' });
    await expect(update('PAWNEE-1', 'ready')).rejects.toThrow(
      'set by the build'
    );
  });

  it('creates a ticket, refusing one with no title', async () => {
    const { edits } = markdownProject(TOP);
    const made = await edits.create({
      type: 'ticket-create',
      folder: '/unused',
      projectId: 'prj_1',
      ticket: { title: ' Harvest festival ', priority: 'urgent' },
    });

    expect(made).toMatchObject({
      id: 'PAWNEE-4',
      title: 'Harvest festival',
      priority: 'urgent',
      status: 'inbox',
    });
    await expect(
      edits.create({
        type: 'ticket-create',
        folder: '/unused',
        projectId: 'prj_1',
        ticket: { title: '  ' },
      })
    ).rejects.toThrow('needs a title');
  });

  it('moves a ticket after another, and to the top', async () => {
    const { edits, source } = markdownProject(TOP);
    const order = async () => (await source.list()).map((one) => one.id);

    await edits.move({
      type: 'ticket-move',
      folder: '/unused',
      ticketId: 'PAWNEE-1',
      after: 'PAWNEE-2',
    });
    expect(await order()).toEqual(['PAWNEE-2', 'PAWNEE-1', 'PAWNEE-3']);

    await edits.move({
      type: 'ticket-move',
      folder: '/unused',
      ticketId: 'PAWNEE-3',
      after: null,
    });
    expect(await order()).toEqual(['PAWNEE-3', 'PAWNEE-2', 'PAWNEE-1']);
  });
});

describe("a ticket's conversation on its page", () => {
  it('collects each question about the ticket and the answers after it, in any pod', () => {
    const { store } = project();
    // A one-shot Product manager's pod, for a second conversation.
    planningPod(store, 'talk-c3d4', 'PAWNEE-2', []);
    const say = (
      podId: string,
      id: string,
      from: 'human' | 'product-manager' | 'engineering-manager',
      text: string,
      at: string
    ) =>
      store.appendThread({
        id,
        podId,
        from,
        mode: 'async',
        text,
        createdAt: at,
      });

    say(
      'build-a1b2',
      'm1',
      'human',
      'About ticket PAWNEE-2 Park map: is Ramsett closed?',
      '2026-10-26T10:00:00.000Z'
    );
    say(
      'build-a1b2',
      'm2',
      'product-manager',
      'Yes: marked closed, as the ticket says.',
      '2026-10-26T10:01:00.000Z'
    );
    say(
      'build-a1b2',
      'm3',
      'engineering-manager',
      'picked up PAWNEE-3',
      '2026-10-26T10:02:00.000Z'
    );
    say(
      'build-a1b2',
      'm4',
      'human',
      'About ticket PAWNEE-3 Contact page: who owns it?',
      '2026-10-26T10:03:00.000Z'
    );
    say(
      'build-a1b2',
      'm5',
      'product-manager',
      'Ann does.',
      '2026-10-26T10:04:00.000Z'
    );
    say(
      'talk-c3d4',
      'm6',
      'human',
      'About ticket PAWNEE-2: and the pins?',
      '2026-10-26T10:05:00.000Z'
    );
    say(
      'talk-c3d4',
      'm7',
      'product-manager',
      'One per park.',
      '2026-10-26T10:06:00.000Z'
    );

    expect(
      ticketTalk(store, { id: 'PAWNEE-2', title: 'Park map' }).map(
        (one) => `${one.from}: ${one.text}`
      )
    ).toEqual([
      'you: is Ramsett closed?',
      'product-manager: Yes: marked closed, as the ticket says.',
      'you: and the pins?',
      'product-manager: One per park.',
    ]);
  });
});

describe("a shipped ticket's commit", () => {
  it('finds the latest commit for each ticket and the files it changed', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-shipped-'))
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Leslie Knope',
          GIT_AUTHOR_EMAIL: 'leslie@pawnee.gov',
          GIT_COMMITTER_NAME: 'Leslie Knope',
          GIT_COMMITTER_EMAIL: 'leslie@pawnee.gov',
        },
        stdio: 'ignore',
      });
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'hello.txt'), 'Hello, Pawnee\n');
    git('add', 'hello.txt');
    git('commit', '-q', '-m', 'PAWNEE-1: Add hello.txt');

    const hash = shippedCommits(root).get('PAWNEE-1');

    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(commitFiles(root, hash ?? '')).toEqual({
      hash,
      files: [{ path: 'hello.txt', added: 1, removed: 0 }],
    });
    expect(commitFiles(root, 'not a hash')).toBeNull();
  });
});

describe('Plan more', () => {
  it('sends the tickets back to Planning, resumes the planning pod and queues the ask', async () => {
    const { root, store } = project();
    planningPod(store, 'plan-c3d4', 'Trail markers', []);
    const source = fakeSource([
      ticket('PAWNEE-4', { status: 'ready' }),
      ticket('PAWNEE-5', { status: 'building' }),
    ]);
    const ran: string[][] = [];
    const lambda: LambdaCli = async (args) => {
      ran.splice(ran.length, 0, args);

      return '';
    };

    await requests(source, lambda).planMore({
      type: 'plan-more',
      folder: root,
      podId: 'plan-c3d4',
      ticketIds: ['PAWNEE-4', 'PAWNEE-5'],
      text: 'Add Saturday hours too.',
    });

    // A ticket the build has stays as it is.
    expect((await source.get('PAWNEE-4')).status).toBe('planning');
    expect((await source.get('PAWNEE-5')).status).toBe('building');
    expect(ran).toEqual([
      ['pod', 'resume', 'plan-c3d4'],
      [
        'pod',
        'request',
        'add',
        '--pod',
        'plan-c3d4',
        '--quote',
        'Add Saturday hours too.',
        '--',
        'Plan more on PAWNEE-4, PAWNEE-5: Add Saturday hours too.',
      ],
    ]);
  });

  it('refuses when the planning pod is gone', async () => {
    const { root } = project();

    await expect(
      requests().planMore({
        type: 'plan-more',
        folder: root,
        podId: 'plan-gone',
        ticketIds: [],
        text: 'More, please.',
      })
    ).rejects.toThrow('is gone');
  });
});
