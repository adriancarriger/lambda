import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { registerSystemCommands } from '../../../commands/design/system';
import { commitAll, initRepo, put } from './gitFixture';

/**
 * `lambda design system build` and `manifest write` refusing what they can't
 * do as asked, before doing anything: the real commander commands in a
 * fixture checkout.
 */

const DIR = '.lambda/design-system';
const MANIFEST = `${DIR}/design-system.json`;

const runCli = async (cwd: string, args: string[]): Promise<string[]> => {
  const printed: string[] = [];
  const log = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.splice(printed.length, 0, String(line));
  });
  const error = jest
    .spyOn(console, 'error')
    .mockImplementation((line: unknown) => {
      printed.splice(printed.length, 0, `error: ${String(line)}`);
    });
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;

  try {
    process.chdir(cwd);
    const program = new Command('lambda').exitOverride();
    registerSystemCommands(program.command('design').exitOverride());
    await program.parseAsync(args, { from: 'user' });

    return [...printed, `exit ${process.exitCode ?? 0}`];
  } finally {
    process.chdir(savedCwd);
    log.mockRestore();
    error.mockRestore();
    process.exitCode = savedExit;
  }
};

/** A Pawnee parks map checkout with no origin: nothing says where main is. */
const localOnly = (): string => {
  const root = initRepo();
  put(root, 'lambda.json', JSON.stringify({ name: 'Pawnee parks map' }));
  put(
    root,
    'src/components/ParkCard.tsx',
    'export const ParkCard = () => null;\n'
  );
  commitAll(root, 'Pawnee parks map');
  put(
    root,
    `${DIR}/index.tsx`,
    "export { ParkCard } from '../../src/components/ParkCard';\n"
  );

  return root;
};

const roots: string[] = [];

afterEach(() => {
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('lambda design system manifest write', () => {
  it('refuses to guess the base when nothing says where the branch forks from, writing nothing', async () => {
    const root = localOnly();
    roots.splice(roots.length, 0, root);

    const printed = await runCli(root, [
      'design',
      'system',
      'manifest',
      'write',
      '--ticket',
      'PAWNEE-12',
      '--not-checked',
      'this codebase has no photo hook (commands.shot in lambda.json)',
    ]);

    expect(printed).toEqual([
      expect.stringContaining(
        "Can't tell where this branch forks from the default branch: pass --base <commit>, the commit the setup started from."
      ),
      'exit 1',
    ]);
    expect(fs.existsSync(path.join(root, MANIFEST))).toBe(false);
  });
});

describe('lambda design system build --from', () => {
  it.each([['--check'], ['--working-tree'], ['--out', 'elsewhere']])(
    'refuses %s, building nothing',
    async (...flags) => {
      const root = localOnly();
      roots.splice(roots.length, 0, root);

      const printed = await runCli(root, [
        'design',
        'system',
        'build',
        '--from',
        'main',
        ...flags,
      ]);

      expect(printed).toEqual([
        expect.stringContaining(
          "--from builds the commit as committed, into Lambda's cache: it takes no --out, --working-tree or --check."
        ),
        'exit 1',
      ]);
      expect(fs.existsSync(path.join(root, 'elsewhere'))).toBe(false);
    }
  );
});
