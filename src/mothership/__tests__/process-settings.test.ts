import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { setStepOff } from '../../process/workflow-file';
import {
  readProcessSettings,
  switchProcessStep,
} from '../../runner/processSettings';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  startHarness,
  tempHome,
} from './harness';

/**
 * Settings → Process: the mothership never touches the project folder; the
 * runner holding the project reads and switches through the process loader in
 * its own folder.
 */
describe('Settings → Process', () => {
  const fixture: {
    harness?: Harness;
    runner?: FakeRunner;
    cookie?: string;
    folder?: string;
    projectId?: string;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const cookie = (): string => required(fixture.cookie, 'cookie');
  const folder = (): string => required(fixture.folder, 'folder');
  const projectId = (): string => required(fixture.projectId, 'projectId');

  beforeEach(async () => {
    fixture.folder = tempHome();
    fs.writeFileSync(
      path.join(folder(), 'lambda.json'),
      JSON.stringify({
        name: 'Pawnee Parks site',
        tickets: { source: 'markdown' },
      })
    );
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness(), {
      name: "Leslie's Mac mini",
    });
    await runner().next('owner');
    // The runner's half, as runtime.ts answers these.
    runner().on('process-read', (message) =>
      readProcessSettings(String(message.folder))
    );
    runner().on('process-switch', (message) =>
      switchProcessStep(
        String(message.folder),
        String(message.process),
        String(message.step),
        message.on === true
      )
    );
    fixture.projectId = holdProject(harness(), runner().runnerId, {
      folder: folder(),
    });
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
    fs.rmSync(folder(), { recursive: true, force: true });
  });

  const workflowFile = () =>
    path.join(folder(), '.lambda', 'planning', 'workflow.json');

  const flip = (process: string, step: string, on: boolean) =>
    harness().request('POST', '/api/process/switch', {
      cookie: cookie(),
      body: JSON.stringify({ projectId: projectId(), process, step, on }),
    });

  it('lists switches for optional steps and locks Lambda’s quality steps', async () => {
    const response = await harness().request(
      'GET',
      `/api/process?projectId=${projectId()}`,
      {
        cookie: cookie(),
      }
    );
    const settings = response.json<{
      planning: { steps: { id: string; setting: string }[] }[];
      building: { steps: { id: string; setting: string }[] }[];
    }>();
    const steps = (rows: { steps: { id: string; setting: string }[] }[]) =>
      Object.fromEntries(
        rows.flatMap((row) => row.steps).map((step) => [step.id, step.setting])
      );

    expect(steps(settings.planning)['ux-sketch']).toBe('on');
    expect(steps(settings.building)['check-ticket']).toBe('locked');
  });

  it('switches ux-sketch off and on in the runner’s folder, and refuses check-ticket', async () => {
    const off = await flip('planning', 'ux-sketch', false);

    expect(off.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(workflowFile(), 'utf8'))).toEqual({
      extends: 'standard',
      off: ['ux-sketch'],
    });
    // Not the mothership's own working folder.
    expect(
      fs.existsSync(
        path.join(process.cwd(), '.lambda', 'planning', 'workflow.json')
      )
    ).toBe(false);

    await flip('planning', 'ux-sketch', true);

    expect(JSON.parse(fs.readFileSync(workflowFile(), 'utf8')).off).toEqual([]);

    const before = fs.readFileSync(workflowFile());
    const locked = await flip('building', 'check-ticket', false);

    expect(locked.status).toBe(400);
    // The loader's own refusal, passed through as it is (nothing rebuilt).
    const loaderSays = (() => {
      try {
        setStepOff(folder(), 'building', 'check-ticket', true);

        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(loaderSays).toBe(
      '.lambda/building/workflow.json: off "check-ticket" refused — it\'s one of Lambda\'s quality steps.'
    );
    expect(locked.json().error).toBe(loaderSays);
    expect(
      fs.existsSync(path.join(folder(), '.lambda', 'building', 'workflow.json'))
    ).toBe(false);
    expect(fs.readFileSync(workflowFile())).toEqual(before);
  });

  it('says the computer is offline and writes nothing', async () => {
    const { runnerId } = runner();
    await runner().close();
    await eventually(() => !harness().mothership.relay.isConnected(runnerId));

    const response = await flip('planning', 'ux-sketch', false);

    expect(response.status).toBe(409);
    expect(response.json().error).toBe("Leslie's Mac mini is offline.");
    expect(fs.existsSync(workflowFile())).toBe(false);
  });
});
