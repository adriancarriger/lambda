import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import type { LambdaInfo } from '../../app/shared/types';
import { type Db, openDb } from '../db';
import { addWaitingPod, adoptWaitingPod, claimWaitingPods } from '../pods';
import { addRunner, linkProject } from '../registry';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  podSnapshot,
  startHarness,
  tempHome,
} from './harness';

const NOW = Date.UTC(2026, 9, 21, 12);
const SWEETUMS = '/home/leslie/sweetums';
const INTAKE = { text: 'Nougat tracker', freeform: false, single: false };

const podNews = (runners: FakeRunner[]): number =>
  runners.flatMap((runner) =>
    runner.received.filter((message) => message.type === 'pod-new')
  ).length;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A waiting pod starts on exactly one computer, and a start that fails is
 * logged and held back rather than lost or resent at once.
 */
describe('starting a waiting pod', () => {
  const fixture: { harness?: Harness; runners: FakeRunner[] } = {
    runners: [],
  };
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.runners = [];
  });

  afterEach(async () => {
    await Promise.all(fixture.runners.map((runner) => runner.close()));
    await harness().close();
  });

  const connect = async (name: string): Promise<FakeRunner> => {
    const runner = await connectRunner(harness(), { name });
    await runner.next('owner');
    fixture.runners = [...fixture.runners, runner];

    return runner;
  };

  /** Both runners hold both projects; the pod waits for Sweetums. */
  const askWhileBusy = async (runners: FakeRunner[]): Promise<string> => {
    const sweetums = runners.reduce<string>((_, runner) => {
      holdProject(harness(), runner.runnerId, { name: 'Pawnee Parks site' });

      return holdProject(harness(), runner.runnerId, {
        name: 'Sweetums recipe app',
        folder: SWEETUMS,
        current: false,
      });
    }, '');
    const response = await harness().request('POST', '/api/pods/new', {
      cookie: harness().signIn(),
      body: JSON.stringify({ text: 'Nougat tracker', projectId: sweetums }),
    });
    expect(String(response.json().result)).toMatch(/^waiting:/);

    return sweetums;
  };

  const moveTo = (runner: FakeRunner, projectId: string): void => {
    harness()
      .db.prepare('UPDATE runners SET current_project_id = ? WHERE id = ?')
      .run(projectId, runner.runnerId);
  };

  it('goes to one runner when two on its project are idle at once', async () => {
    const macbook = await connect("Leslie's MacBook");
    const mini = await connect("Leslie's Mac mini");
    const answer = (podId: string) => async () => {
      await pause(50);

      return podId;
    };
    macbook.on('pod-new', answer('nougat-macbook'));
    mini.on('pod-new', answer('nougat-mini'));
    const sweetums = await askWhileBusy([macbook, mini]);
    moveTo(macbook, sweetums);
    moveTo(mini, sweetums);

    await harness().mothership.tick();

    expect(podNews([macbook, mini])).toBe(1);
  });

  it('logs a start that fails, naming the computer and project, and waits before trying again', async () => {
    const macbook = await connect("Leslie's MacBook");
    macbook.on('pod-new', () => {
      throw new Error('lambda pod new exited 1');
    });
    const sweetums = await askWhileBusy([macbook]);
    moveTo(macbook, sweetums);

    await harness().mothership.tick();
    await eventually(() =>
      harness().logs.some(
        (line) =>
          line.includes("Leslie's MacBook") &&
          line.includes('Sweetums recipe app') &&
          line.includes('lambda pod new exited 1')
      )
    );
    expect(podNews([macbook])).toBe(1);
    const state = await harness().request('GET', '/api/state', {
      cookie: harness().signIn(),
    });
    const body: { lambda: LambdaInfo } = JSON.parse(state.text);
    expect(body.lambda.waiting).toEqual([
      expect.objectContaining({
        failure: {
          error: expect.stringContaining('lambda pod new exited 1'),
          retryAt: new Date(harness().clock.now + 5 * 60_000).toISOString(),
        },
      }),
    ]);

    // A start that timed out may still have made the pod: not resent at once.
    await harness().mothership.tick();
    expect(podNews([macbook])).toBe(1);

    harness().clock.now += 10 * 60_000;
    await harness().mothership.tick();
    expect(podNews([macbook])).toBe(2);
    // Its refusal settles before the harness closes the database.
    expect(
      harness().logs.filter((line) => line.includes('lambda pod new exited 1'))
    ).toHaveLength(2);
  });

  it('releases a claim a stopped mothership left behind, and starts it after the retry delay', async () => {
    const macbook = await connect("Leslie's MacBook");
    macbook.on('pod-new', () => 'nougat-macbook');
    const sweetums = holdProject(harness(), macbook.runnerId, {
      name: 'Sweetums recipe app',
      folder: SWEETUMS,
    });
    // The last mothership claimed it for the MacBook, then stopped before
    // the start came back: nothing in this one is starting it.
    const waitingId = addWaitingPod(
      harness().db,
      sweetums,
      INTAKE,
      harness().clock.now
    );
    claimWaitingPods(
      harness().db,
      macbook.runnerId,
      [waitingId],
      harness().clock.now - 60_000
    );
    const claimOf = () =>
      harness()
        .db.prepare<[string], { runner_id: string | null }>(
          'SELECT runner_id FROM pods WHERE id = ?'
        )
        .get(waitingId)?.runner_id;

    await harness().mothership.tick();

    expect(claimOf()).toBeNull();
    // It may have started before the stop: held back, not resent at once.
    expect(podNews([macbook])).toBe(0);

    harness().clock.now += 10 * 60_000;
    await harness().mothership.tick();

    expect(podNews([macbook])).toBe(1);
  });

  it('counts a project with no pods as idle only from when its computer arrived on it', async () => {
    const macbook = await connect("Leslie's MacBook");
    macbook.on('pod-new', () => 'nougat-macbook');
    holdProject(harness(), macbook.runnerId, { name: 'Pawnee Parks site' });
    const sweetums = holdProject(harness(), macbook.runnerId, {
      name: 'Sweetums recipe app',
      folder: SWEETUMS,
      current: false,
    });
    const arrivedAt = harness().clock.now - 4 * 60_000;
    macbook.send({
      type: 'runner-state',
      id: 'arrived',
      folder: '/home/leslie/pawnee-parks',
      arrivedAt,
    });
    await eventually(() =>
      macbook.received.some(
        (message) => message.type === 'result' && message.id === 'arrived'
      )
    );
    addWaitingPod(harness().db, sweetums, INTAKE, harness().clock.now);

    await harness().mothership.tick();

    // On Pawnee Parks for 4 minutes, with nothing in it yet: not idle enough.
    expect(podNews([macbook])).toBe(0);

    harness().clock.now = arrivedAt + 5 * 60_000 + 1;
    await harness().mothership.tick();

    expect(podNews([macbook])).toBe(1);
  });

  it('logs an idle switch that fails, with no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.splice(rejections.length, 0, reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      const macbook = await connect("Leslie's MacBook");
      await askWhileBusy([macbook]);
      // Asked while the MacBook is on Pawnee Parks: the pod waits, and the
      // switch it kicks off fails.
      const spy = jest
        .spyOn(harness().mothership.relay, 'connected')
        .mockImplementation(() => {
          throw new Error('Pawnee power outage');
        });

      try {
        await harness().request('POST', '/api/pods/new', {
          cookie: harness().signIn(),
          body: JSON.stringify({ text: 'Harvest festival' }),
        });
        await eventually(() =>
          harness().logs.some((line) => line.includes('Pawnee power outage'))
        );
      } finally {
        spy.mockRestore();
      }

      await pause(20);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('logs an audio focus the pod’s computer refused', async () => {
    const macbook = await connect("Leslie's MacBook");
    holdProject(harness(), macbook.runnerId, { name: 'Pawnee Parks site' });
    macbook.on('pod-action', () => {
      throw new Error('no such pod');
    });
    macbook.send({
      type: 'pod-state',
      id: 'state-1',
      folder: '/home/leslie/pawnee-parks',
      pods: [podSnapshot('dog-park')],
      removed: [],
      all: ['dog-park'],
    });
    await eventually(
      () =>
        harness()
          .db.prepare('SELECT id FROM pods WHERE id = ?')
          .get('dog-park') !== undefined
    );

    const response = await harness().request('POST', '/api/focus', {
      cookie: harness().signIn(),
      body: JSON.stringify({ podId: 'dog-park' }),
    });

    expect(response.status).toBe(200);
    await eventually(() =>
      harness().logs.some(
        (line) => line.includes('dog-park') && line.includes('no such pod')
      )
    );
  });
});

