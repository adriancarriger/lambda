import { execFileSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Project, ProjectConfigSchema } from '../../config/projectConfig';
import {
  CORE_COMMANDS,
  loadDropIn,
  refusedMessage,
  resolveCommand,
  unavailableMessage,
} from '../resolve';

const tmpProject = (config: object = {}): Project => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resolve-'));
  fs.writeFileSync(path.join(root, 'lambda.json'), JSON.stringify(config));

  return {
    root,
    file: path.join(root, 'lambda.json'),
    config: ProjectConfigSchema.parse(config),
  };
};

const dropIn = (project: Project, file: string, source: string): void => {
  const full = path.join(project.root, '.lambda', 'commands', file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, source);
};

const THROWS_ON_LOAD = "throw new Error('the Pawnee drop-in was loaded');\n";

const REGISTERS = `
export const register = (program: { command: (name: string) => unknown }) => {
  program.command('parks');
};
`;

describe('resolution order', () => {
  it('a drop-in e2e wins over commands.e2e and the built-in', () => {
    const project = tmpProject({ commands: { e2e: 'pnpm test:e2e {spec}' } });
    dropIn(project, 'e2e.ts', REGISTERS);

    expect(resolveCommand('e2e', project)).toEqual({
      kind: 'drop-in',
      name: 'e2e',
      file: path.join('.lambda', 'commands', 'e2e.ts'),
    });
  });

  it('commands.e2e wins over the built-in when there is no drop-in', () => {
    const project = tmpProject({ commands: { e2e: 'pnpm test:e2e {spec}' } });

    expect(resolveCommand('e2e', project)).toEqual({
      kind: 'config',
      name: 'e2e',
      key: 'commands.e2e',
      command: 'pnpm test:e2e {spec}',
    });
    expect(resolveCommand('e2e', tmpProject())).toEqual({
      kind: 'built-in',
      name: 'e2e',
    });
  });

  it.each(CORE_COMMANDS)(
    'refuses a drop-in named %s without loading it',
    async (name) => {
      const project = tmpProject();
      dropIn(project, `${name}.ts`, THROWS_ON_LOAD);
      const file = path.join('.lambda', 'commands', `${name}.ts`);
      const resolution = resolveCommand(name, project);

      expect(resolution).toEqual({ kind: 'refused', name, file });
      expect(refusedMessage(file, name)).toBe(
        `Refused drop-in ${file}: ${name} is a core command and can't be replaced.`
      );
    }
  );

  it('runs ship as the built-in, never a codebase CLI', () => {
    const project = tmpProject({ cli: 'git' });

    expect(resolveCommand('ship', project)).toEqual({
      kind: 'built-in',
      name: 'ship',
    });
  });

  it('builds in every core name, so none resolves as unavailable', () => {
    const project = tmpProject({ cli: 'git' });

    expect(
      CORE_COMMANDS.filter(
        (name) => resolveCommand(name, project).kind !== 'built-in'
      )
    ).toEqual([]);
  });

  it('words the refusal for a core name a version lacks', () => {
    // No core name is unavailable today; the name here is only the wording.
    expect(unavailableMessage('deploy')).toBe(
      "lambda deploy isn't available in this version."
    );
  });

  it('hands an unknown name, and test without commands.test, to the codebase CLI', () => {
    const project = tmpProject({ cli: 'git' });

    expect(resolveCommand('log', project)).toEqual({
      kind: 'project-cli',
      name: 'log',
      cli: 'git',
    });
    expect(resolveCommand('test', project)).toEqual({
      kind: 'project-cli',
      name: 'test',
      cli: 'git',
    });
  });

  it('runs commands.test when it is set', () => {
    const project = tmpProject({ commands: { test: 'pnpm test {spec}' } });

    expect(resolveCommand('test', project)).toMatchObject({
      kind: 'config',
      key: 'commands.test',
    });
  });

  it('prefers e2e.ts when e2e.js is there too, and loads only it', async () => {
    const project = tmpProject();
    dropIn(project, 'e2e.js', THROWS_ON_LOAD);
    dropIn(project, 'e2e.ts', REGISTERS);
    const resolution = resolveCommand('e2e', project);

    expect(resolution).toMatchObject({
      kind: 'drop-in',
      file: path.join('.lambda', 'commands', 'e2e.ts'),
    });

    if (resolution.kind !== 'drop-in') {
      throw new Error(`Expected a drop-in, got ${resolution.kind}`);
    }

    const program = new Command();
    (await loadDropIn(project, resolution.file))(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      'parks',
    ]);
  });
});

describe('loading a drop-in', () => {
  it('loads a .ts drop-in and calls its register with the program', async () => {
    const project = tmpProject();
    dropIn(project, 'parks.ts', REGISTERS);
    const program = new Command();

    const register = await loadDropIn(
      project,
      path.join('.lambda', 'commands', 'parks.ts')
    );
    register(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      'parks',
    ]);
  });

  // Jest routes import() through its own require, which can't load a file
  // URL, so this builds resolve.ts the way the package ships (tsup, cjs) and
  // loads the drop-ins in a real node, through its native import().
  it('loads .js, .cjs and .mjs drop-ins through import() once built', () => {
    const project = tmpProject();
    dropIn(
      project,
      'parks.js',
      "exports.register = (p) => p.command('parks');\n"
    );
    dropIn(
      project,
      'lots.cjs',
      "exports.register = (p) => p.command('lots');\n"
    );
    dropIn(
      project,
      'budget.mjs',
      "export const register = (p) => p.command('budget');\n"
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-built-'));
    const script = `
const path = require('path');
const { build } = require('tsup');
const [entry, outDir, root] = process.argv.slice(1);
build({ entry: { resolve: entry }, outDir, format: ['cjs'], platform: 'node',
  target: 'node20', dts: false, silent: true, config: false })
  .then(async () => {
    const { loadDropIn } = require(path.join(outDir, 'resolve.js'));
    const { Command } = require('commander');
    const program = new Command();
    for (const file of ['parks.js', 'lots.cjs', 'budget.mjs']) {
      (await loadDropIn({ root }, path.join('.lambda', 'commands', file)))(program);
    }
    process.stdout.write(JSON.stringify(program.commands.map((c) => c.name())));
  });
`;

    const output = execFileSync(
      process.execPath,
      [
        '-e',
        script,
        path.join(__dirname, '..', 'resolve.ts'),
        outDir,
        project.root,
      ],
      { cwd: path.join(__dirname, '..', '..', '..'), encoding: 'utf8' }
    );

    expect(JSON.parse(output)).toEqual(['parks', 'lots', 'budget']);
  });

  it('names a drop-in with no register export', async () => {
    const project = tmpProject();
    dropIn(project, 'parks.ts', 'export const parks = 1;\n');
    const file = path.join('.lambda', 'commands', 'parks.ts');

    await expect(loadDropIn(project, file)).rejects.toThrow(
      `Drop-in ${file} failed to load: no register export`
    );
  });

  it('passes on the message of a drop-in that throws', async () => {
    const project = tmpProject();
    dropIn(project, 'parks.ts', THROWS_ON_LOAD);
    const file = path.join('.lambda', 'commands', 'parks.ts');

    await expect(loadDropIn(project, file)).rejects.toThrow(
      `Drop-in ${file} failed to load: the Pawnee drop-in was loaded`
    );
  });
});
