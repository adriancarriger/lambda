import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type InitOptions, runInit } from '../index';

const tmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** No global or system git config, so no git name or email leaks in. */
const isolatedEnv = (lambdaHome: string): NodeJS.ProcessEnv => ({
  ...process.env,
  LAMBDA_HOME: lambdaHome,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

const setup = (files: Record<string, string> = {}, folder = 'pawnee-app') => {
  const cwd = path.join(tmp('lambda-init-'), folder);
  fs.mkdirSync(cwd);
  Object.entries(files).forEach(([file, text]) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  });
  const home = path.join(tmp('lambda-home-'), 'lambda');
  const run = (options: Partial<InitOptions> = {}) =>
    runInit({ cwd, env: isolatedEnv(home), ...options });
  const written = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(cwd, 'lambda.json'), 'utf8'));
  const machineFile = path.join(home, 'config.json');

  return { cwd, home, run, written, machineFile };
};

const pkg = (json: object): string => JSON.stringify(json);

const couldntTell = (output: string[]): string[] => {
  const start = output.indexOf("Couldn't tell");

  return start === -1
    ? []
    : output
        .slice(start + 1, output.indexOf('', start))
        .map((line) => line.trim().split(/\s+/)[0] ?? '');
};

describe('lambda init: what it finds', () => {
  it('reads a Next app', () => {
    const { run, written } = setup({
      'package.json': pkg({
        name: 'pawnee-parks-app',
        scripts: { dev: 'next dev' },
        dependencies: { next: '15.0.0' },
      }),
    });

    run({ name: 'Leslie Knope' });

    expect(written()).toMatchObject({
      app: { start: 'pnpm dev', url: 'http://localhost:3000' },
    });
  });

  it("reads a Vite app's explicit port", () => {
    const { run, written } = setup({
      'package.json': pkg({
        scripts: { dev: 'vite --port 4000' },
        devDependencies: { vite: '6.0.0' },
      }),
    });

    run({ name: 'Leslie Knope' });

    expect(written()).toMatchObject({ app: { url: 'http://localhost:4000' } });
  });

  it('falls back to start, and leaves the url out with no framework', () => {
    const { run, written } = setup({
      'package.json': pkg({ scripts: { start: 'node server.js' } }),
    });

    const { output } = run({ name: 'Leslie Knope' });

    expect(written()).toEqual({
      app: { start: 'pnpm start' },
      tickets: { source: 'markdown' },
    });
    expect(couldntTell(output)).toContain('app.url');
  });

  it('reads the open-source layout', () => {
    const { run, written } = setup({
      'bin/lambda': '#!/usr/bin/env node\n',
      'TASKS.md': '# Tasks\n',
      'CLAUDE.md': '# Pawnee\n',
    });

    const { output } = run({ name: 'Leslie Knope' });

    expect(written()).toMatchObject({
      cli: './bin/lambda',
      instructions: ['CLAUDE.md'],
    });
    expect(output.join('\n')).toContain('markdown (TASKS.md)');
  });

  it('leaves cli out when package.json has more than one bin', () => {
    const { run, written } = setup({
      'package.json': pkg({ bin: { a: 'x.js', b: 'y.js' } }),
    });

    const { output } = run({ name: 'Leslie Knope' });

    expect(written()).not.toHaveProperty('cli');
    expect(couldntTell(output)).toContain('cli');
  });

  it('writes only the ticket source for an empty folder', () => {
    const { run, cwd } = setup();

    const { output } = run({ name: 'Leslie Knope' });

    expect(fs.readFileSync(path.join(cwd, 'lambda.json'), 'utf8')).toBe(
      `${JSON.stringify({ tickets: { source: 'markdown' } }, null, 2)}\n`
    );
    expect(couldntTell(output)).toEqual(
      expect.arrayContaining(['app.start', 'app.url', 'cli'])
    );
  });

  it("starts with package.json's name, else the folder's", () => {
    expect(
      setup({ 'package.json': pkg({ name: 'pawnee-parks-app' }) }).run({
        name: 'Leslie Knope',
      }).output[0]
    ).toBe('pawnee-parks-app');
    expect(
      setup({}, 'eagleton-app').run({ name: 'Leslie Knope' }).output[0]
    ).toBe('eagleton-app');
  });
});

