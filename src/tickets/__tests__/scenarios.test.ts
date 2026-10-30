import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Project, ProjectConfigSchema } from '../../config/projectConfig';
import {
  type ScenariosDeps,
  runScenariosPull,
  runScenariosPush,
  sourceDownload,
  upsertScenarioLines,
} from '../scenarios';
import type { TicketSource, TicketWithDescription } from '../source';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-scen-')));

const unused = (name: string) => () => {
  throw new Error(`The fake source has no ${name}.`);
};

/**
 * A tracker in memory: `pull` writes the description to a file, `push`
 * reads it back, `attach` hands out a ref per file.
 */
const fakeTracker = (
  root: string,
  kind: TicketSource['kind'],
  description: string
) => {
  const state: { description: string; attached: string[]; pushed: number } = {
    description,
    attached: [],
    pushed: 0,
  };
  const pulled = path.join(root, '.lambda', 'pulled', 'PAWNEE-5');
  const ticket = (): TicketWithDescription => ({
    id: 'PAWNEE-5',
    title: 'Trail map',
    status: 'building',
    labels: [],
    parent: null,
    children: [],
    blockedBy: [],
    blockReason: null,
    reporter: null,
    url: null,
    priority: 'none',
    assignee: null,
    description: state.description,
  });
  const source: TicketSource = {
    kind,
    projects: async () => [],
    list: unused('list'),
    get: async () => ticket(),
    pull: async () => {
      fs.mkdirSync(pulled, { recursive: true });
      fs.writeFileSync(path.join(pulled, 'description.md'), state.description);

      return pulled;
    },
    push: async () => {
      state.description = fs.readFileSync(
        path.join(pulled, 'description.md'),
        'utf8'
      );
      state.pushed += 1;

      return 'Pushed.';
    },
    create: unused('create'),
    update: unused('update'),
    comments: unused('comments'),
    attach: async (_id, file) => {
      state.attached.splice(state.attached.length, 0, path.basename(file));

      return {
        ref: `https://uploads.linear.app/pawnee/${path.basename(file)}`,
      };
    },
    comment: unused('comment'),
    delete: unused('delete'),
    block: unused('block'),
    unblock: unused('unblock'),
    reorder: unused('reorder'),
    place: unused('place'),
    next: unused('next'),
    queue: unused('queue'),
  };

  return { source, state };
};

const projectAt = (root: string, extra: Record<string, unknown> = {}) =>
  ({
    root,
    file: path.join(root, 'lambda.json'),
    config: ProjectConfigSchema.parse(extra),
  } satisfies Project);

const depsFor = (
  root: string,
  source: TicketSource,
  extra: Partial<ScenariosDeps> = {}
) => {
  const printed: string[] = [];
  const fetched: string[] = [];
  const deps: ScenariosDeps = {
    project: projectAt(root),
    source,
    checkout: root,
    download: async (url) => {
      fetched.splice(fetched.length, 0, url);

      return Buffer.from('{"id":"trail-map-closed"}');
    },
    print: (line) => printed.splice(printed.length, 0, line),
    printError: (line) => printed.splice(printed.length, 0, line),
    ...extra,
  };

  return { deps, printed, fetched };
};

