/**
 * Lambda's pods never touch a folder Lambda doesn't own: their roots come from LAMBDA_*
 * variables and lambda.json only.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Project, loadProjectConfig } from '../../config/projectConfig';
import { createPodStore } from '../../pod-store';
import {
  currentProject,
  podsRoot,
  podsRootFor,
  sessionName,
  worktreeRoot,
} from '../context';
import { runList } from '../lifecycle';
import { usePodProject } from './podProject';

type Env = Record<string, string | undefined>;

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  jest.restoreAllMocks();
});

const load = (root: string): Project => {
  const project = loadProjectConfig(root);

  if (project === null) {
    throw new Error('No project.');
  }

  return project;
};

/**
 * An env that records every key read from it. A child process (git) is
 * handed the whole env, which reads every key: that copy isn't a lookup, so
 * reads from inside child_process aren't recorded.
 */
const recording = (values: Env): { env: Env; read: Set<string> } => {
  const read = new Set<string>();
  const env = new Proxy(values, {
    get: (target, key) => {
      if (
        typeof key === 'string' &&
        !(new Error().stack ?? '').includes('node:child_process')
      ) {
        read.add(key);
      }

      return typeof key === 'string' ? target[key] : undefined;
    },
  });

  return { env, read };
};

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-iso-')));

const notLambda = (read: Set<string>): string[] =>
  Array.from(read).filter((key) => !key.startsWith('LAMBDA_'));

describe('where pods live', () => {
  it('reads only LAMBDA_* variables to find the pods and worktree roots', () => {
    usePodProject();
    const values = Object.fromEntries(
      Object.entries(saved).filter(([key]) => !key.startsWith('LAMBDA_'))
    );
    const { env, read } = recording({
      ...values,
      LAMBDA_HOME: saved.LAMBDA_HOME,
    });
    process.env = env;

    // What the pod commands call, with their defaults: process.env itself.
    podsRoot();
    worktreeRoot(currentProject());

    expect(read.size).toBeGreaterThan(0);
    expect(notLambda(read)).toEqual([]);
  });

  it('catches a read of any other variable', () => {
    const { env, read } = recording({ HOME: '/home/leslie' });
    process.env = env;

    expect(process.env.HOME).toBe('/home/leslie');
    expect(notLambda(read)).toEqual(['HOME']);
  });

  it('is LAMBDA_PODS_ROOT, else lambda.json pods.root, else <project>/.lambda/pods', () => {
    const plain = load(usePodProject());
    expect(podsRootFor(plain, {})).toBe(
      path.join(plain.root, '.lambda', 'pods')
    );

    const configured = load(usePodProject({ pods: { root: 'state/pods' } }));
    expect(podsRootFor(configured, {})).toBe(
      path.join(configured.root, 'state', 'pods')
    );
    expect(podsRootFor(configured, { LAMBDA_PODS_ROOT: '/srv/pods' })).toBe(
      '/srv/pods'
    );
  });

  it("resolves a relative pods.root against the main checkout, even from a pod's worktree", () => {
    const root = usePodProject({ pods: { root: 'state/pods' } });
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.email=leslie@pawnee.gov',
          '-c',
          'user.name=Leslie Knope',
          ...args,
        ],
        { cwd: root, stdio: 'ignore' }
      );
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'start');
    const worktree = path.join(tmp(), 'ice-town-1a2b');
    git('worktree', 'add', '-q', '--detach', worktree);

    expect(podsRootFor(load(worktree), {})).toBe(
      path.join(root, 'state', 'pods')
    );
  });

  it('puts worktrees under LAMBDA_POD_WORKTREES, else <LAMBDA_HOME>/worktrees/<project>', () => {
    const project = load(usePodProject());

    expect(worktreeRoot(project, { LAMBDA_POD_WORKTREES: '/srv/trees' })).toBe(
      '/srv/trees'
    );
    expect(worktreeRoot(project, { LAMBDA_HOME: '/srv/lambda' })).toBe(
      path.join('/srv/lambda', 'worktrees', path.basename(project.root))
    );
  });

  it("names sessions lambda-pod-<id>, and lists no pod outside this codebase's root", () => {
    usePodProject();
    delete process.env.LAMBDA_PODS_ROOT;
    createPodStore(path.join(tmp(), '.other-pods')).writePod({
      id: 'eagleton-c3d4',
      slug: 'eagleton',
      createdAt: '2026-10-03T00:00:00.000Z',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      worktreePath: '/tmp/eagleton',
      ownsWorktree: false,
      managerCwd: '/tmp/eagleton',
      devCwd: '/tmp/eagleton',
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    const printed: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.splice(printed.length, 0, line);
    });

    runList();

    expect(printed).toEqual(['No pods.']);
    expect(sessionName('ice-town-1a2b')).toBe('lambda-pod-ice-town-1a2b');
  });
});
