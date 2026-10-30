import { execFileSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseSituation, registerShotCommand, runShotBefore } from '..';
import { ProjectConfigSchema } from '../../../config/projectConfig';
import { type ShotDeps, checkoutRootOf } from '../../../shot';

const DESCRIPTION =
  'Leslie Knope is signed in as the parks director on a Monday at 9am, with three trails closed for repairs today, marked by Ann, Ron and April, on the home screen.';

const setup = (shot?: string) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-shot-cmd-'))
  );
  const tracked = path.join(root, '.lambda', 'scenarios');
  fs.mkdirSync(tracked, { recursive: true });
  fs.writeFileSync(
    path.join(tracked, 'trail-repairs.scenario.json'),
    JSON.stringify({
      id: 'trail-repairs',
      title: 'Home on a trail repair day',
      description: DESCRIPTION,
      tags: ['home'],
    })
  );
  const printed: string[] = [];
  const deps: ShotDeps = {
    project: {
      root,
      file: undefined,
      config: ProjectConfigSchema.parse({
        commands: shot === undefined ? {} : { shot },
      }),
    },
    checkout: root,
    env: { LAMBDA_PODS_ROOT: path.join(root, 'pods') },
    print: (line) => printed.splice(printed.length, 0, line),
    printError: (line) => printed.splice(printed.length, 0, line),
    showOutput: () => undefined,
  };

  return { root, deps, printed };
};

const podsRootBefore = process.env.LAMBDA_PODS_ROOT;

afterEach(() => {
  if (podsRootBefore === undefined) {
    delete process.env.LAMBDA_PODS_ROOT;
  } else {
    process.env.LAMBDA_PODS_ROOT = podsRootBefore;
  }
});

/** A real screen folder: `lambda shot before` refuses any other. */
const screenDirIn = (root: string): string => {
  const dir = path.join(root, 'pods', 'pod-1', 'designs', 'home');
  fs.mkdirSync(dir, { recursive: true });
  process.env.LAMBDA_PODS_ROOT = path.join(root, 'pods');

  return dir;
};

const run = async (deps: ShotDeps, args: string[]) => {
  const program = new Command().exitOverride();
  registerShotCommand(program, () => deps);
  await program.parseAsync(['node', 'lambda', 'shot', ...args]);
  const code = process.exitCode;
  process.exitCode = undefined;

  return code;
};

describe('lambda shot', () => {
  it('routes search to the search, labelled', async () => {
    const { deps, printed } = setup();

    expect(await run(deps, ['search', 'repair', 'HOME'])).toBe(0);
    expect(printed).toEqual([
      'trail-repairs  [tracked]  Home on a trail repair day  (home)',
    ]);
  });

  it('routes an id to the hook, exit 2 without one', async () => {
    const { deps, printed } = setup();

    expect(await run(deps, ['trail-repairs', '--out', 'x.png'])).toBe(2);
    expect(printed[0]).toMatch(/no photo hook/);
  });

  it('says to design without befores when there is no hook', async () => {
    const { deps, printed, root } = setup();

    expect(
      await runShotBefore(
        'home',
        screenDirIn(root),
        [parseSituation('busy-day=trail-repairs')],
        deps
      )
    ).toBe(2);
    expect(printed[0]).toMatch(/noPhotoHook: true/);
  });

  it('prints the DESIGN FAILED line for a failed before', async () => {
    const { deps, printed, root } = setup('echo "no app here"; exit 1');

    expect(
      await runShotBefore(
        'home',
        screenDirIn(root),
        [parseSituation('busy-day=trail-repairs')],
        deps
      )
    ).toBe(1);
    expect(printed).toEqual([
      'DESIGN FAILED home: before shot — trail-repairs: no app here',
    ]);
  });

  it('writes a relative --out where the command was run, not at the checkout root', async () => {
    const { deps, root } = setup('printf x > {out}; exit 0');
    const sub = path.join(root, 'app');
    fs.mkdirSync(sub);
    const was = process.cwd();
    process.chdir(sub);

    try {
      await run(deps, ['trail-repairs', '--out', 'home.png']);
    } finally {
      process.chdir(was);
    }

    expect(fs.existsSync(path.join(sub, 'home.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'home.png'))).toBe(false);
  });

  it('fails, without throwing, when --out is a folder', async () => {
    const { deps, root, printed } = setup('printf x > {out}; exit 0');
    fs.mkdirSync(path.join(root, 'shots'));

    expect(
      await run(deps, ['trail-repairs', '--out', path.join(root, 'shots')])
    ).toBe(1);
    expect(printed.join('\n')).toContain('shots');
  });

  it('names each broken scenario in a search, pointing at lambda shot check', async () => {
    const { deps, printed, root } = setup();
    const broken = path.join(
      root,
      '.lambda',
      'scenarios',
      'home-broken.scenario.json'
    );
    fs.writeFileSync(broken, '{ not json');

    expect(await run(deps, ['search', 'repair'])).toBe(0);
    expect(printed).toEqual([
      'trail-repairs  [tracked]  Home on a trail repair day  (home)',
      `${broken} isn't a valid scenario, so search skipped it: run \`lambda shot check ${broken}\`.`,
    ]);
  });

  it('refuses to overwrite an --out file that is not a PNG, leaving it as it is', async () => {
    const { deps, root, printed } = setup('printf x > {out}; exit 0');
    const out = path.join(root, 'lambda.json');
    fs.writeFileSync(out, '{"name":"Pawnee parks map"}');

    expect(await run(deps, ['trail-repairs', '--out', out])).toBe(1);
    expect(fs.readFileSync(out, 'utf8')).toBe('{"name":"Pawnee parks map"}');
    expect(printed.join('\n')).toContain("isn't a PNG");
  });

  it('refuses a situation without its scenario', () => {
    expect(() => parseSituation('trail-repairs')).toThrow(/<situation>=/);
  });
});

describe('checkoutRootOf', () => {
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const repo = (): string => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-shot-root-'))
    );
    fs.mkdirSync(path.join(root, 'packages', 'app', 'src'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, 'packages', 'app', 'lambda.json'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'app', 'src', 'map.ts'), '');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'leslie@pawnee.gov']);
    git(root, ['config', 'user.name', 'Leslie Knope']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'start']);

    return root;
  };

  it('is the project folder, not the git toplevel, for a project below it', () => {
    const root = repo();
    const app = path.join(root, 'packages', 'app');

    expect(checkoutRootOf(path.join(app, 'src'), app)).toBe(app);
  });

  it("is the codebase's folder inside a linked worktree", () => {
    const root = repo();
    const worktree = `${root}-wt`;
    git(root, ['worktree', 'add', '-q', worktree]);

    expect(
      checkoutRootOf(
        path.join(worktree, 'packages', 'app', 'src'),
        path.join(root, 'packages', 'app')
      )
    ).toBe(path.join(fs.realpathSync(worktree), 'packages', 'app'));
    fs.rmSync(worktree, { recursive: true, force: true });
  });
});
