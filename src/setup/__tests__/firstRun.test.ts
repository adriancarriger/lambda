import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runInit } from '../../commands/init';
import {
  type MachineConfig,
  loadMachineConfig,
} from '../../config/machineConfig';
import { PROJECT_CONFIG_FILE } from '../../config/projectConfig';
import { HttpError } from '../../mothership/relay';
import { writeRunnerState } from '../../runner/localFiles';
import {
  type ProjectDeps,
  currentProject,
  projectGit,
  resumeStep,
  setupProject,
} from '../firstRun';
import { HOME_ONLY } from '../folders';

const tempHome = () => {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-first-'))
  );
  const globalConfig = path.join(home, '.gitconfig');
  fs.writeFileSync(globalConfig, '[core]\n\teditor = vi\n');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LAMBDA_HOME: path.join(home, '.lambda'),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const calls: string[][] = [];
  const deps: ProjectDeps = {
    home,
    env,
    git: (args, cwd) => {
      calls.splice(calls.length, 0, args);

      return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    },
    init: (cwd) => runInit({ cwd, env, name: 'Leslie Knope' }),
  };

  return { home, env, deps, calls, globalConfig };
};

const refusal = async (run: () => Promise<unknown>): Promise<number> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) {
      return error.status;
    }

    throw error;
  }

  return 0;
};