const scenarioFile = (
  root: string,
  name = 'trail-map-closed.scenario.json'
) => {
  const file = path.join(root, 'work', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');

  return file;
};

const WITH_DESIGN = [
  '## What',
  '',
  'Ann sees why the trail is closed.',
  '',
  '## Design',
  '',
  '### Trail map — Trail closed',
  '',
  '![Trail map — Trail closed](https://uploads.linear.app/pawnee/a.png)',
  '',
  'Scenario: trail-map-closed',
  '',
  '1. Why the trail is closed',
  '',
  '### Trail map — All trails open',
  '',
  '![Trail map — All trails open](https://uploads.linear.app/pawnee/b.png)',
  '',
  '## Test plan',
  '',
  'Leslie checks it.',
  '',
].join('\n');

describe('scenarios push', () => {
  it('links the file under ### Screenshot scenarios, once', async () => {
    const root = tmp();
    const { source, state } = fakeTracker(root, 'linear', WITH_DESIGN);
    const { deps } = depsFor(root, source);
    const file = scenarioFile(root);

    expect(await runScenariosPush('PAWNEE-5', [file], deps)).toBe(0);
    expect(await runScenariosPush('PAWNEE-5', [file], deps)).toBe(0);

    const line =
      'scenario: [trail-map-closed.scenario.json](https://uploads.linear.app/pawnee/trail-map-closed.scenario.json)';
    expect(state.description.split(line)).toHaveLength(2);
    expect(state.description).toContain(
      [
        '![Trail map — All trails open](https://uploads.linear.app/pawnee/b.png)',
        '',
        '### Screenshot scenarios',
        '',
        line,
        '',
        '## Test plan',
      ].join('\n')
    );
    expect(state.attached).toEqual([
      'trail-map-closed.scenario.json',
      'trail-map-closed.scenario.json',
    ]);
  });

  it('refuses, attaching nothing, when the pulled description has edits not pushed', async () => {
    const root = tmp();
    const { source, state } = fakeTracker(root, 'linear', WITH_DESIGN);
    const { deps, printed } = depsFor(root, source);
    const editable = path.join(await source.pull('PAWNEE-5'), 'description.md');
    fs.writeFileSync(editable, `${WITH_DESIGN}Ron's edit.\n`);

    expect(await runScenariosPush('PAWNEE-5', [scenarioFile(root)], deps)).toBe(
      1
    );
    expect(state.attached).toEqual([]);
    expect(fs.readFileSync(editable, 'utf8')).toContain("Ron's edit.");
    expect(printed.join('\n')).toMatch(/not pushed/);
  });

  it('adds a ## Screenshot scenarios section when only a Design reference exists', async () => {
    const root = tmp();
    const reference = [
      '## Design reference (checked when ticket 5 is built)',
      '',
      '### Trail map — Trail closed',
      '',
      '![Trail map — Trail closed](https://uploads.linear.app/pawnee/a.png)',
    ].join('\n');
    const { source, state } = fakeTracker(root, 'linear', `${reference}\n`);
    const { deps } = depsFor(root, source);

    expect(await runScenariosPush('PAWNEE-5', [scenarioFile(root)], deps)).toBe(
      0
    );
    expect(
      state.description.startsWith(
        `${reference}\n\n## Screenshot scenarios\n\nscenario: [`
      )
    ).toBe(true);
  });

  it('adds the section at the end with no Design', async () => {
    const root = tmp();
    const { source, state } = fakeTracker(root, 'jira', 'Ann opens the map.\n');
    const { deps } = depsFor(root, source);

    expect(await runScenariosPush('PAWNEE-5', [scenarioFile(root)], deps)).toBe(
      0
    );
    expect(state.description).toMatch(
      /^Ann opens the map\.\n\n## Screenshot scenarios\n\nscenario: \[trail-map-closed\.scenario\.json\]\(.+\)\n$/
    );
  });

  it.each([
    ['a bad name', '../evil.ts'],
    ['a missing file', 'missing-one.scenario.json'],
  ])('refuses %s, attaching nothing', async (_label, name) => {
    const root = tmp();
    const { source, state } = fakeTracker(root, 'linear', WITH_DESIGN);
    const { deps, printed } = depsFor(root, source);
    const good = scenarioFile(root);

    expect(
      await runScenariosPush(
        'PAWNEE-5',
        [good, name.startsWith('..') ? name : path.join(root, 'work', name)],
        deps
      )
    ).toBe(1);
    expect(state.attached).toEqual([]);
    expect(state.pushed).toBe(0);
    expect(printed.join('\n')).toContain(name);
  });

  it('edits a markdown ticket file in place', async () => {
    const root = tmp();
    const ticketFile = path.join(root, 'tickets', 'PAWNEE-5.md');
    fs.mkdirSync(path.dirname(ticketFile), { recursive: true });
    fs.writeFileSync(ticketFile, '# Trail map\n\nAnn opens the map.\n');
    const { source } = fakeTracker(root, 'markdown', '');
    const markdown: TicketSource = {
      ...source,
      pull: async () => 'tickets/PAWNEE-5.md',
      push: async () => 'Nothing to push.',
      attach: async (_id, file) => ({
        ref: `./PAWNEE-5/${path.basename(file)}`,
      }),
    };
    const { deps } = depsFor(root, markdown);

    expect(await runScenariosPush('PAWNEE-5', [scenarioFile(root)], deps)).toBe(
      0
    );
    expect(fs.readFileSync(ticketFile, 'utf8')).toBe(
      '# Trail map\n\nAnn opens the map.\n\n## Screenshot scenarios\n\nscenario: [trail-map-closed.scenario.json](./PAWNEE-5/trail-map-closed.scenario.json)\n'
    );
  });
});

describe('scenarios pull', () => {
  it('skips a link off the source’s own host and a bad name, fetching nothing', async () => {
    const root = tmp();
    const { source } = fakeTracker(
      root,
      'linear',
      [
        'scenario: [trail-map-closed.scenario.json](https://uploads.linear.app.evil.com/x.json)',
        'scenario: [../x.scenario.json](https://uploads.linear.app/pawnee/x.json)',
      ].join('\n')
    );
    const { deps, printed, fetched } = depsFor(root, source);

    await runScenariosPull('PAWNEE-5', deps);

    expect(fetched).toEqual([]);
    expect(printed).toEqual([
      expect.stringMatching(/^Skipped trail-map-closed\.scenario\.json .*evil/),
      expect.stringMatching(/^Skipped \.\.\/x\.scenario\.json/),
    ]);
    expect(
      fs.existsSync(path.join(root, '.lambda', 'scenarios-pending', 'PAWNEE-5'))
    ).toBe(false);
  });

  it('skips a file without the project’s scenario extension', async () => {
    const root = tmp();
    const { source } = fakeTracker(
      root,
      'linear',
      'scenario: [x.scenario.sh](https://uploads.linear.app/pawnee/x.sh)'
    );
    const { deps, printed, fetched } = depsFor(root, source);

    await runScenariosPull('PAWNEE-5', deps);

    expect(fetched).toEqual([]);
    expect(printed).toEqual([
      expect.stringMatching(/^Skipped x\.scenario\.sh .*not a \.json/),
    ]);
  });

  it('downloads each scenario to the pending folder, ignored by git', async () => {
    const root = tmp();
    const { source } = fakeTracker(
      root,
      'linear',
      'scenario: [trail-map-closed.scenario.json](https://uploads.linear.app/pawnee/p.json)\n'
    );
    const { deps, fetched } = depsFor(root, source);

    await runScenariosPull('PAWNEE-5', deps);

    const pending = path.join(root, '.lambda', 'scenarios-pending');
    expect(fetched).toEqual(['https://uploads.linear.app/pawnee/p.json']);
    expect(
      fs.readFileSync(
        path.join(pending, 'PAWNEE-5', 'trail-map-closed.scenario.json'),
        'utf8'
      )
    ).toBe('{"id":"trail-map-closed"}');
    expect(fs.readFileSync(path.join(pending, '.gitignore'), 'utf8')).toBe(
      '*\n'
    );
  });

  it('skips a scenario already in the tracked folder', async () => {
    const root = tmp();
    const tracked = path.join(root, '.lambda', 'scenarios');
    fs.mkdirSync(tracked, { recursive: true });
    fs.writeFileSync(
      path.join(tracked, 'trail-map-closed.scenario.json'),
      '{}'
    );
    const { source } = fakeTracker(
      root,
      'linear',
      'scenario: [trail-map-closed.scenario.json](https://uploads.linear.app/pawnee/p.json)\n'
    );
    const { deps, printed, fetched } = depsFor(root, source);

    await runScenariosPull('PAWNEE-5', deps);

    expect(fetched).toEqual([]);
    expect(printed).toEqual([
      'Skipped trail-map-closed.scenario.json: already in the tracked library',
    ]);
  });

  it('only takes the Jira site’s own host', async () => {
    const root = tmp();
    const { source } = fakeTracker(
      root,
      'jira',
      [
        'scenario: [a.scenario.json](https://pawnee.atlassian.net/rest/api/3/attachment/content/1)',
        'scenario: [b.scenario.json](https://eagleton.atlassian.net/rest/api/3/attachment/content/2)',
      ].join('\n')
    );
    const { deps, fetched } = depsFor(root, source, {
      project: projectAt(root, {
        tickets: {
          source: 'jira',
          site: 'https://pawnee.atlassian.net',
          project: 'PAWNEE',
          statuses: {
            planning: 'Backlog',
            ready: 'Todo',
            building: 'In Progress',
            blocked: 'Blocked',
            done: 'Done',
            canceled: 'Canceled',
          },
        },
      }),
    });

    await runScenariosPull('PAWNEE-5', deps);

    expect(fetched).toEqual([
      'https://pawnee.atlassian.net/rest/api/3/attachment/content/1',
    ]);
  });

  it('copies a markdown ticket’s own file and nothing else', async () => {
    const root = tmp();
    const saved = path.join(root, 'tickets', 'PAWNEE-5');
    fs.mkdirSync(saved, { recursive: true });
    fs.writeFileSync(path.join(saved, 'a.scenario.json'), '{"a":1}');
    const { source } = fakeTracker(
      root,
      'markdown',
      [
        'scenario: [a.scenario.json](./PAWNEE-5/a.scenario.json)',
        'scenario: [b.scenario.json](./PAWNEE-6/b.scenario.json)',
      ].join('\n')
    );
    const { deps, printed, fetched } = depsFor(root, source);

    await runScenariosPull('PAWNEE-5', deps);

    expect(fetched).toEqual([]);
    expect(
      fs.readFileSync(
        path.join(
          root,
          '.lambda',
          'scenarios-pending',
          'PAWNEE-5',
          'a.scenario.json'
        ),
        'utf8'
      )
    ).toBe('{"a":1}');
    expect(printed.join('\n')).toMatch(/Skipped b\.scenario\.json/);
  });

  it('says when there are none', async () => {
    const root = tmp();
    const { source } = fakeTracker(root, 'linear', 'Nothing here.');
    const { deps, printed } = depsFor(root, source);

    await runScenariosPull('PAWNEE-5', deps);

    expect(printed).toEqual(['No screenshot scenarios on PAWNEE-5']);
  });
});

describe('sourceDownload', () => {
  const env = {
    LAMBDA_LINEAR_KEY: 'lin_api_pawnee',
    LAMBDA_JIRA_EMAIL: 'leslie@pawnee.gov',
    LAMBDA_JIRA_TOKEN: 'waffles',
  };
  const statuses = {
    planning: 'Backlog',
    ready: 'Todo',
    building: 'In Progress',
    blocked: 'Blocked',
    done: 'Done',
    canceled: 'Canceled',
  };
  const linear = projectAt('/pawnee', {
    tickets: { source: 'linear', team: 'PAW', statuses },
  });
  const jira = projectAt('/pawnee', {
    tickets: {
      source: 'jira',
      site: 'https://pawnee.atlassian.net',
      project: 'PAWNEE',
      statuses,
    },
  });
  const recording = () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const doFetch: typeof fetch = async (input, init) => {
      calls.splice(calls.length, 0, { url: String(input), init });

      return new Response('{}');
    };

    return { calls, doFetch };
  };

  it.each([
    [linear, 'https://eagleton.example/a.scenario.json'],
    [linear, 'http://uploads.linear.app/a.scenario.json'],
    [jira, 'https://eagleton.atlassian.net/attachment/1'],
    [jira, 'http://pawnee.atlassian.net/attachment/1'],
  ])(
    'never sends the key off its own https host (%#)',
    async (project, url) => {
      const { calls, doFetch } = recording();

      await expect(
        sourceDownload(project, null, env, doFetch)(url)
      ).rejects.toThrow(/Refusing to download/);
      expect(calls).toEqual([]);
    }
  );

  it('sends the key to its own host, refusing redirects', async () => {
    const { calls, doFetch } = recording();

    await sourceDownload(
      linear,
      null,
      env,
      doFetch
    )('https://uploads.linear.app/a.scenario.json');

    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.headers).toEqual({
      Authorization: 'lin_api_pawnee',
    });
  });

  it('asks Jira for the bytes rather than a redirect to its media host', async () => {
    const { calls, doFetch } = recording();

    await sourceDownload(
      jira,
      null,
      env,
      doFetch
    )('https://pawnee.atlassian.net/rest/api/3/attachment/content/1');

    expect(calls[0]?.url).toBe(
      'https://pawnee.atlassian.net/rest/api/3/attachment/content/1?redirect=false'
    );
    expect(calls[0]?.init?.redirect).toBe('error');
  });

  it('refuses a file bigger than a scenario can be', async () => {
    const huge: typeof fetch = async () =>
      new Response(Buffer.alloc(1024 * 1024 + 1));

    await expect(
      sourceDownload(
        linear,
        null,
        env,
        huge
      )('https://uploads.linear.app/a.scenario.json')
    ).rejects.toThrow(/bigger than/);
  });

  it('gives up on a host that never answers', async () => {
    const hangs: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason)
        )
      );

    await expect(
      sourceDownload(
        linear,
        null,
        env,
        hangs,
        20
      )('https://uploads.linear.app/a.scenario.json')
    ).rejects.toThrow(/timed out|aborted/i);
  });
});

