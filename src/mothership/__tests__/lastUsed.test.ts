import { required } from '../../__tests__/required';
import { HOST_RUNNER_SECRET } from '../server';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  startHarness,
} from './harness';

/**
 * The last project used is the one a pod was last created in — linking a
 * folder, adding a project or making one doesn't count as using it.
 */
describe('the last project used', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    await runner().next('owner');
    harness()
      .db.prepare('INSERT INTO secrets (name, value) VALUES (?, ?)')
      .run(HOST_RUNNER_SECRET, runner().runnerId);
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  const lastUsedAt = (name: string): number | undefined =>
    harness()
      .db.prepare<[string], { last_used_at: number }>(
        'SELECT last_used_at FROM projects WHERE name = ?'
      )
      .get(name)?.last_used_at;

  it('is not moved by linking, adding or making a project', async () => {
    holdProject(harness(), runner().runnerId, { name: 'Pawnee Parks site' });
    runner().send({
      type: 'project-link',
      id: 'ln1',
      name: 'Eagleton site',
      folder: '/home/leslie/eagleton',
    });
    runner().on('project-add', () => ({
      name: 'Sweetums recipe app',
      folder: '/home/leslie/sweetums',
    }));
    runner().on('project-new', () => ({
      name: 'Bench donations',
      folder: '/home/leslie/Lambda/bench-donations',
    }));
    const cookie = harness().signIn();
    harness().clock.now += 60_000;

    await eventually(() => lastUsedAt('Eagleton site') !== undefined);
    await harness().request('POST', '/api/projects/add', {
      cookie,
      body: JSON.stringify({ folder: '/home/leslie/sweetums' }),
    });
    await harness().request('POST', '/api/projects/new', {
      cookie,
      body: JSON.stringify({ name: 'Bench donations' }),
    });

    expect(
      [
        'Pawnee Parks site',
        'Eagleton site',
        'Sweetums recipe app',
        'Bench donations',
      ].map(lastUsedAt)
    ).toEqual([0, 0, 0, 0]);
  });

  it('is moved by a pod created in the project, sent or waiting', async () => {
    const pawnee = holdProject(harness(), runner().runnerId, {
      name: 'Pawnee Parks site',
    });
    const sweetums = holdProject(harness(), runner().runnerId, {
      name: 'Sweetums recipe app',
      folder: '/home/leslie/sweetums',
      current: false,
    });
    runner().on('pod-new', () => 'dog-park');
    const cookie = harness().signIn();
    const newPod = (projectId: string) =>
      harness().request('POST', '/api/pods/new', {
        cookie,
        body: JSON.stringify({ text: 'A map of dog parks', projectId }),
      });

    harness().clock.now += 60_000;
    await newPod(pawnee);

    expect(lastUsedAt('Pawnee Parks site')).toBe(harness().clock.now);
    expect(lastUsedAt('Sweetums recipe app')).toBe(0);

    harness().clock.now += 60_000;
    // Its computer is on Pawnee Parks site: this one waits, and counts.
    await newPod(sweetums);

    expect(lastUsedAt('Sweetums recipe app')).toBe(harness().clock.now);
  });

  it('is not moved by a pod that failed to start', async () => {
    const pawnee = holdProject(harness(), runner().runnerId, {
      name: 'Pawnee Parks site',
    });
    runner().on('pod-new', () => {
      throw new Error('no worktree');
    });
    harness().clock.now += 60_000;

    const response = await harness().request('POST', '/api/pods/new', {
      cookie: harness().signIn(),
      body: JSON.stringify({ text: 'A map of dog parks', projectId: pawnee }),
    });

    expect(response.status).toBe(400);
    expect(lastUsedAt('Pawnee Parks site')).toBe(0);
  });
});
