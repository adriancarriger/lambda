import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { registerSystemCommands } from '../../commands/design/system';
import {
  DIR,
  MANIFEST,
  PROJECT_NAME,
  type Repo,
  TAILWIND_CLI,
  fixtureProjectId,
  indexText,
  makeRepo,
  manifestText,
  parksApp,
  read,
  runGit,
  tmp,
  useHome,
} from '../../design/system/__tests__/buildFixture';
import { buildFromRef } from '../../design/system/cache';
import { type Ticket } from '../../tickets/source';
import {
  NO_SYSTEM_LINE,
  type PrepareResult,
  prepareDesignSystem,
} from '../designSystem';

// os.homedir() reads the real environment, never jest's copy of process.env:
// make it follow the copy's HOME, as the real one follows the real HOME.
jest.mock('os', () => ({
  ...jest.requireActual<object>('os'),
  homedir: () => process.env.HOME ?? '/',
}));

// Real esbuild builds in the runner's build checkout.
jest.setTimeout(60_000);

const ticket = (overrides: Partial<Ticket>): Ticket => ({
  id: 'PAWNEE-7',
  title: 'Make the design system from the app',
  status: 'ready',
  labels: [],
  parent: null,
  children: [],
  blockedBy: [],
  blockReason: null,
  reporter: null,
  url: null,
  priority: 'none',
  assignee: null,
  ...overrides,
});

