import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Project, ProjectConfigSchema } from '../../config/projectConfig';
import { forwardToProjectCli } from '../forward';

const tmpProject = (config: object): Project => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-forward-'))
  );

  return {
    root,
    file: path.join(root, 'lambda.json'),
    config: ProjectConfigSchema.parse(config),
  };
};

const script = (file: string, source: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(file, 0o755);

  return file;
};

/** Writes its argv and LAMBDA_FORWARDED to $PAWNEE_OUT, then exits 3. */
const RECORDS_ARGV = `
require('fs').writeFileSync(
  process.env.PAWNEE_OUT,
  JSON.stringify({ argv: process.argv.slice(2), forwarded: process.env.LAMBDA_FORWARDED })
);
process.exit(3);
`;

const readOut = (file: string): { argv: string[]; forwarded: string } =>
  JSON.parse(fs.readFileSync(file, 'utf8'));

const waitFor = async (file: string): Promise<void> => {
  const deadline = Date.now() + 10_000;

  const poll = async (): Promise<void> => {
    if (fs.existsSync(file)) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${file}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    return poll();
  };

  return poll();
};

describe('forwarding to the codebase CLI', () => {
  it('passes the argv untouched and returns the exit code', async () => {
    const project = tmpProject({ cli: './scripts/cli.sh' });
    script(path.join(project.root, 'scripts', 'cli.sh'), RECORDS_ARGV);
    const sub = path.join(project.root, 'sub');
    fs.mkdirSync(sub);
    const out = path.join(project.root, 'out.json');

    const result = await forwardToProjectCli({
      args: ['log', '-1', '--flag', 'a b'],
      project,
      cwd: sub,
      env: { ...process.env, PAWNEE_OUT: out },
    });

    expect(result).toEqual({ code: 3 });
    expect(readOut(out)).toEqual({
      argv: ['log', '-1', '--flag', 'a b'],
      forwarded: '1',
    });
  });

  it('exits 127 when the CLI is not there', async () => {
    const project = tmpProject({ cli: './scripts/missing.sh' });

    expect(
      await forwardToProjectCli({ args: ['log'], project, env: process.env })
    ).toEqual({
      code: 127,
      message: 'Project CLI "./scripts/missing.sh" not found.',
    });
  });

  it('passes SIGINT on and exits 130 when the child dies of it', async () => {
    const project = tmpProject({ cli: './scripts/trap.sh' });
    const ready = path.join(project.root, 'ready');
    const marker = path.join(project.root, 'got-sigint');
    script(
      path.join(project.root, 'scripts', 'trap.sh'),
      `
const fs = require('fs');
process.on('SIGINT', () => {
  fs.writeFileSync(${JSON.stringify(marker)}, 'yes');
  process.removeAllListeners('SIGINT');
  process.kill(process.pid, 'SIGINT');
});
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
setInterval(() => {}, 1000);
`
    );
    const signals = new EventEmitter();

    const running = forwardToProjectCli({
      args: ['serve'],
      project,
      env: process.env,
      signals,
    });
    await waitFor(ready);
    signals.emit('SIGINT');

    expect(await running).toEqual({ code: 130 });
    expect(fs.existsSync(marker)).toBe(true);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
});

describe('cli: "lambda"', () => {
  it("runs the codebase's own bin/lambda", async () => {
    const project = tmpProject({ cli: 'lambda' });
    script(path.join(project.root, 'bin', 'lambda'), RECORDS_ARGV);
    const out = path.join(project.root, 'out.json');

    const result = await forwardToProjectCli({
      args: ['log'],
      project,
      env: { ...process.env, PAWNEE_OUT: out },
      runningBinary: '/usr/local/bin/lambda',
    });

    expect(result).toEqual({ code: 3 });
    expect(readOut(out).argv).toEqual(['log']);
  });

  it('refuses to run itself', async () => {
    const project = tmpProject({ cli: 'lambda' });
    const self = script(path.join(project.root, 'bin', 'lambda'), RECORDS_ARGV);

    expect(
      await forwardToProjectCli({
        args: ['log'],
        project,
        env: process.env,
        runningBinary: self,
      })
    ).toEqual({
      code: 1,
      message:
        'Project CLI "lambda" is this lambda. Set "cli" in lambda.json to your project\'s own command.',
    });
  });

  it('refuses itself when started through a symlink', async () => {
    const project = tmpProject({ cli: 'lambda' });
    const self = script(path.join(project.root, 'bin', 'lambda'), RECORDS_ARGV);
    const link = path.join(project.root, 'linked-lambda');
    fs.symlinkSync(self, link);

    expect(
      await forwardToProjectCli({
        args: ['log'],
        project,
        env: process.env,
        runningBinary: link,
      })
    ).toMatchObject({ code: 1 });
  });

  it('falls back to node_modules/.bin/lambda when bin/lambda is itself', async () => {
    const project = tmpProject({ cli: 'lambda' });
    const self = script(path.join(project.root, 'bin', 'lambda'), RECORDS_ARGV);
    script(
      path.join(project.root, 'node_modules', '.bin', 'lambda'),
      RECORDS_ARGV
    );
    const out = path.join(project.root, 'out.json');

    expect(
      await forwardToProjectCli({
        args: ['log'],
        project,
        env: { ...process.env, PAWNEE_OUT: out },
        runningBinary: self,
      })
    ).toEqual({ code: 3 });
    expect(readOut(out).argv).toEqual(['log']);
  });

  it('refuses a second hop', async () => {
    const project = tmpProject({ cli: 'lambda' });
    script(path.join(project.root, 'bin', 'lambda'), RECORDS_ARGV);
    const out = path.join(project.root, 'out.json');

    expect(
      await forwardToProjectCli({
        args: ['log'],
        project,
        env: { ...process.env, PAWNEE_OUT: out, LAMBDA_FORWARDED: '1' },
      })
    ).toEqual({
      code: 1,
      message: 'Already forwarded once; refusing to forward "log" again.',
    });
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('no cli set', () => {
  it('says the command is unknown and how to set one', async () => {
    const result = await forwardToProjectCli({
      args: ['log', '-1'],
      project: tmpProject({}),
      env: process.env,
    });

    expect(result).toEqual({
      code: 1,
      message: [
        'Unknown command "log".',
        "Run lambda init to set a codebase CLI, or lambda doctor to see what's available.",
      ].join('\n'),
    });
  });
});
