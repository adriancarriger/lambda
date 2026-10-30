import { required } from '../../__tests__/required';
import { findComputer } from '../computers';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  startHarness,
} from './harness';

/**
 * `lambda computer <name> <action>`: the mothership finds the computer by
 * name and passes one fixed read to its runner.
 */
describe('finding a computer by name', () => {
  const runners = [
    { id: 'rnr_ann', name: 'Ann’s laptop' },
    { id: 'rnr_leslie', name: "Leslie's Mac mini" },
    { id: 'rnr_leslie2', name: "Leslie's iMac" },
  ];

  it('takes its id, its name as typed, or the one name it starts', () => {
    expect(findComputer(runners, 'rnr_leslie2')?.name).toBe("Leslie's iMac");
    // macOS writes a curly apostrophe; nobody types one.
    expect(findComputer(runners, "ann's laptop")?.id).toBe('rnr_ann');
    expect(findComputer(runners, 'ann')?.id).toBe('rnr_ann');
  });

  it('answers none when a name could be either of two, or is empty', () => {
    expect(findComputer(runners, 'leslie')).toBeNull();
    expect(findComputer(runners, '')).toBeNull();
    expect(findComputer(runners, 'tom')).toBeNull();
  });
});

describe('GET /api/computers/diagnose', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner; cookie?: string } =
    {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const cookie = (): string => required(fixture.cookie, 'cookie');

  beforeEach(async () => {
    fixture.harness = await startHarness({ timeoutMs: 200 });
    fixture.runner = await connectRunner(harness(), { name: 'Ann’s laptop' });
    await runner().next('owner');
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  it("passes the read to that computer's runner and answers what it says", async () => {
    runner().on('diagnose', (message) => ({
      action: message.action,
      podId: message.podId,
    }));

    const response = await harness().request(
      'GET',
      '/api/computers/diagnose?computer=ann&action=pod&podId=build-3f2c',
      { cookie: cookie() }
    );

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ action: 'pod', podId: 'build-3f2c' });
  });

  it('answers 404 for a computer it has no runner for', async () => {
    const response = await harness().request(
      'GET',
      '/api/computers/diagnose?computer=tom&action=status',
      { cookie: cookie() }
    );

    expect(response.status).toBe(404);
    expect(response.json().error).toBe('No computer tom');
  });

  it('needs a session, like every other /api/ route', async () => {
    const response = await harness().request(
      'GET',
      '/api/computers/diagnose?computer=ann&action=status'
    );

    expect(response.status).toBe(401);
  });
});
