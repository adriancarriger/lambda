import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadMachineConfig,
  machineConfigPath,
  writeMachineConfig,
} from '../../config/machineConfig';
import { TYPE_URL } from './canvasFixture';
import { runDesign } from './runDesign';

describe('lambda design capability', () => {
  const home = { saved: process.env.LAMBDA_HOME };

  beforeEach(() => {
    process.env.LAMBDA_HOME = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lambda-design-home-')
    );
  });

  afterEach(() => {
    if (home.saved === undefined) {
      delete process.env.LAMBDA_HOME;
    } else {
      process.env.LAMBDA_HOME = home.saved;
    }
  });

  it('prints unknown when nothing was checked', async () => {
    expect(await runDesign(['capability'])).toMatchObject({
      code: 0,
      out: 'unknown',
    });
  });

  it('records available with the type url, and prints it', async () => {
    writeMachineConfig({ owner: { name: 'Leslie Knope' } });
    const set = await runDesign([
      'capability',
      '--set',
      'available',
      '--type-url',
      TYPE_URL,
    ]);

    expect(set.code).toBe(0);
    expect(await runDesign(['capability'])).toMatchObject({
      code: 0,
      out: `available ${TYPE_URL}`,
    });

    const config = loadMachineConfig();
    expect(config?.owner?.name).toBe('Leslie Knope');
    expect(config?.design).toMatchObject({
      available: true,
      typeUrl: TYPE_URL,
    });
    expect(Number.isNaN(Date.parse(config?.design?.checkedAt ?? ''))).toBe(
      false
    );
  });

  it('refuses a type url that is not a claude.ai artifact, leaving the config unchanged', async () => {
    writeMachineConfig({ owner: { name: 'Leslie Knope' } });
    const before = fs.readFileSync(machineConfigPath(), 'utf8');
    const result = await runDesign([
      'capability',
      '--set',
      'available',
      '--type-url',
      'https://example.com/x',
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('https://example.com/x');
    expect(fs.readFileSync(machineConfigPath(), 'utf8')).toBe(before);
  });

  it('records unavailable with its reason, and prints it', async () => {
    await runDesign([
      'capability',
      '--set',
      'unavailable',
      '--reason',
      'no Artifact tool',
    ]);

    expect(await runDesign(['capability'])).toMatchObject({
      code: 0,
      out: 'unavailable no Artifact tool',
    });
    expect(loadMachineConfig()?.design).toMatchObject({
      available: false,
      reason: 'no Artifact tool',
    });
  });

  it.each([
    [['--set', 'available'], '--type-url'],
    [['--set', 'unavailable'], '--reason'],
    [['--set', 'maybe'], 'available or unavailable'],
  ])('refuses %j, writing nothing', async (args, message) => {
    const result = await runDesign(['capability', ...args]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(fs.existsSync(machineConfigPath())).toBe(false);
  });
});
