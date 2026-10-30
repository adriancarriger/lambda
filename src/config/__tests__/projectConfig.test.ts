import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ProjectConfigSchema,
  findProjectRoot,
  loadProjectConfig,
  resolveKnowledgeDirs,
  resolvePodsRoot,
  statusNameOf,
} from '../projectConfig';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-project-')));

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const pawneeConfig = {
  name: 'Pawnee Parks app',
  description: 'Parks department tools',
  cli: './bin/pawnee',
  tickets: {
    source: 'linear',
    statuses: {
      planning: 'Backlog',
      ready: 'Todo',
      building: 'In Progress',
      blocked: 'Blocked',
      done: 'Done',
      canceled: 'Canceled',
    },
    labels: { quick: 'Quick fix' },
    prefix: 'PAWNEE',
    team: 'PAWNEE',
  },
  commands: {
    e2e: 'npm run test:e2e -- {spec}',
    test: 'npm test -- {spec}',
    ship: 'make release',
    stop: 'make stop',
    shot: 'node scripts/shoot.js {scenario} {viewport} {out}',
    services: { web: 'npm run dev' },
  },
  app: { start: 'npm run dev', url: 'http://localhost:3000' },
  tmux: { session: 'pawnee', agentWindows: ['leslie', 'ben'] },
  pods: { root: 'var/pods' },
  knowledge: { local: 'var/knowledge', shared: 'notes/team' },
  verdicts: { dir: 'var/verdicts' },
  design: {
    scenarios: 'design/scenarios',
    scenarioExt: 'json',
    pendingDir: 'var/scenarios-pending',
    system: {
      dir: 'design/system',
      manifest: 'design/system/manifest.json',
      build: 'make design OUT={out}',
    },
  },
  instructions: ['CLAUDE.md', 'AGENTS.md'],
};