describe('lambda init: an existing lambda.json', () => {
  it('refuses without --force and leaves the file alone', () => {
    const { run, cwd } = setup({ 'lambda.json': '{ "cli": "git" }\n' });

    const result = run({ name: 'Leslie Knope' });

    expect(result.code).toBe(1);
    expect(result.error).toBe(
      'lambda.json already exists. Use --force to replace it.'
    );
    expect(fs.readFileSync(path.join(cwd, 'lambda.json'), 'utf8')).toBe(
      '{ "cli": "git" }\n'
    );
  });

  it('replaces it with --force', () => {
    const { run, written } = setup({ 'lambda.json': '{ "cli": "git" }\n' });

    expect(run({ force: true, name: 'Leslie Knope' }).code).toBe(0);
    expect(written()).toEqual({ tickets: { source: 'markdown' } });
  });

  it('writes nothing with --dry-run', () => {
    const { run, cwd, machineFile } = setup();

    const { output, code } = run({ dryRun: true, name: 'Leslie Knope' });

    expect(code).toBe(0);
    expect(output.join('\n')).toContain('"source": "markdown"');
    expect(fs.existsSync(path.join(cwd, 'lambda.json'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.lambda', '.gitignore'))).toBe(false);
    expect(fs.existsSync(machineFile)).toBe(false);
  });
});

describe('lambda init: .lambda/.gitignore', () => {
  const lines = ['pods/', 'pulled/', 'events.jsonl', 'agent-log.jsonl'];

  const countLines = (file: string): Record<string, number> =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .reduce<Record<string, number>>(
        (counts, line) => ({ ...counts, [line]: (counts[line] ?? 0) + 1 }),
        {}
      );

  it('writes each line once, across runs, keeping lines already there', () => {
    const { run, cwd } = setup({
      '.lambda/.gitignore': 'pods/\nnode_modules/\n',
      '.gitignore': 'dist/\n',
    });
    const file = path.join(cwd, '.lambda', '.gitignore');

    run({ name: 'Leslie Knope' });
    run({ force: true, name: 'Leslie Knope' });

    const counts = countLines(file);
    lines.forEach((line) => expect(counts[line]).toBe(1));
    expect(counts['node_modules/']).toBe(1);
    expect(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'dist/\n'
    );
  });

  it('keeps the existing text as it is and appends only what is missing', () => {
    const { run, cwd } = setup({
      '.lambda/.gitignore': '# Pawnee\r\npods/\r\n\r\nnode_modules/',
    });
    const file = path.join(cwd, '.lambda', '.gitignore');

    run({ name: 'Leslie Knope' });

    expect(fs.readFileSync(file, 'utf8')).toBe(
      '# Pawnee\r\npods/\r\n\r\nnode_modules/\npulled/\nevents.jsonl\nagent-log.jsonl\n'
    );
  });
});

describe('lambda init: the machine file', () => {
  it('skips it with no --name and no git name, and says how to set one', () => {
    const { run, cwd, machineFile } = setup();

    const { output } = run();

    expect(fs.existsSync(path.join(cwd, 'lambda.json'))).toBe(true);
    expect(fs.existsSync(machineFile)).toBe(false);
    expect(output.join('\n')).toMatch(
      /owner\.name\s+run lambda init --name "<your name>"/
    );
  });

  it('never overwrites an existing machine file', () => {
    const { run, machineFile } = setup();

    run({ name: 'Leslie Knope' });
    const before = fs.readFileSync(machineFile);
    run({ force: true, name: 'Ben Wyatt' });

    expect(JSON.parse(before.toString()).owner.name).toBe('Leslie Knope');
    expect(fs.readFileSync(machineFile)).toEqual(before);
  });

  it('takes the email from --email, else git, else leaves it out', () => {
    const fromFlag = setup();
    fromFlag.run({ name: 'Leslie Knope', email: 'leslie@pawnee.gov' });

    expect(
      JSON.parse(fs.readFileSync(fromFlag.machineFile, 'utf8')).owner
    ).toEqual({ name: 'Leslie Knope', email: 'leslie@pawnee.gov' });

    const fromGit = setup();
    execFileSync('git', ['init', '-q'], {
      cwd: fromGit.cwd,
      env: isolatedEnv(fromGit.home),
    });
    execFileSync('git', ['config', 'user.email', 'leslie@pawnee.gov'], {
      cwd: fromGit.cwd,
      env: isolatedEnv(fromGit.home),
    });
    fromGit.run({ name: 'Leslie Knope' });

    expect(
      JSON.parse(fs.readFileSync(fromGit.machineFile, 'utf8')).owner.email
    ).toBe('leslie@pawnee.gov');

    const without = setup();
    const { output } = without.run({ name: 'Leslie Knope' });

    expect(
      JSON.parse(fs.readFileSync(without.machineFile, 'utf8')).owner
    ).not.toHaveProperty('email');
    expect(couldntTell(output)).not.toContain('owner.email');
  });
});
