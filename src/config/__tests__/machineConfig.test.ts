import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MachineConfigSchema,
  lambdaHome,
  loadMachineConfig,
  resolveMothershipUrl,
  resolveOwnerName,
  writeMachineConfig,
} from '../machineConfig';

const tmp = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-home-'));

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

const fullConfig = {
  owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
  runner: { id: 'pawnee-mac', keyPath: '/keys/pawnee' },
  mothership: {
    url: 'http://pawnee.local:4400',
    host: 'pawnee.local',
    listen: '100.64.0.2',
    port: 4400,
  },
  tokens: {
    claude: { value: 'claude-pawnee', createdAt: '2026-10-20' },
    linear: 'lin-pawnee',
    jira: { email: 'leslie@pawnee.gov', apiToken: 'jira-pawnee' },
    elevenlabs: 'el-pawnee',
  },
  firstRun: {
    claude: true,
    projects: { '/pawnee': { project: true, tickets: false } },
  },
};

describe('machine config', () => {
  it('never reaches the real ~/.lambda from a test', () => {
    const real = path.join(os.homedir(), '.lambda');

    expect(() => lambdaHome({})).toThrow('real ~/.lambda');
    expect(() => writeMachineConfig({}, {})).toThrow('real ~/.lambda');
    expect(() => loadMachineConfig({})).toThrow('real ~/.lambda');
    // Every test file gets a temp one through process.env.
    expect(lambdaHome()).not.toBe(real);
  });

  it('creates a missing folder 0700 and the file 0600', () => {
    const home = path.join(tmp(), 'lambda');
    const file = writeMachineConfig(
      { owner: { name: 'Leslie Knope' } },
      { LAMBDA_HOME: home }
    );

    expect(mode(home)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  it('leaves an existing folder mode alone and still writes the file 0600', () => {
    const home = path.join(tmp(), 'lambda');
    fs.mkdirSync(home, { mode: 0o755 });
    fs.chmodSync(home, 0o755);
    const file = writeMachineConfig(
      { owner: { name: 'Leslie Knope' } },
      { LAMBDA_HOME: home }
    );

    expect(mode(home)).toBe(0o755);
    expect(mode(file)).toBe(0o600);
  });

  it('names the owner Owner when there is no machine file', () => {
    const config = loadMachineConfig({ LAMBDA_HOME: tmp() });

    expect(config).toBeNull();
    expect(resolveOwnerName(config)).toBe('Owner');
  });

  it('keeps every value of a full example', () => {
    expect(MachineConfigSchema.parse(fullConfig)).toEqual(fullConfig);
  });

  it('rejects a non-boolean firstRun.claude, naming the field', () => {
    const result = MachineConfigSchema.safeParse({
      firstRun: { claude: 'yes', projects: {} },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.join('.')).toBe('firstRun.claude');
  });

  it('fails on a bad owner.name with the file and field', () => {
    const home = tmp();
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ owner: { name: 7 } }));

    expect(() => loadMachineConfig({ LAMBDA_HOME: home })).toThrow(
      `${file}: owner.name expected string`
    );
  });

  it.each([
    '{"tokens":{"claude":{"value": claude-pawnee-secret-123}}}',
    '{"tokens":{"linear":"lin-pawnee-secret" "x"}}',
    '{"tokens":{"linear":"lin-pawnee-secret"',
  ])('never quotes the file in a JSON error: %s', (text) => {
    const home = tmp();
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, text);

    expect(() => loadMachineConfig({ LAMBDA_HOME: home })).toThrow(
      `Invalid JSON in ${file}: `
    );
    expect(() => loadMachineConfig({ LAMBDA_HOME: home })).not.toThrow(
      /pawnee-secret|sk-ant|lin-pawnee/
    );
  });

  it('prefers LAMBDA_URL over mothership.url', () => {
    const config = MachineConfigSchema.parse(fullConfig);

    expect(
      resolveMothershipUrl(config, { LAMBDA_URL: 'http://pawnee.tail:4400' })
    ).toBe('http://pawnee.tail:4400');
    expect(resolveMothershipUrl(config, {})).toBe('http://pawnee.local:4400');
  });
});