describe('lambda.json schema', () => {
  it('keeps every value of a full example', () => {
    expect(ProjectConfigSchema.parse(pawneeConfig)).toEqual(pawneeConfig);
  });

  it('rejects an unknown ticket source, naming the field', () => {
    const root = tmp();
    write(
      path.join(root, 'lambda.json'),
      JSON.stringify({ tickets: { source: 'trello' } })
    );

    expect(() => loadProjectConfig(root)).toThrow(
      `${path.join(root, 'lambda.json')}: tickets.source "trello" isn't one of`
    );
  });

  it('names lambda.json relative to where the command runs, as people see it', () => {
    const root = tmp();
    write(
      path.join(root, 'lambda.json'),
      JSON.stringify({ tickets: { source: 'trello' } })
    );
    const cwd = process.cwd();

    try {
      process.chdir(root);

      expect(() => loadProjectConfig(root)).toThrow(
        'lambda.json: tickets.source "trello" isn\'t one of markdown, linear, jira.'
      );
    } finally {
      process.chdir(cwd);
    }
  });

  describe('the tickets block', () => {
    const six = {
      planning: 'Backlog',
      ready: 'Todo',
      building: 'In Progress',
      blocked: 'Blocked',
      done: 'Done',
      canceled: 'Canceled',
    };
    const refusal = (tickets: object): string => {
      const root = tmp();
      const file = path.join(root, 'lambda.json');
      write(file, JSON.stringify({ tickets }));

      try {
        loadProjectConfig(root);
      } catch (error) {
        return error instanceof Error
          ? error.message.split(`${file}: `).join('')
          : String(error);
      }

      throw new Error('Expected a refusal');
    };

    it('refuses a missing state, an unknown source and a key field, naming each', () => {
      const { blocked: _blocked, ...noBlocked } = six;

      expect(refusal({ source: 'linear', statuses: noBlocked })).toBe(
        'tickets.statuses.blocked has no name for "blocked".'
      );
      expect(refusal({ source: 'trello' })).toBe(
        'tickets.source "trello" isn\'t one of markdown, linear, jira.'
      );
      expect(
        refusal({ source: 'linear', statuses: six, linearKey: 'lin_api_x' })
      ).toBe(
        'tickets.linearKey — keys never go in lambda.json. Put it in ~/.lambda/config.json or LAMBDA_LINEAR_KEY.'
      );
      expect(
        refusal({ source: 'jira', statuses: six, apiToken: 'x' })
      ).toContain('tickets.apiToken — keys never go in lambda.json.');
    });

    it('needs no Inbox: unnamed, it reads and writes as Planning', () => {
      const root = tmp();
      write(
        path.join(root, 'lambda.json'),
        JSON.stringify({
          tickets: { source: 'linear', statuses: six, lambdaLabel: ' λ ' },
        })
      );
      const tickets = loadProjectConfig(root)?.config.tickets;

      expect(tickets?.lambdaLabel).toBe('λ');
      expect(statusNameOf(tickets?.statuses ?? {}, 'inbox')).toBe('Backlog');
      expect(statusNameOf({ ...six, inbox: 'Inbox' }, 'inbox')).toBe('Inbox');
      expect(statusNameOf(six, 'ready')).toBe('Todo');
    });

    it('refuses an empty member label', () => {
      expect(
        refusal({ source: 'linear', statuses: six, lambdaLabel: '  ' })
      ).toContain('tickets.lambdaLabel');
    });

    it('reports every problem at once, one line each', () => {
      const { blocked: _blocked, ...noBlocked } = six;

      expect(
        refusal({
          source: 'linear',
          statuses: noBlocked,
          linearKey: 'lin_api_x',
          site: 'http://pawnee.atlassian.net',
        }).split('\n')
      ).toEqual([
        'tickets.linearKey — keys never go in lambda.json. Put it in ~/.lambda/config.json or LAMBDA_LINEAR_KEY.',
        'tickets.site must be an https:// URL',
        'tickets.statuses.blocked has no name for "blocked".',
      ]);
      expect(
        refusal({ source: 'trello', statuses: noBlocked }).split('\n')
      ).toEqual([
        'tickets.source "trello" isn\'t one of markdown, linear, jira.',
      ]);
    });

    it('refuses a key field at any depth inside the tickets block, naming its path', () => {
      expect(
        refusal({
          source: 'jira',
          statuses: six,
          auth: { nested: { apiToken: 'x' } },
        })
      ).toBe(
        'tickets.auth.nested.apiToken — keys never go in lambda.json. Put it in ~/.lambda/config.json or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN.'
      );
    });

    it('reads label keys as names, never as credentials', () => {
      expect(
        ProjectConfigSchema.parse({
          tickets: {
            source: 'markdown',
            labels: { hotkey: 'Hotkey', 'design-token': 'Design token' },
          },
        }).tickets?.labels
      ).toEqual({ hotkey: 'Hotkey', 'design-token': 'Design token' });
      expect(
        refusal({
          source: 'markdown',
          labels: { hotkey: 'Hotkey' },
          board: { apiKey: 'x' },
        })
      ).toBe(
        'tickets.board.apiKey — keys never go in lambda.json. Put it in ~/.lambda/config.json or LAMBDA_LINEAR_KEY, or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN.'
      );
    });

    it('refuses a tokens block copied to the top of lambda.json', () => {
      const root = tmp();
      const file = path.join(root, 'lambda.json');
      write(file, JSON.stringify({ tokens: { linear: 'lin_api_x' } }));

      expect(() => loadProjectConfig(root)).toThrow(
        `${file}: tokens — keys never go in lambda.json. Put it in ~/.lambda/config.json or LAMBDA_LINEAR_KEY, or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN.`
      );
    });

    it('refuses two states mapped to the same name, naming both', () => {
      expect(
        refusal({ source: 'jira', statuses: { ...six, ready: 'backlog ' } })
      ).toBe(
        'tickets.statuses.planning and tickets.statuses.ready are both "Backlog".'
      );
    });

    it('drops an unknown key inside the tickets block rather than refusing it', () => {
      expect(
        ProjectConfigSchema.parse({
          tickets: { source: 'markdown', prefix: 'PAWNEE', boards: ['Parks'] },
        }).tickets
      ).toEqual({ source: 'markdown', prefix: 'PAWNEE' });
    });

    it('needs all six states for linear, none for markdown, and an https Jira site', () => {
      const { canceled: _canceled, ...noCanceled } = six;

      expect(refusal({ source: 'linear', statuses: noCanceled })).toMatch(
        /^tickets\.statuses\.canceled has no name/
      );
      expect(
        ProjectConfigSchema.parse({ tickets: { source: 'markdown' } }).tickets
      ).toEqual({ source: 'markdown' });
      expect(
        refusal({
          source: 'jira',
          statuses: six,
          site: 'http://pawnee.atlassian.net',
          project: 'PAWNEE',
        })
      ).toBe('tickets.site must be an https:// URL');
    });

    it('keeps prefix and the markdown, Linear and Jira settings', () => {
      expect(
        ProjectConfigSchema.parse({
          tickets: {
            source: 'jira',
            statuses: six,
            prefix: 'PAWNEE',
            site: 'https://pawnee.atlassian.net',
            project: 'PAWNEE',
            queue: 'TASKS.md',
            dir: 'tickets',
          },
        }).tickets
      ).toEqual({
        source: 'jira',
        statuses: six,
        prefix: 'PAWNEE',
        site: 'https://pawnee.atlassian.net',
        project: 'PAWNEE',
        queue: 'TASKS.md',
        dir: 'tickets',
      });
    });

    it('refuses a ticket folder outside the project', () => {
      expect(refusal({ source: 'markdown', dir: '../elsewhere' })).toMatch(
        /^tickets\.dir must be a path inside the codebase/
      );
    });
  });

  it('drops an unknown key', () => {
    const parsed = ProjectConfigSchema.parse({ ...pawneeConfig, parade: true });

    expect(parsed).toEqual(pawneeConfig);
  });

  it('keeps commands.services', () => {
    expect(
      ProjectConfigSchema.parse({ commands: { services: { web: 'npm run dev' } } })
        .commands?.services
    ).toEqual({ web: 'npm run dev' });
  });

  it('defaults the verdicts and design-system folders with no blocks', () => {
    const parsed = ProjectConfigSchema.parse({});

    expect(parsed.verdicts).toEqual({ dir: '.lambda/verdicts' });
    expect(parsed.design.system).toEqual({
      dir: '.lambda/design-system',
      manifest: '.lambda/design-system/design-system.json',
    });
  });

  it('defaults each folder inside a block that leaves it out', () => {
    const parsed = ProjectConfigSchema.parse({
      verdicts: {},
      design: { system: { build: 'make design OUT={out}' } },
    });

    expect(parsed.verdicts.dir).toBe('.lambda/verdicts');
    expect(parsed.design.system).toEqual({
      dir: '.lambda/design-system',
      manifest: '.lambda/design-system/design-system.json',
      build: 'make design OUT={out}',
    });
  });

  it('puts the default manifest in a configured design-system dir', () => {
    expect(
      ProjectConfigSchema.parse({
        design: { system: { dir: 'design/system' } },
      }).design.system.manifest
    ).toBe('design/system/design-system.json');
  });

  it('refuses a manifest outside the project', () => {
    expect(
      ProjectConfigSchema.safeParse({
        design: { system: { manifest: '../manifest.json' } },
      }).success
    ).toBe(false);
  });

  it('refuses a verdicts dir outside the project', () => {
    expect(
      ProjectConfigSchema.safeParse({ verdicts: { dir: '../elsewhere' } })
        .success
    ).toBe(false);
  });

  it('takes check-ticket as a project-owned building command', () => {
    expect(
      ProjectConfigSchema.parse({ building: { ownCommands: ['check-ticket'] } })
        .building?.ownCommands
    ).toEqual(['check-ticket']);
  });

  // Only a verdict-gated command may be the codebase's own: its ship gate is
  // the one thing that still checks the copy's result.
  it('refuses an ownCommands entry no recorded verdict gates', () => {
    expect(
      ProjectConfigSchema.safeParse({ building: { ownCommands: ['start'] } })
        .success
    ).toBe(false);
  });

  it('fails on a lambda.json that is not JSON', () => {
    const root = tmp();
    const file = path.join(root, 'lambda.json');
    write(file, '{ "tickets": ');

    expect(() => loadProjectConfig(root)).toThrow(`Invalid JSON in ${file}: `);
  });
});