describe('first run', () => {
  it('resumes at the first unfinished step', () => {
    // A computer on no project, so nothing is set up from before first run.
    const { home, env } = tempHome();
    const x = path.join(home, 'code', 'x');
    fs.mkdirSync(x, { recursive: true });
    const none: MachineConfig = {};
    const claudeOnly: MachineConfig = {
      firstRun: { claude: true, projects: {} },
    };
    const noTickets: MachineConfig = {
      firstRun: {
        claude: true,
        projects: { [x]: { project: true, tickets: false } },
      },
    };
    const all: MachineConfig = {
      firstRun: {
        claude: true,
        projects: { [x]: { project: true, tickets: true } },
      },
    };

    expect(resumeStep(null, env)).toBe('claude');
    expect(resumeStep(none, env)).toBe('claude');
    expect(resumeStep(claudeOnly, env)).toBe('project');
    expect(resumeStep(noTickets, env)).toBe('tickets');
    expect(resumeStep(all, env)).toBeNull();
  });

  it('skips a project whose folder no longer exists', () => {
    const { home } = tempHome();
    const kept = path.join(home, 'code', 'pawnee-parks-site');
    const deleted = path.join(home, 'code', 'eagleton-site');
    fs.mkdirSync(kept, { recursive: true });
    const config: MachineConfig = {
      firstRun: {
        claude: true,
        projects: {
          [kept]: { project: true, tickets: false },
          // Newest, so it would be picked if it still existed.
          [deleted]: { project: true, tickets: false },
        },
      },
    };

    expect(currentProject(config)).toBe(kept);
    fs.rmSync(kept, { recursive: true });
    expect(currentProject(config)).toBeNull();
  });

  it('counts a computer set up before first run existed as done', () => {
    const { home, env } = tempHome();
    const project = path.join(home, 'code', 'pawnee-parks-site');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, PROJECT_CONFIG_FILE), '{}\n');
    writeRunnerState({ current: project }, env);
    const claude: MachineConfig = {
      tokens: { claude: { value: 'claude-pawnee-secret' } },
    };

    expect(resumeStep(claude, env)).toBeNull();
    // A token saved again (a renewal) writes firstRun with no projects.
    expect(
      resumeStep({ ...claude, firstRun: { claude: true, projects: {} } }, env)
    ).toBeNull();
    // What first run says about the project wins.
    expect(
      resumeStep(
        {
          ...claude,
          firstRun: {
            projects: { [project]: { project: true, tickets: false } },
          },
        },
        env
      )
    ).toBe('tickets');
    expect(
      resumeStep(
        {
          ...claude,
          firstRun: {
            projects: { [project]: { project: false, tickets: false } },
          },
        },
        env
      )
    ).toBe('project');
    // The project it is on has no lambda.json: set it up.
    fs.rmSync(path.join(project, PROJECT_CONFIG_FILE));
    expect(resumeStep(claude, env)).toBe('project');
    expect(resumeStep({}, env)).toBe('claude');
  });

  it('puts a folder under git quietly, with a default .gitignore and a first commit by Lambda', async () => {
    const { home, env, deps, globalConfig } = tempHome();
    const folder = path.join(home, 'Documents', 'pawnee-parks-site');
    fs.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Parks</h1>\n');
    fs.writeFileSync(path.join(folder, 'node_modules', 'x.js'), 'x\n');
    fs.writeFileSync(path.join(folder, '.env'), 'SECRET=1\n');
    const globalBefore = fs.readFileSync(globalConfig, 'utf8');

    expect(await setupProject({ folder }, deps)).toEqual({ root: folder });

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: folder, env, encoding: 'utf8' }).trim();

    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.env*\n.DS_Store\ndist/\n'
    );
    expect(git('log', '-1', '--format=%an <%ae>')).toBe(
      'Lambda <lambda@localhost>'
    );
    // `lambda init`'s files are in it: left out, they held the first pick-up.
    expect(
      git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()
    ).toEqual([
      '.gitignore',
      '.lambda/.gitignore',
      'index.html',
      'lambda.json',
    ]);
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.readFileSync(globalConfig, 'utf8')).toBe(globalBefore);
    expect(
      fs.readFileSync(path.join(folder, '.git', 'config'), 'utf8')
    ).not.toContain('[user]');
    expect(loadMachineConfig(env)?.firstRun?.projects[folder]).toEqual({
      project: true,
      tickets: false,
    });
  });

  it("gives a chosen repo with no commits exactly one first commit by Lambda, of Lambda's files only", async () => {
    const { home, env, deps } = tempHome();
    const folder = path.join(home, 'code', 'pawnee-parks-site');
    fs.mkdirSync(folder, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: folder, env, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Parks</h1>\n');
    git('add', 'index.html');

    await setupProject({ folder }, deps);

    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(git('log', '-1', '--format=%an <%ae> %s')).toBe(
      'Lambda <lambda@localhost> First commit'
    );
    // What the person staged stays staged, never committed as Lambda.
    expect(
      git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()
    ).toEqual(['.lambda/.gitignore', 'lambda.json']);
    expect(git('diff', '--cached', '--name-only')).toBe('index.html');
  });

  it('adds no commit to a chosen repo that already has one', async () => {
    const { home, env, deps } = tempHome();
    const folder = path.join(home, 'code', 'eagleton-site');
    fs.mkdirSync(folder, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: folder, env, encoding: 'utf8' }).trim();
    git('init', '-q');
    git(
      '-c',
      'user.name=Leslie Knope',
      '-c',
      'user.email=leslie@pawnee.gov',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'start'
    );

    await setupProject({ folder }, deps);

    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(git('log', '-1', '--format=%s')).toBe('start');
  });

  it("leaves a folder's own .gitignore as it is", async () => {
    const { home, deps } = tempHome();
    const folder = path.join(home, 'own-ignore');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, '.gitignore'), 'build/\n');

    await setupProject({ folder }, deps);

    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8')).toBe(
      'build/\n'
    );
  });

  it('refuses a picked path outside home, running no git', async () => {
    const { deps, calls } = tempHome();

    await expect(setupProject({ folder: '/Volumes/x' }, deps)).rejects.toThrow(
      HOME_ONLY
    );
    expect(calls).toEqual([]);
  });

  it('makes ~/Lambda/<name>, refusing a bad name or one that exists', async () => {
    const { home, deps } = tempHome();

    expect(await setupProject({ name: 'pawnee-parks-app' }, deps)).toEqual({
      root: path.join(home, 'Lambda', 'pawnee-parks-app'),
    });
    expect(await refusal(() => setupProject({ name: '../x' }, deps))).toBe(400);
    expect(await refusal(() => setupProject({ name: '' }, deps))).toBe(400);
    expect(await refusal(() => setupProject({ name: '..' }, deps))).toBe(400);
    expect(await refusal(() => setupProject({ name: 'a\0b' }, deps))).toBe(400);
    // A dot-folder is hidden from the list and refused: never made, then left.
    expect(await refusal(() => setupProject({ name: '.parks' }, deps))).toBe(
      400
    );
    expect(fs.existsSync(path.join(home, 'Lambda', '.parks'))).toBe(false);

    const before = fs.readdirSync(path.join(home, 'Lambda'));

    expect(
      await refusal(() => setupProject({ name: 'pawnee-parks-app' }, deps))
    ).toBe(409);
    expect(fs.readdirSync(path.join(home, 'Lambda'))).toEqual(before);
  });

  it("runs the real git without blocking the mothership's other requests", async () => {
    const { home, env } = tempHome();
    const ticked = { yes: false };
    setImmediate(() => {
      ticked.yes = true;
    });

    const running = projectGit(env)(['--version'], home);

    expect(ticked.yes).toBe(false);
    expect(await running).toMatch(/^git version/);
    expect(ticked.yes).toBe(true);
  });

  it('gives a folder inside a home that is itself a repo its own git', async () => {
    const { home, env, deps } = tempHome();
    execFileSync('git', ['init', '-q'], { cwd: home, env });
    const folder = path.join(home, 'pawnee-parks-site');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Parks</h1>\n');

    await setupProject({ folder }, deps);

    expect(
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: folder,
        env,
        encoding: 'utf8',
      }).trim()
    ).toBe(folder);
  });

  it('commits past a global hook that would refuse it', async () => {
    const { home, deps, globalConfig } = tempHome();
    const hooks = path.join(home, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    fs.appendFileSync(globalConfig, `\thooksPath = ${hooks}\n`);
    const folder = path.join(home, 'hooked');
    fs.mkdirSync(folder);

    expect(await setupProject({ folder }, deps)).toEqual({ root: folder });
  });

  it('creates nothing outside home when ~/Lambda links out of it', async () => {
    const { home, deps } = tempHome();
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-outside-'))
    );
    fs.symlinkSync(outside, path.join(home, 'Lambda'));

    expect(
      await refusal(() => setupProject({ name: 'pawnee-parks-app' }, deps))
    ).toBe(403);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('removes a new folder whose setup failed, so the same name can be tried again', async () => {
    const { home, deps } = tempHome();
    const failing: ProjectDeps = {
      ...deps,
      init: () => ({ code: 1, error: 'lambda init failed' }),
    };

    await expect(
      setupProject({ name: 'pawnee-parks-app' }, failing)
    ).rejects.toThrow('lambda init failed');
    expect(fs.existsSync(path.join(home, 'Lambda', 'pawnee-parks-app'))).toBe(
      false
    );
    expect(await setupProject({ name: 'pawnee-parks-app' }, deps)).toEqual({
      root: path.join(home, 'Lambda', 'pawnee-parks-app'),
    });
  });
});
