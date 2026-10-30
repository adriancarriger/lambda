import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { run } from '../cli';

const write = (file: string, text: string, mode = 0o644): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
};

/** A project whose CLI writes its argv to out.json and exits 3. */
const recordingProject = (): { root: string; out: string } => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-dispatch-'))
  );
  const out = path.join(root, 'out.json');
  write(path.join(root, 'lambda.json'), JSON.stringify({ cli: './cli.js' }));
  write(
    path.join(root, 'cli.js'),
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(
      out
    )}, JSON.stringify(process.argv.slice(2)));
process.exit(3);
`,
    0o755
  );

  return { root, out };
};

describe('dispatch before commander parses', () => {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const logged: string[] = [];
  const errors: string[] = [];

  beforeEach(() => {
    logged.length = 0;
    errors.length = 0;
    delete process.env.LAMBDA_FORWARDED;
    process.env.LAMBDA_HOME = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lambda-home-')
    );
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.splice(logged.length, 0, line);
    });
    jest.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.splice(errors.length, 0, line);
    });
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env = { ...savedEnv };
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it.each([[['help', 'log']], [['-x', 'log']]])(
    'hands %j to the codebase CLI untouched',
    async (args) => {
      const { root, out } = recordingProject();
      process.chdir(root);

      expect(await run(['node', 'lambda', ...args])).toBe(3);
      expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(args);
    }
  );

  it('still runs doctor over a refused doctor drop-in, and lists it', async () => {
    const { root } = recordingProject();
    write(
      path.join(root, '.lambda', 'commands', 'doctor.ts'),
      "throw new Error('the doctor drop-in was loaded');\n"
    );
    process.chdir(root);

    expect(await run(['node', 'lambda', 'doctor'])).toBe(0);
    expect(logged).toContain(
      '  doctor   refused drop-in: .lambda/commands/doctor.ts'
    );
    expect([...logged, ...errors].join('\n')).not.toContain(
      'the doctor drop-in was loaded'
    );
  });

  it('refuses a core-name drop-in without loading it', async () => {
    const { root, out } = recordingProject();
    write(
      path.join(root, '.lambda', 'commands', 'pod.ts'),
      "throw new Error('the pod drop-in was loaded');\n"
    );
    process.chdir(root);

    expect(await run(['node', 'lambda', 'pod'])).toBe(1);
    expect(errors).toEqual([
      `Refused drop-in ${path.join(
        '.lambda',
        'commands',
        'pod.ts'
      )}: pod is a core command and can't be replaced.`,
    ]);
    expect([...errors, ...logged].join('\n')).not.toContain(
      'the pod drop-in was loaded'
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses a verdict drop-in: the ship gate reads only the real verdict', async () => {
    const { root, out } = recordingProject();
    write(
      path.join(root, '.lambda', 'commands', 'verdict.ts'),
      "throw new Error('the verdict drop-in was loaded');\n"
    );
    process.chdir(root);

    expect(await run(['node', 'lambda', 'verdict', 'record', 'PAWNEE-1'])).toBe(
      1
    );
    expect(errors).toEqual([
      `Refused drop-in ${path.join(
        '.lambda',
        'commands',
        'verdict.ts'
      )}: verdict is a core command and can't be replaced.`,
    ]);
    expect([...errors, ...logged].join('\n')).not.toContain(
      'the verdict drop-in was loaded'
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it.each(['planning', 'building'])(
    'refuses a %s drop-in: the built-in always runs',
    async (name) => {
      const { root, out } = recordingProject();
      write(
        path.join(root, '.lambda', 'commands', `${name}.ts`),
        `throw new Error('the ${name} drop-in was loaded');\n`
      );
      process.chdir(root);

      expect(await run(['node', 'lambda', name, 'steps'])).toBe(1);
      expect(errors).toEqual([
        `Refused drop-in ${path.join(
          '.lambda',
          'commands',
          `${name}.ts`
        )}: ${name} is a core command and can't be replaced.`,
      ]);
      expect([...errors, ...logged].join('\n')).not.toContain(
        `the ${name} drop-in was loaded`
      );
      expect(fs.existsSync(out)).toBe(false);
    }
  );

  it('exits 1 on an invalid lambda.json, naming the file on stderr', async () => {
    const { root, out } = recordingProject();
    write(
      path.join(root, 'lambda.json'),
      '{ "tickets": { "source": "trello" } }'
    );
    process.chdir(root);

    expect(await run(['node', 'lambda', 'log'])).toBe(1);
    expect(errors).toEqual([
      expect.stringMatching(
        /^lambda\.json: tickets\.source "trello" isn't one of /
      ),
    ]);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('exits 1 on a lambda.json that is not JSON', async () => {
    const { root } = recordingProject();
    write(path.join(root, 'lambda.json'), '{ "cli": ');
    process.chdir(root);

    expect(await run(['node', 'lambda', 'e2e'])).toBe(1);
    expect(errors).toEqual([
      expect.stringMatching(/^Invalid JSON in .*lambda\.json: /),
    ]);
  });

  it('exits 1 on an invalid machine file, naming the file on stderr', async () => {
    const { root, out } = recordingProject();
    const home = process.env.LAMBDA_HOME ?? '';
    write(
      path.join(home, 'config.json'),
      JSON.stringify({ owner: { name: 7 } })
    );
    process.chdir(root);

    expect(await run(['node', 'lambda', 'log'])).toBe(1);
    expect(errors).toEqual([
      `${path.join(
        home,
        'config.json'
      )}: owner.name expected string, received number`,
    ]);
    expect(fs.existsSync(out)).toBe(false);
  });
});