describe("planning's step 0 builds the design system from main", () => {
  const state: {
    repo?: Repo;
    home?: { home: string; restore: () => void };
    shas: { none: string; base: string; unshipped: string; broken: string };
  } = { shas: { none: '', base: '', unshipped: '', broken: '' } };
  const builds: boolean[] = [];

  beforeAll(() => {
    state.home = useHome();
    const repo = makeRepo({ ...parksApp({ version: 3 }), ...TAILWIND_CLI });
    repo.remove(MANIFEST);
    state.shas.none = repo.commit('The parks app', '2026-09-01T09:00:00-05:00');
    repo.write({ [MANIFEST]: manifestText(3) });
    state.shas.base = repo.commit('The design system, version 3');

    repo.git(['checkout', '-q', '-b', 'unshipped']);
    repo.write({ [MANIFEST]: manifestText(4) });
    state.shas.unshipped = repo.commit('Version 4, not shipped');

    repo.git(['checkout', '-q', '-b', 'park-head', state.shas.base]);
    repo.write({
      'src/components/ParkHead.tsx':
        "import Head from 'next/head';\n\nexport const ParkHead = () => <Head />;\n",
      [`${DIR}/index.tsx`]: indexText({
        ParkCard: '../../src/components/ParkCard',
        ParkHead: '../../src/components/ParkHead',
      }),
    });
    state.shas.broken = repo.commit('A park page head');

    repo.git(['checkout', '-q', 'main']);
    repo.write({ [MANIFEST]: manifestText(5) });
    state.repo = repo;
  });

  afterAll(() => {
    state.home?.restore();
  });

  const repoOf = (): Repo => {
    if (state.repo === undefined) {
      throw new Error('The fixture repo was not made.');
    }

    return state.repo;
  };

  /** A pod worktree at `sha` (packages are never installed in one), and its canvas. */
  const pod = (sha: string): { worktree: string; canvasDir: string } => {
    const worktree = path.join(tmp('lambda-ds-pod-'), 'worktree');
    repoOf().git(['worktree', 'add', '-q', '--detach', worktree, sha]);

    return {
      worktree,
      canvasDir: path.join(
        worktree,
        '.lambda',
        'design',
        'park-hours',
        'canvas'
      ),
    };
  };

  const prepare = (
    base: string,
    canvasDir: string,
    tickets: Ticket[] = []
  ): { result: Promise<PrepareResult>; listTickets: jest.Mock } => {
    const listTickets = jest.fn(async () => tickets);

    return {
      listTickets,
      result: prepareDesignSystem({
        project: repoOf().project(),
        projectName: PROJECT_NAME,
        base,
        worktree: repoOf().root,
        canvasDir,
        listTickets,
        build: async (args) => {
          const built = await buildFromRef(args);
          builds.splice(builds.length, 0, built.built);

          return built;
        },
      }),
    };
  };

  const cacheBase = (): string =>
    path.join(
      state.home?.home ?? '',
      '.lambda',
      'cache',
      'design-system',
      fixtureProjectId(repoOf().root)
    );

  it("installs main's version 3 from the cache, built outside the pod's worktree", async () => {
    const { worktree, canvasDir } = pod(state.shas.base);
    const result = await prepare(state.shas.base, canvasDir).result;
    const folder = path.join(cacheBase(), state.shas.base);

    expect(result).toEqual({
      installed: canvasDir,
      builtDir: folder,
      summary: null,
    });
    expect(builds).toEqual([true]);
    expect(
      JSON.parse(read(folder, 'project/design-system.json')).lastChange.via
    ).toBe(`lambda design system · v3 · ${state.shas.base.slice(0, 7)}`);
    const installed = path.join(canvasDir, 'project', 'ds', 'pawneeparksmap');
    expect(read(installed, 'components/bundle.js')).toBe(
      read(folder, 'project/components/bundle.js')
    );
    expect(
      JSON.parse(read(canvasDir, 'project/canvas.json')).designSystems
    ).toEqual([
      expect.objectContaining({
        title: PROJECT_NAME,
        namespace: 'pawneeparksmap',
      }),
    ]);

    // Built in the runner's build checkout, never the pod's worktree.
    expect(
      runGit(path.join(cacheBase(), 'checkout'), ['rev-parse', 'HEAD'])
    ).toBe(state.shas.base);
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false);
    expect(
      fs.existsSync(path.join(worktree, '.lambda', 'design', 'system'))
    ).toBe(false);
    // The codebase's checkout keeps its uncommitted version 5.
    expect(read(repoOf().root, MANIFEST)).toBe(manifestText(5));
  });

  it('shares the build with a second pod on the same base', async () => {
    const { canvasDir } = pod(state.shas.base);
    const result = await prepare(state.shas.base, canvasDir).result;

    expect(result.builtDir).toBe(path.join(cacheBase(), state.shas.base));
    expect(result.installed).toBe(canvasDir);
    expect(builds).toEqual([true, false]);
  });

  it('installs nothing when the base has no manifest, and says designs use the default look', async () => {
    const { canvasDir } = pod(state.shas.none);
    const { result, listTickets } = prepare(state.shas.none, canvasDir, [
      ticket({ id: 'PAWNEE-3', status: 'done' }),
      ticket({ id: 'PAWNEE-4', title: 'Bench rows show opening hours' }),
    ]);

    expect(await result).toEqual({
      installed: null,
      builtDir: null,
      summary: NO_SYSTEM_LINE,
    });
    expect(NO_SYSTEM_LINE).toBe(
      "No design system: designs use Claude Design's default look."
    );
    expect(listTickets).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(canvasDir)).toBe(false);
    expect(builds).toEqual([true, false]);
  });

  it('names the open setup ticket when the base has no manifest', async () => {
    const { canvasDir } = pod(state.shas.none);
    const result = await prepare(state.shas.none, canvasDir, [
      ticket({ id: 'PAWNEE-7', status: 'building' }),
    ]).result;

    expect(result).toEqual({
      installed: null,
      builtDir: null,
      summary:
        "PAWNEE-7 is making the design system; these designs use Claude Design's default look.",
    });
    expect(fs.existsSync(canvasDir)).toBe(false);
  });

  it('goes on with the default look when the tickets cannot be listed, and says it could not read them', async () => {
    const { canvasDir } = pod(state.shas.none);
    const result = await prepareDesignSystem({
      project: repoOf().project(),
      projectName: PROJECT_NAME,
      base: state.shas.none,
      worktree: repoOf().root,
      canvasDir,
      listTickets: () =>
        Promise.reject(new Error('The tracker is down.\nretry later')),
    });

    expect(result.summary).toBe(
      "No design system on main: designs use Claude Design's default look (couldn't read the tickets: The tracker is down)."
    );
  });

  it("an invalid manifest at the base never stops the ux phase: it says the design system couldn't be built", async () => {
    const repo = repoOf();
    repo.git(['checkout', '-q', '-b', 'bad-namespace', state.shas.base]);
    repo.write({
      [MANIFEST]: `${JSON.stringify({ namespace: 'pawnee', version: 3 })}\n`,
    });
    const bad = repo.commit('A lower-case namespace');
    repo.git(['checkout', '-q', 'main']);
    repo.write({ [MANIFEST]: manifestText(5) });
    const { canvasDir } = pod(bad);

    const result = await prepare(bad, canvasDir).result;

    expect(result.installed).toBeNull();
    expect(result.summary).toMatch(
      /^The design system on main couldn't be built: .*namespace must match/
    );
  });

  it("a base that can't be told never stops the ux phase either", async () => {
    const { canvasDir } = pod(state.shas.base);
    const result = await prepareDesignSystem({
      project: repoOf().project(),
      projectName: PROJECT_NAME,
      // Not a git checkout: its base can't be read.
      worktree: tmp('lambda-ds-not-a-checkout-'),
      canvasDir,
      listTickets: async () => [],
    });

    expect(result).toEqual({
      installed: null,
      builtDir: null,
      summary: expect.stringMatching(
        /^The design system on main couldn't be built: Can't tell this pod's base/
      ),
    });
  });

  it('with no design system, planning creates no ticket and posts no inbox item', async () => {
    const { worktree, canvasDir } = pod(state.shas.none);
    const podsRoot = tmp('lambda-ds-pods-');
    const savedPods = process.env.LAMBDA_PODS_ROOT;
    const savedCwd = process.cwd();
    const tasks = path.join(repoOf().root, 'TASKS.md');
    const tasksBefore = fs.existsSync(tasks)
      ? read(repoOf().root, 'TASKS.md')
      : null;
    const printed: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.splice(printed.length, 0, line);
    });
    process.env.LAMBDA_PODS_ROOT = podsRoot;
    process.chdir(worktree);

    try {
      const program = new Command();
      program.exitOverride();
      const design = program.command('design');
      registerSystemCommands(design);
      await program.parseAsync(
        ['design', 'system', 'prepare', canvasDir, '--base', state.shas.none],
        { from: 'user' }
      );
    } finally {
      process.chdir(savedCwd);
      jest.restoreAllMocks();

      if (savedPods === undefined) {
        delete process.env.LAMBDA_PODS_ROOT;
      } else {
        process.env.LAMBDA_PODS_ROOT = savedPods;
      }
    }

    expect(printed).toEqual([NO_SYSTEM_LINE]);
    // No ticket: the codebase's queue is as it was.
    expect(fs.existsSync(tasks) ? read(repoOf().root, 'TASKS.md') : null).toBe(
      tasksBefore
    );
    // No inbox item, nor anything else, written to the pods.
    expect(fs.readdirSync(podsRoot)).toEqual([]);
  });

  it("says the design system couldn't be built, and the ux phase goes on", async () => {
    const { canvasDir } = pod(state.shas.broken);
    const result = await prepare(state.shas.broken, canvasDir).result;

    expect(result).toEqual({
      installed: null,
      builtDir: null,
      summary:
        "The design system on main couldn't be built: src/components/ParkHead.tsx imports next/head, which the design system has no stand-in for. Copy the piece as a pattern, or leave it out with design.systemBuild.exclude.",
    });
    expect(fs.existsSync(path.join(cacheBase(), state.shas.broken))).toBe(
      false
    );
    expect(fs.existsSync(path.join(canvasDir, 'project', 'ds'))).toBe(false);
  });

  it('never uses the unshipped version 4', () => {
    expect(
      JSON.parse(
        read(
          path.join(cacheBase(), state.shas.base),
          'project/design-system.json'
        )
      ).lastChange.via
    ).not.toContain('v4');
    expect(fs.existsSync(path.join(cacheBase(), state.shas.unshipped))).toBe(
      false
    );
  });
});