describe('finding the project root', () => {
  it('uses the nearest lambda.json going up', () => {
    const tmpRoot = tmp();
    write(path.join(tmpRoot, 'a', 'lambda.json'), '{}');
    fs.mkdirSync(path.join(tmpRoot, 'a', 'b', 'c'), { recursive: true });

    expect(findProjectRoot(path.join(tmpRoot, 'a', 'b', 'c'))?.root).toBe(
      path.join(tmpRoot, 'a')
    );
  });

  it('prefers a lambda.json further up over a nearer TASKS.md', () => {
    const tmpRoot = tmp();
    write(path.join(tmpRoot, 'a', 'lambda.json'), '{}');
    write(path.join(tmpRoot, 'a', 'b', 'TASKS.md'), '# Tasks\n');
    fs.mkdirSync(path.join(tmpRoot, 'a', 'b', 'c'), { recursive: true });

    expect(findProjectRoot(path.join(tmpRoot, 'a', 'b', 'c'))?.root).toBe(
      path.join(tmpRoot, 'a')
    );
  });

  it('falls back to the nearest TASKS.md, with the defaults', () => {
    const tmpRoot = tmp();
    write(path.join(tmpRoot, 'a', 'b', 'TASKS.md'), '# Tasks\n');
    fs.mkdirSync(path.join(tmpRoot, 'a', 'b', 'c'), { recursive: true });

    const project = loadProjectConfig(path.join(tmpRoot, 'a', 'b', 'c'));

    expect(project?.root).toBe(path.join(tmpRoot, 'a', 'b'));
    expect(project?.file).toBeUndefined();
    expect(project?.config.tickets.source).toBe('markdown');
    expect(project?.config.tmux.session).toBe('lambda');
  });

  it('finds no project with neither', () => {
    const tmpRoot = tmp();
    fs.mkdirSync(path.join(tmpRoot, 'a', 'b'), { recursive: true });

    expect(loadProjectConfig(path.join(tmpRoot, 'a', 'b'))).toBeNull();
  });

  it('reads the main checkout from a linked worktree', () => {
    const tmpRoot = tmp();
    const main = path.join(tmpRoot, 'main');
    const worktree = path.join(tmpRoot, 'pod-worktree');
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Leslie Knope',
      GIT_AUTHOR_EMAIL: 'leslie@pawnee.gov',
      GIT_COMMITTER_NAME: 'Leslie Knope',
      GIT_COMMITTER_EMAIL: 'leslie@pawnee.gov',
    };
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' });
    };
    write(path.join(main, 'lambda.json'), '{}');
    write(path.join(main, 'src', 'parks.ts'), 'export {};\n');
    git(main, ['init', '-q']);
    git(main, ['add', '.']);
    git(main, ['commit', '-q', '-m', 'Pawnee']);
    git(main, ['worktree', 'add', '-q', '--detach', worktree]);

    expect(findProjectRoot(worktree)?.root).toBe(main);
    expect(findProjectRoot(path.join(worktree, 'src'))?.root).toBe(main);
  });
});

