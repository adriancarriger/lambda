import { required } from '../../__tests__/required';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  podSnapshot,
  startHarness,
} from './harness';

const SWEETUMS = '/home/leslie/sweetums';

/**
 * A pod asked for while its computer is busy on another project waits as a
 * row of its own; once it starts there, that same row takes the new pod's
 * state (it isn't deleted and replaced).
 */
describe('a waiting pod takes the new pod’s state', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    await runner().next('owner');
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  const row = (where: string, value: string) =>
    harness()
      .db.prepare<
        [string],
        {
          rowid: number;
          id: string;
          runner_id: string | null;
          state_json: string;
        }
      >(`SELECT rowid, id, runner_id, state_json FROM pods WHERE ${where} = ?`)
      .get(value);

  const askWhileBusy = async (): Promise<number> => {
    holdProject(harness(), runner().runnerId, { name: 'Pawnee Parks site' });
    const sweetums = holdProject(harness(), runner().runnerId, {
      name: 'Sweetums recipe app',
      folder: SWEETUMS,
      current: false,
    });
    const response = await harness().request('POST', '/api/pods/new', {
      cookie: harness().signIn(),
      body: JSON.stringify({ text: 'Nougat tracker', projectId: sweetums }),
    });
    const waitingId = String(response.json().result).replace(/^waiting:/, '');

    return required(row('id', waitingId), 'waiting row').rowid;
  };

  const pushState = (podId: string, id: string) =>
    runner().send({
      type: 'pod-state',
      id,
      folder: SWEETUMS,
      pods: [podSnapshot(podId)],
      removed: [],
      all: [podId],
    });

  it('when its first state comes after the runner starts it', async () => {
    runner().on('pod-new', () => 'nougat-tracker');
    const rowid = await askWhileBusy();
    await eventually(() => row('id', 'nougat-tracker') !== undefined);

    expect(row('id', 'nougat-tracker')).toMatchObject({
      rowid,
      runner_id: runner().runnerId,
    });

    pushState('nougat-tracker', 'ps1');
    await eventually(() =>
      required(row('rowid', String(rowid)), 'row').state_json.includes(
        '"podId"'
      )
    );

    expect(
      JSON.parse(required(row('rowid', String(rowid)), 'row').state_json)
    ).toEqual(podSnapshot('nougat-tracker'));
    expect(
      harness().db.prepare('SELECT COUNT(*) AS n FROM pods').get()
    ).toEqual({ n: 1 });
  });

  it('when its first state arrives before the runner answers', async () => {
    runner().on('pod-new', async () => {
      pushState('nougat-tracker', 'ps-early');
      await eventually(() => row('id', 'nougat-tracker') !== undefined);

      return 'nougat-tracker';
    });
    const rowid = await askWhileBusy();
    await eventually(
      () => row('rowid', String(rowid))?.id === 'nougat-tracker'
    );

    expect(
      JSON.parse(required(row('rowid', String(rowid)), 'row').state_json)
    ).toEqual(podSnapshot('nougat-tracker'));
    expect(
      harness().db.prepare('SELECT COUNT(*) AS n FROM pods').get()
    ).toEqual({ n: 1 });
  });
});