describe('upsertScenarioLines', () => {
  it('replaces a linked file’s line where it is', () => {
    const text = 'scenario: [a.scenario.json](https://old)\n';

    expect(
      upsertScenarioLines(text, [
        { file: 'a.scenario.json', ref: 'https://new' },
      ])
    ).toBe('scenario: [a.scenario.json](https://new)\n');
  });

  // A UX sketch quoting what a ticket's `## Design` looks like.
  it.each([
    ['```', '```'],
    ['~~~', '~~~'],
    ['````md', '````'],
  ])('ignores a ## Design inside a %s fence', (open, close) => {
    const text = `## UX\n\n${open}\n## Design\n\n### Trail map\n${close}\n`;

    expect(
      upsertScenarioLines(text, [{ file: 'a.scenario.json', ref: 'https://a' }])
    ).toBe(
      `${text}\n## Screenshot scenarios\n\nscenario: [a.scenario.json](https://a)\n`
    );
  });

  it('a shorter or different fence marker does not close the fence', () => {
    const text = '````\n```\n~~~\n## Design\n````\n';

    expect(
      upsertScenarioLines(text, [{ file: 'a.scenario.json', ref: 'https://a' }])
    ).toBe(
      `${text}\n## Screenshot scenarios\n\nscenario: [a.scenario.json](https://a)\n`
    );
  });

  it('still uses a real ## Design after a closed fence', () => {
    const text = '```\n## Design\n```\n\n## Design\n\nThe map.\n';

    expect(
      upsertScenarioLines(text, [{ file: 'a.scenario.json', ref: 'https://a' }])
    ).toBe(
      `${text}\n### Screenshot scenarios\n\nscenario: [a.scenario.json](https://a)\n`
    );
  });

  it('replaces an indented line instead of adding a second one', () => {
    const text = '  scenario: [a.scenario.json](https://old)\n';

    expect(
      upsertScenarioLines(text, [
        { file: 'a.scenario.json', ref: 'https://new' },
      ])
    ).toBe('scenario: [a.scenario.json](https://new)\n');
  });
});