describe('pods and knowledge folders', () => {
  const project = (config: object, root = '/pawnee') => ({
    root,
    file: path.join(root, 'lambda.json'),
    config: ProjectConfigSchema.parse(config),
  });

  it('prefers LAMBDA_PODS_ROOT, then pods.root, then .lambda/pods', () => {
    expect(
      resolvePodsRoot(project({ pods: { root: 'var/pods' } }), {
        LAMBDA_PODS_ROOT: '/srv/pods',
      })
    ).toBe('/srv/pods');
    expect(resolvePodsRoot(project({ pods: { root: 'var/pods' } }), {})).toBe(
      '/pawnee/var/pods'
    );
    expect(resolvePodsRoot(project({}), {})).toBe('/pawnee/.lambda/pods');
  });

  it('puts knowledge under the pods root and .lambda/knowledge by default', () => {
    expect(resolveKnowledgeDirs(project({}), {})).toEqual({
      local: '/pawnee/.lambda/pods/_knowledge',
      shared: '/pawnee/.lambda/knowledge',
    });
  });

  it('uses knowledge.local and knowledge.shared when set', () => {
    expect(
      resolveKnowledgeDirs(
        project({ knowledge: { local: 'var/k', shared: 'docs/k' } }),
        {}
      )
    ).toEqual({ local: '/pawnee/var/k', shared: '/pawnee/docs/k' });
  });
});