describe('adopting a waiting row', () => {
  const fixture: { home?: string; db?: Db } = {};
  const db = (): Db => required(fixture.db, 'db');

  beforeEach(() => {
    fixture.home = tempHome();
    fixture.db = openDb(path.join(fixture.home, 'mothership.db'));
    addRunner(
      db(),
      { id: 'rnr_mini', name: "Leslie's Mac mini", publicKey: 'unused' },
      NOW
    );
  });

  afterEach(() => {
    fixture.db?.close();
    fs.rmSync(required(fixture.home, 'home'), { recursive: true, force: true });
  });

  it('keeps a pod’s own row when the waiting row was already taken', () => {
    const projectId = linkProject(
      db(),
      { runnerId: 'rnr_mini', name: 'Sweetums recipe app', folder: SWEETUMS },
      NOW
    );
    const waitingId = addWaitingPod(db(), projectId, INTAKE, NOW);
    adoptWaitingPod(db(), waitingId, 'nougat-macbook', 'rnr_macbook', NOW);
    db()
      .prepare(
        'INSERT INTO pods (id, project_id, runner_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        'nougat-mini',
        projectId,
        'rnr_mini',
        JSON.stringify(podSnapshot('nougat-mini')),
        NOW
      );

    adoptWaitingPod(db(), waitingId, 'nougat-mini', 'rnr_mini', NOW);

    const ids = db()
      .prepare<[], { id: string }>('SELECT id FROM pods ORDER BY id')
      .all()
      .map((row) => row.id);
    expect(ids).toEqual(['nougat-macbook', 'nougat-mini']);
  });
});
