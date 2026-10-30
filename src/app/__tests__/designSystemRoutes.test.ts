import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { required } from '../../__tests__/required';
import type { MachineConfig } from '../../config/machineConfig';
import { loadProjectConfig } from '../../config/projectConfig';
import type { Project } from '../../config/projectConfig';
import type * as Detect from '../../design/system/detect';
import { detectStack } from '../../design/system/detect';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  startHarness,
} from '../../mothership/__tests__/harness';
import {
  makeDesignSystem,
  readDesignSystemPage,
} from '../../runner/designSystemSettings';
import { openTicketSource } from '../../tickets/context';
import type { TicketSource } from '../../tickets/source';
import { DesignSystemView } from '../client/SettingsPage';
import {
  type DesignSystemInfo,
  type DesignSystemPage,
  type MadeDesignSystem,
  designSystemControls,
  forProject,
  openTicketLine,
  rereadsDesignSystem,
  showsMakeIt,
  systemLines,
} from '../shared/designSystem';

/**
 * Settings → Design system: the mothership never reads the project folder;
 * the runner holding the project reads the design system as committed on
 * `origin/main` and makes the setup ticket there.
 */

jest.mock('../client/Tip', () => ({
  Tip: ({ children }: { children: unknown }) => children,
}));

// detectStack, still working, but counted.
jest.mock('../../design/system/detect', () => {
  const actual = jest.requireActual<typeof Detect>(
    '../../design/system/detect'
  );

  return { ...actual, detectStack: jest.fn(actual.detectStack) };
});

const PROJECT = 'Pawnee parks map';
const SETUP_TITLE = 'Make the design system from the app';
const MANIFEST = '.lambda/design-system/design-system.json';
const DESIGN_AVAILABLE: MachineConfig = {
  design: {
    available: true,
    typeUrl: 'https://claude.ai/artifact/pawnee-design-type',
    checkedAt: '2026-10-21T12:00:00.000Z',
  },
};

const MANIFEST_JSON = {
  namespace: 'PawneeParksMap',
  version: 1,
  builtFrom: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  syncedBy: 'PAWNEE-12',
  source: 'code+photos',
  check: {
    result: 'close',
    rounds: 3,
    photos: 4,
    issues: [
      {
        severity: 'medium-low',
        where: 'Buttons',
        what: 'corners 4px rounder than the app',
      },
    ],
  },
  components: ['Button', 'Card', 'Input', 'Dialog', 'ParkCard', 'BenchRow'],
  patterns: ['MapView (the real one loads mapbox-gl)'],
};

const SCREENS_INDEX = `export const screens = [
  { id: 'parks', title: 'Parks list', render: () => null },
  { id: 'park', title: "Park page", render: () => null },
  { id: 'map', title: \`Map\`, render: () => null },
];
`;

const sh = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const commitAll = (cwd: string, subject: string): void => {
  sh(cwd, ['add', '-A']);
  sh(cwd, [
    '-c',
    'user.name=Leslie Knope',
    '-c',
    'user.email=leslie@pawnee.gov',
    'commit',
    '--quiet',
    '-m',
    subject,
  ]);
};

const write = (root: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

interface Fixture {
  base: string;
  /** Where origin's commits are made. */
  upstream: string;
  /** The runner's main checkout: a clone, with origin/main. */
  folder: string;
}

/** origin's main, with the codebase's app on it; the checkout is a clone. */
const makeRepos = (
  build: (upstream: string) => void = () => undefined
): Fixture => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-design-system-'))
  );
  const upstream = path.join(base, 'upstream');
  const folder = path.join(base, 'pawnee-parks-map');
  fs.mkdirSync(upstream);
  sh(upstream, ['init', '--quiet', '-b', 'main']);
  write(
    upstream,
    'lambda.json',
    JSON.stringify({
      name: PROJECT,
      tickets: { source: 'markdown', prefix: 'PAWNEE' },
    })
  );
  write(
    upstream,
    'package.json',
    JSON.stringify({
      name: 'pawnee-parks-map',
      dependencies: { react: '^18.3.1', tailwindcss: '^3.4.0' },
    })
  );
  write(upstream, 'TASKS.md', '');
  write(upstream, 'tailwind.config.ts', 'export default { theme: {} };\n');
  write(
    upstream,
    'src/components/Button.tsx',
    'export const Button = () => null;\n'
  );
  write(
    upstream,
    'src/App.tsx',
    "import { Button } from './components/Button';\nexport const App = () => Button();\n"
  );
  commitAll(upstream, 'PAWNEE-1: The parks map');
  build(upstream);
  execFileSync('git', ['clone', '--quiet', upstream, folder]);

  return { base, upstream, folder };
};

/** PAWNEE-12 makes the design system on origin/main. */
const addDesignSystem = (upstream: string): void => {
  write(upstream, MANIFEST, `${JSON.stringify(MANIFEST_JSON, null, 2)}\n`);
  write(upstream, '.lambda/design-system/screens/index.ts', SCREENS_INDEX);
  write(
    upstream,
    '.lambda/design-system/sampleData.ts',
    "export const parks = [{ name: 'Ramsett Park' }];\n"
  );
  commitAll(upstream, `PAWNEE-12: ${SETUP_TITLE}`);
};

const benchRows = (upstream: string): void => {
  write(
    upstream,
    '.lambda/design-system/components/BenchRow.tsx',
    'export const BenchRow = () => null; // opening hours\n'
  );
  commitAll(upstream, "PAWNEE-31: Bench rows show the park's opening hours");
};

const shortSha = (fixture: Fixture): string =>
  sh(fixture.folder, ['rev-parse', 'origin/main']).slice(0, 7);

const machine = () => DESIGN_AVAILABLE;

const sourceIn = (folder: string) => {
  const project = loadProjectConfig(folder);

  if (project === null) {
    throw new Error(`No project at ${folder}`);
  }

  return openTicketSource(project, null);
};

/** The runner's half, as runtime.ts answers these. */
const answerAsRunner = (runner: FakeRunner): void => {
  runner.on('design-system-read', (message) =>
    readDesignSystemPage(String(message.folder), { machine })
  );
  runner.on('design-system-make', (message) =>
    makeDesignSystem(String(message.folder), String(message.by), { machine })
  );
};

const sent = (runner: FakeRunner, type: string) =>
  runner.received.filter((message) => message.type === type);

describe('Settings → Design system routes', () => {
  const state: {
    harness?: Harness;
    runner?: FakeRunner;
    cookie?: string;
    repos?: Fixture;
    projectId?: string;
  } = {};
  const harness = (): Harness => required(state.harness, 'harness');
  const runner = (): FakeRunner => required(state.runner, 'runner');
  const cookie = (): string => required(state.cookie, 'cookie');
  const repos = (): Fixture => required(state.repos, 'repos');
  const projectId = (): string => required(state.projectId, 'projectId');

  /** A fresh mothership, with Leslie's MacBook holding the fixture's checkout. */
  const start = async (fixture: Fixture): Promise<void> => {
    state.repos = fixture;
    state.harness = await startHarness();
    state.runner = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    await runner().next('owner');
    answerAsRunner(runner());
    state.projectId = holdProject(harness(), runner().runnerId, {
      name: PROJECT,
      folder: fixture.folder,
    });
    state.cookie = harness().signIn();
  };

  afterEach(async () => {
    await state.runner?.close();
    await state.harness?.close();

    if (state.repos !== undefined) {
      fs.rmSync(state.repos.base, { recursive: true, force: true });
    }

    state.runner = undefined;
    state.harness = undefined;
    state.repos = undefined;
  });

  const read = () =>
    harness().request('GET', `/api/projects/${projectId()}/design-system`, {
      cookie: cookie(),
    });
  const make = () =>
    harness().request(
      'POST',
      `/api/projects/${projectId()}/design-system/make`,
      { cookie: cookie() }
    );

  it('builds the page from the manifest on origin/main, with the newest change', async () => {
    await start(
      makeRepos((upstream) => {
        addDesignSystem(upstream);
        benchRows(upstream);
      })
    );
    // An uncommitted edit in the main checkout is never read.
    write(
      repos().folder,
      MANIFEST,
      JSON.stringify({ ...MANIFEST_JSON, version: 9, syncedBy: 'PAWNEE-99' })
    );

    const response = await read();

    expect(response.status).toBe(200);
    const page = response.json<DesignSystemPage>();
    expect(sent(runner(), 'design-system-read')).toHaveLength(1);
    expect(page.project).toBe(PROJECT);
    expect(page.branch).toBe('main');
    expect(page.system).toMatchObject({
      version: 1,
      syncedBy: 'PAWNEE-12',
      builtFrom: MANIFEST_JSON.builtFrom,
      check: MANIFEST_JSON.check,
      components: MANIFEST_JSON.components,
      patterns: MANIFEST_JSON.patterns,
      screens: ['Parks list', 'Park page', 'Map'],
      sampleData: true,
      madeByHand: false,
      lastChanged: {
        ticket: 'PAWNEE-31',
        sha: shortSha(repos()),
        rest: "Bench rows show the park's opening hours",
      },
    });
    expect(showsMakeIt(page)).toBe(false);
    expect(page.look).toContain('tailwind.config.ts');

    const lines = systemLines(page).map((line) => line.text);
    expect(lines).toEqual([
      'Version 1 · made by PAWNEE-12 from main@a1b2c3d',
      `Last changed by PAWNEE-31 (main@${shortSha(
        repos()
      )}): Bench rows show the park's opening hours`,
      "Kept in the codebase's code: .lambda/design-system",
      'Kept in step by the build: a ticket that changes how the app looks updates the design system too.',
      'Matches the app, with 1 small difference:',
      'Medium-low · Buttons: corners 4px rounder than the app',
      'Checked against 4 photos · ',
      'Look: colours, fonts and spacing from tailwind.config.ts',
      'Components (6): Button, Card, Input, Dialog, ParkCard, …',
      'Copied by hand (1): MapView (the real one loads mapbox-gl)',
      'Reference screens (3): Parks list, Park page, Map',
      'Sample data: one set, the one every design draws from',
    ]);

    // View-only: no Make it.
    const html = renderToStaticMarkup(
      createElement(DesignSystemView, {
        page,
        made: null,
        busy: false,
        onMake: () => undefined,
      })
    );
    expect(html).not.toContain('Make it');
    expect(html).toContain('pictures on PAWNEE-12');
  });

  it('hides Last changed when the newest commit is the one that made it', async () => {
    await start(makeRepos(addDesignSystem));

    const page = (await read()).json<DesignSystemPage>();

    expect(page.system?.version).toBe(1);
    expect(page.system?.lastChanged).toBeNull();
    expect(
      systemLines(page).some((line) => line.text.startsWith('Last changed'))
    ).toBe(false);
  });

  it('shows a subject with no ticket id whole', async () => {
    await start(
      makeRepos((upstream) => {
        addDesignSystem(upstream);
        write(
          upstream,
          '.lambda/design-system/tokens.css',
          ':root { --park-green: #2f6b3a; }\n'
        );
        commitAll(upstream, 'Tidy the park greens');
      })
    );

    const page = (await read()).json<DesignSystemPage>();

    expect(page.system?.lastChanged).toEqual({
      ticket: 'Tidy the park greens',
      sha: shortSha(repos()),
      rest: '',
    });
    expect(systemLines(page)[1]?.text).toBe(
      `Last changed by Tidy the park greens (main@${shortSha(repos())})`
    );
    expect(showsMakeIt(page)).toBe(false);
  });

  it('offers Make it with no manifest on origin/main, even with one in the checkout', async () => {
    await start(makeRepos());
    write(repos().folder, MANIFEST, JSON.stringify(MANIFEST_JSON));

    const page = (await read()).json<DesignSystemPage>();

    expect(page.system).toBeNull();
    expect(page.setupTicket).toBeNull();
    expect(showsMakeIt(page)).toBe(true);
    expect(page.designAvailable).toBe(true);
    const html = renderToStaticMarkup(
      createElement(DesignSystemView, {
        page,
        made: null,
        busy: false,
        onMake: () => undefined,
      })
    );
    expect(html).toContain(
      'No design system yet. Designs use Claude Design&#x27;s default look.'
    );
    expect(html).toContain('>Make it</button>');
    expect(html).not.toContain('disabled');
  });

  it('greys Make it when Claude Design isn’t available', () => {
    const page: DesignSystemPage = {
      project: PROJECT,
      branch: 'main',
      dir: '.lambda/design-system',
      look: 'tailwind.config.ts',
      components: '1 — Button',
      designAvailable: false,
      setupTicket: null,
      system: null,
      ticketsError: null,
    };
    const html = renderToStaticMarkup(
      createElement(DesignSystemView, {
        page,
        made: null,
        busy: false,
        onMake: () => undefined,
      })
    );

    expect(html).toContain('disabled');
    expect(html).toContain(
      'Needs Claude Design, which isn&#x27;t available with this Claude account.'
    );
  });

  it('shows the open setup ticket and its status instead of Make it', async () => {
    await start(makeRepos());
    await sourceIn(repos().folder).create({
      title: SETUP_TITLE,
      status: 'building',
    });

    const page = (await read()).json<DesignSystemPage>();

    expect(page.system).toBeNull();
    expect(page.setupTicket).toMatchObject({
      id: 'PAWNEE-1',
      title: SETUP_TITLE,
      status: 'building',
    });
    expect(showsMakeIt(page)).toBe(false);
    const html = renderToStaticMarkup(
      createElement(DesignSystemView, {
        page,
        made: null,
        busy: false,
        onMake: () => undefined,
      })
    );
    expect(html).toContain(
      'PAWNEE-1 is open: Make the design system from the app (building). Designs keep using Claude Design&#x27;s default look until it ships.'
    );
    expect(html).not.toContain('Make it</button>');
  });

  it('makes the setup ticket once, and answers the open one after', async () => {
    await start(makeRepos());

    const first = await make();

    expect(first.status).toBe(200);
    expect(sent(runner(), 'design-system-make')).toHaveLength(1);
    expect(sent(runner(), 'design-system-make')[0]).toMatchObject({
      by: 'Leslie Knope',
      folder: repos().folder,
    });
    const made = first.json<{ result: MadeDesignSystem }>().result;
    expect(made).toMatchObject({ title: SETUP_TITLE, existing: false });
    expect(made.id).toMatch(/^PAWNEE-\d+$/);

    const tickets = await sourceIn(repos().folder).list();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ id: made.id, status: 'ready' });

    const html = renderToStaticMarkup(
      createElement(DesignSystemView, {
        page: (await read()).json<DesignSystemPage>(),
        made,
        busy: false,
        onMake: () => undefined,
      })
    );
    expect(html).toContain(
      `Created ${made.id}: Make the design system from the app. It&#x27;s in Ready. Designs use it once it ships.`
    );

    const second = await make();

    expect(second.status).toBe(200);
    expect(second.json<{ result: MadeDesignSystem }>().result).toMatchObject({
      id: made.id,
      title: SETUP_TITLE,
      existing: true,
    });
    expect(await sourceIn(repos().folder).list()).toHaveLength(1);
  });

  it('refuses Make it when origin/main has a design system, creating nothing', async () => {
    await start(makeRepos(addDesignSystem));

    const response = await make();

    expect(response.status).toBe(409);
    expect(response.json().error).toBe(
      'Pawnee parks map already has a design system.'
    );
    expect(await sourceIn(repos().folder).list()).toEqual([]);
  });

  it('says the computer is offline, with no socket message and no ticket', async () => {
    await start(makeRepos());
    const { runnerId } = runner();
    await runner().close();
    await eventually(() => !harness().mothership.relay.isConnected(runnerId));

    const made = await make();
    const page = await read();

    expect(made.status).toBe(409);
    expect(made.json().error).toBe("Leslie's MacBook is offline.");
    expect(page.status).toBe(409);
    expect(page.json().error).toBe("Leslie's MacBook is offline.");
    expect(sent(runner(), 'design-system-make')).toEqual([]);
    expect(sent(runner(), 'design-system-read')).toEqual([]);
    expect(await sourceIn(repos().folder).list()).toEqual([]);
  });

  it("refuses a computer's Make it answer that isn't a ticket", async () => {
    await start(makeRepos());
    runner().on('design-system-make', () => ({ id: 'PAWNEE-1' }));

    const response = await make();

    expect(response.status).toBe(500);
    expect(harness().logs).toEqual([
      expect.stringContaining(
        'Unexpected answer from the computer to design-system-make.'
      ),
    ]);
  });

  it("refuses a computer's page that isn't a design system page", async () => {
    await start(makeRepos());
    runner().on('design-system-read', () => ({ project: PROJECT }));

    const response = await read();

    expect(response.status).toBe(500);
    expect(harness().logs).toEqual([
      expect.stringContaining(
        'Unexpected answer from the computer to design-system-read.'
      ),
    ]);
  });

  it("refuses a computer's page with a malformed field, relaying none of it", async () => {
    await start(makeRepos());
    const good: DesignSystemPage = {
      project: PROJECT,
      branch: 'main',
      dir: '.lambda/design-system',
      look: 'none',
      components: 'none',
      designAvailable: null,
      setupTicket: null,
      system: null,
      ticketsError: null,
    };
    const replies: unknown[] = [
      { ...good, designAvailable: 'yes' },
      {
        ...good,
        setupTicket: {
          id: 'PAWNEE-12',
          title: SETUP_TITLE,
          url: 'javascript:alert(1)',
          status: 'ready',
          blockReason: null,
        },
      },
      { ...good, extra: 'Li’l Sebastian' },
    ];
    runner().on('design-system-read', () => replies.shift());

    expect((await read()).status).toBe(500);
    expect((await read()).status).toBe(500);
    const relayed = await read();
    expect(relayed.status).toBe(200);
    expect(relayed.json()).toEqual(good);
  });

  it('refuses both routes without a session, and both are in the route table', async () => {
    await start(makeRepos());
    const samples = harness().mothership.routes.map(
      (route) => `${route.method} ${route.sample}`
    );

    expect(samples).toEqual(
      expect.arrayContaining([
        'GET /api/projects/prj_1/design-system',
        'POST /api/projects/prj_1/design-system/make',
      ])
    );

    const get = await harness().request(
      'GET',
      `/api/projects/${projectId()}/design-system`
    );
    const post = await harness().request(
      'POST',
      `/api/projects/${projectId()}/design-system/make`
    );

    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
    expect(runner().received.map((message) => message.type)).not.toEqual(
      expect.arrayContaining(['design-system-read'])
    );
    expect(sent(runner(), 'design-system-make')).toEqual([]);
  });
});

describe('Settings → Design system, read on the runner', () => {
  const state: { repos?: Fixture } = {};
  const repos = (): Fixture => required(state.repos, 'repos');

  afterEach(() => {
    if (state.repos !== undefined) {
      fs.rmSync(state.repos.base, { recursive: true, force: true });
    }

    state.repos = undefined;
    jest.mocked(detectStack).mockClear();
  });

  const SCREENS_WITH_SITUATIONS = `export const screens = [
  {
    file: 'ParksList.tsx',
    title: 'Parks list',
    situations: [
      { slug: 'empty', title: 'No parks yet' },
      { slug: 'full', title: 'Every park in Pawnee' },
    ],
    path: [{ step: 'open', action: 'Open Parks' }],
  },
  {
    file: 'Park.tsx',
    title: 'Park page',
    situations: [{ slug: 'closed', title: 'Ramsett Park, closed' }],
  },
];
`;

  it('lists only the screens, never their situations', async () => {
    state.repos = makeRepos((upstream) => {
      addDesignSystem(upstream);
      write(
        upstream,
        '.lambda/design-system/screens/index.ts',
        SCREENS_WITH_SITUATIONS
      );
      commitAll(upstream, 'PAWNEE-14: Situations on the reference screens');
    });

    const page = await readDesignSystemPage(repos().folder, { machine });

    expect(page.system?.screens).toEqual(['Parks list', 'Park page']);
    expect(systemLines(page).map((line) => line.text)).toContain(
      'Reference screens (2): Parks list, Park page'
    );
  });

  it("prefers the manifest's screens when it lists them", async () => {
    state.repos = makeRepos((upstream) => {
      addDesignSystem(upstream);
      write(
        upstream,
        MANIFEST,
        JSON.stringify({ ...MANIFEST_JSON, screens: ['Parks list', 'Map'] })
      );
      write(
        upstream,
        '.lambda/design-system/screens/index.ts',
        SCREENS_WITH_SITUATIONS
      );
      commitAll(upstream, 'PAWNEE-15: The manifest names its screens');
    });

    const page = await readDesignSystemPage(repos().folder, { machine });

    expect(page.system?.screens).toEqual(['Parks list', 'Map']);
  });

  const failingSource = (project: Project): TicketSource => ({
    ...openTicketSource(project, null),
    list: () => Promise.reject(new Error('The tracker is down.')),
  });

  it('still shows a design system when the tickets can’t be read', async () => {
    state.repos = makeRepos(addDesignSystem);

    const page = await readDesignSystemPage(repos().folder, {
      machine,
      openSource: failingSource,
    });

    expect(page.system?.version).toBe(1);
    expect(page.setupTicket).toBeNull();
    expect(page.ticketsError).toBe(
      "Couldn't read the codebase's tickets: The tracker is down."
    );
    expect(systemLines(page).map((line) => line.text)).toContain(
      "Couldn't read the codebase's tickets: The tracker is down."
    );
  });

  it('fails the page with no design system when the tickets can’t be read', async () => {
    state.repos = makeRepos();

    await expect(
      readDesignSystemPage(repos().folder, {
        machine,
        openSource: failingSource,
      })
    ).rejects.toThrow('The tracker is down.');
  });

  it('hides Last changed for the commit that made it, even after a rename', async () => {
    state.repos = makeRepos((upstream) => {
      write(upstream, 'old/design-system.json', JSON.stringify(MANIFEST_JSON));
      commitAll(upstream, 'PAWNEE-11: A design system in the old folder');
      fs.mkdirSync(path.join(upstream, '.lambda/design-system'), {
        recursive: true,
      });
      sh(upstream, ['mv', 'old/design-system.json', MANIFEST]);
      commitAll(upstream, `PAWNEE-12: ${SETUP_TITLE}`);
    });

    const page = await readDesignSystemPage(repos().folder, { machine });

    expect(page.system?.lastChanged).toBeNull();
  });

  it('detects the stack once per commit on origin/main', async () => {
    state.repos = makeRepos(addDesignSystem);

    const first = await readDesignSystemPage(repos().folder, { machine });
    const second = await readDesignSystemPage(repos().folder, { machine });

    expect(jest.mocked(detectStack)).toHaveBeenCalledTimes(1);
    expect(second.look).toBe(first.look);
    expect(second.components).toBe(first.components);

    benchRows(repos().upstream);
    sh(repos().folder, ['fetch', '--quiet']);
    await readDesignSystemPage(repos().folder, { machine });

    expect(jest.mocked(detectStack)).toHaveBeenCalledTimes(2);
  });
});

describe('which runner Make it relays to', () => {
  const state: {
    harness?: Harness;
    macBook?: FakeRunner;
    macMini?: FakeRunner;
    repos?: Fixture;
    projectId?: string;
    cookie?: string;
  } = {};
  const harness = (): Harness => required(state.harness, 'harness');
  const macBook = (): FakeRunner => required(state.macBook, 'macBook');
  const macMini = (): FakeRunner => required(state.macMini, 'macMini');
  const repos = (): Fixture => required(state.repos, 'repos');
  const projectId = (): string => required(state.projectId, 'projectId');
  const cookie = (): string => required(state.cookie, 'cookie');

  const lastSeen = (runner: FakeRunner, at: number): void => {
    harness()
      .db.prepare('UPDATE runners SET last_seen_at = ? WHERE id = ?')
      .run(at, runner.runnerId);
  };
  const currentProject = (runner: FakeRunner, id: string | null): void => {
    harness()
      .db.prepare('UPDATE runners SET current_project_id = ? WHERE id = ?')
      .run(id, runner.runnerId);
  };

  beforeEach(async () => {
    state.repos = makeRepos();
    state.harness = await startHarness();
    state.macBook = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    await macBook().next('owner');
    state.macMini = await connectRunner(harness(), {
      name: "Leslie's Mac mini",
    });
    await macMini().next('owner');
    answerAsRunner(macBook());
    answerAsRunner(macMini());
    // The MacBook is on another project.
    const eagleton = holdProject(harness(), macBook().runnerId, {
      name: 'Eagleton parks',
      folder: path.join(repos().base, 'eagleton'),
    });
    state.projectId = holdProject(harness(), macBook().runnerId, {
      name: PROJECT,
      folder: repos().folder,
      current: false,
    });
    currentProject(macBook(), eagleton);
    state.cookie = harness().signIn();
  });

  afterEach(async () => {
    await state.macBook?.close();
    await state.macMini?.close();
    await state.harness?.close();
    fs.rmSync(repos().base, { recursive: true, force: true });
  });

  const make = () =>
    harness().request(
      'POST',
      `/api/projects/${projectId()}/design-system/make`,
      { cookie: cookie() }
    );
  const read = () =>
    harness().request('GET', `/api/projects/${projectId()}/design-system`, {
      cookie: cookie(),
    });

  /** The Mac mini holds Pawnee parks map too, in the same checkout. */
  const macMiniHolds = (current: boolean): void => {
    holdProject(harness(), macMini().runnerId, {
      name: PROJECT,
      folder: repos().folder,
      current,
    });
  };

  it('goes to the runner on the project, even when the other was seen later', async () => {
    macMiniHolds(true);
    lastSeen(macMini(), 1000);
    lastSeen(macBook(), 2000);

    const response = await make();

    expect(response.status).toBe(200);
    expect(sent(macMini(), 'design-system-make')).toHaveLength(1);
    expect(sent(macBook(), 'design-system-make')).toEqual([]);

    lastSeen(macMini(), 1000);
    lastSeen(macBook(), 2000);
    expect((await read()).status).toBe(200);
    expect(sent(macMini(), 'design-system-read')).toHaveLength(1);
    expect(sent(macBook(), 'design-system-read')).toEqual([]);
  });

  it('else goes to the runner seen most recently', async () => {
    macMiniHolds(false);
    currentProject(macMini(), null);
    lastSeen(macMini(), 1000);
    lastSeen(macBook(), 2000);

    expect((await make()).status).toBe(200);
    expect(sent(macBook(), 'design-system-make')).toHaveLength(1);
    expect(sent(macMini(), 'design-system-make')).toEqual([]);

    lastSeen(macMini(), 3000);
    lastSeen(macBook(), 2000);
    expect((await read()).status).toBe(200);
    expect(sent(macMini(), 'design-system-read')).toHaveLength(1);
    expect(sent(macBook(), 'design-system-read')).toEqual([]);
  });

  it('goes to the MacBook when only it holds the project', async () => {
    const response = await make();

    expect(response.status).toBe(200);
    expect(sent(macBook(), 'design-system-make')).toHaveLength(1);
    expect(sent(macMini(), 'design-system-make')).toEqual([]);
  });

  it('says the MacBook is offline when its only runner is disconnected', async () => {
    const { runnerId } = macBook();
    await macBook().close();
    await eventually(() => !harness().mothership.relay.isConnected(runnerId));

    const response = await make();

    expect(response.status).toBe(409);
    expect(response.json().error).toBe("Leslie's MacBook is offline.");
    expect(sent(macBook(), 'design-system-make')).toEqual([]);
    expect(sent(macMini(), 'design-system-make')).toEqual([]);
    expect(await sourceIn(repos().folder).list()).toEqual([]);
  });
});

describe('Settings → Design system, the other states', () => {
  const system: DesignSystemInfo = {
    version: 2,
    madeByHand: false,
    syncedBy: 'PAWNEE-12',
    builtFrom: 'a1b2c3d',
    source: 'code',
    check: { result: 'match', rounds: 2, photos: 4, issues: [] },
    components: [],
    patterns: [],
    screens: [],
    sampleData: false,
    lastChanged: null,
    picturesUrl: null,
  };
  const page = (fields: Partial<DesignSystemInfo>): DesignSystemPage => ({
    project: PROJECT,
    branch: 'main',
    dir: '.lambda/design-system',
    look: 'none',
    components: 'none',
    designAvailable: true,
    setupTicket: null,
    system: { ...system, ...fields },
    ticketsError: null,
  });
  const texts = (fields: Partial<DesignSystemInfo>): string[] =>
    systemLines(page(fields)).map((line) => line.text);

  it('says when it was made from photos only, or not checked', () => {
    expect(
      texts({
        source: 'photos',
        check: {
          result: 'not-checked',
          rounds: 0,
          photos: 0,
          issues: [],
          reason:
            'this codebase has no photo hook (commands.shot in lambda.json)',
        },
      })
    ).toEqual(
      expect.arrayContaining([
        "Made from photos only: Lambda couldn't find this app's theme or components in the code, so designs look like the app but use stand-in parts.",
        'Not checked against the app: this codebase has no photo hook (commands.shot in lambda.json).',
      ])
    );
  });

  it('says a design system with no version was made by hand', () => {
    const lines = texts({
      version: null,
      madeByHand: true,
      syncedBy: null,
      check: null,
    });

    expect(lines[0]).toBe('Made by hand, not by Lambda.');
    expect(lines.some((line) => line.startsWith('Version'))).toBe(false);
  });

  it('links the pictures on the ticket that made it', () => {
    const photos = systemLines(
      page({ picturesUrl: 'https://linear.app/pawnee/issue/PAWNEE-12' })
    ).find((line) => line.text.startsWith('Checked against'));

    expect(photos).toEqual({
      text: 'Checked against 4 photos · ',
      link: {
        label: 'pictures on PAWNEE-12',
        url: 'https://linear.app/pawnee/issue/PAWNEE-12',
      },
    });
  });

  it('says a blocked setup ticket is blocked, and why', () => {
    expect(
      openTicketLine({
        id: 'PAWNEE-12',
        title: SETUP_TITLE,
        url: null,
        status: 'blocked',
        blockReason:
          "after 7 rounds the design system still didn't match the app. High · Header: dark green bar, the app's is white.",
      })
    ).toBe(
      "PAWNEE-12 is blocked: after 7 rounds the design system still didn't match the app. High · Header: dark green bar, the app's is white. Designs keep using Claude Design's default look."
    );
  });
});

describe('Settings → Design system, a failed Make it', () => {
  const MAKE_FAILED =
    "Couldn't create the design system ticket: The tracker is down.";

  it("isn't retried on the heartbeat, so its message stays", () => {
    expect(rereadsDesignSystem({ readError: null, busy: false })).toBe(false);
  });

  it('a failed read is still retried on the heartbeat, but not while busy', () => {
    const offline = "Leslie's MacBook is offline.";

    expect(rereadsDesignSystem({ readError: offline, busy: false })).toBe(true);
    expect(rereadsDesignSystem({ readError: offline, busy: true })).toBe(false);
  });

  it('keeps its message to the project it was pressed on', () => {
    const answered = { projectId: 'prj_parks', value: MAKE_FAILED };

    expect(forProject(answered, 'prj_parks')).toBe(MAKE_FAILED);
    expect(forProject(answered, 'prj_bakery')).toBeNull();
    expect(forProject(null, 'prj_parks')).toBeNull();
  });
});

describe('Settings → Design system, a Make it answer after a project change', () => {
  const made: MadeDesignSystem = {
    id: 'PAWNEE-12',
    title: SETUP_TITLE,
    url: null,
    existing: false,
  };

  it('shows the created ticket only on the project it was made for', () => {
    const answered = { projectId: 'prj_parks', value: made };

    expect(forProject(answered, 'prj_parks')).toBe(made);
    expect(forProject(answered, 'prj_bakery')).toBeNull();
  });
});

describe('Settings → Design system, Claude Design on this computer', () => {
  const state: { repos?: Fixture; home?: string } = {};
  const repos = (): Fixture => required(state.repos, 'repos');
  const lambdaHome = process.env.LAMBDA_HOME;

  /** A `LAMBDA_HOME` for this test, holding `config` when given. */
  const homeWith = (config?: string): void => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-home-'));

    if (config !== undefined) {
      fs.writeFileSync(path.join(home, 'config.json'), config);
    }

    state.home = home;
    process.env.LAMBDA_HOME = home;
  };

  afterEach(() => {
    process.env.LAMBDA_HOME = lambdaHome;

    for (const dir of [state.repos?.base, state.home]) {
      if (dir !== undefined) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    state.repos = undefined;
    state.home = undefined;
    jest.restoreAllMocks();
  });

  const view = (page: DesignSystemPage): string =>
    renderToStaticMarkup(
      createElement(DesignSystemView, {
        page,
        made: null,
        busy: false,
        onMake: () => undefined,
      })
    );

  it('says unknown, not missing, on a computer that never checked, and Make it works', async () => {
    state.repos = makeRepos();
    homeWith();

    const page = await readDesignSystemPage(repos().folder);

    expect(page.designAvailable).toBeNull();
    expect(view(page)).toContain('>Make it</button>');
    expect(view(page)).not.toContain('disabled');
  });

  it('greys Make it only when Claude Design was found missing', () => {
    const page: DesignSystemPage = {
      project: PROJECT,
      branch: 'main',
      dir: '.lambda/design-system',
      look: 'none',
      components: 'none',
      designAvailable: null,
      setupTicket: null,
      system: null,
      ticketsError: null,
    };

    expect(view(page)).not.toContain('Needs Claude Design');
    expect(view({ ...page, designAvailable: false })).toContain('disabled');
  });

  it('still reads the page when ~/.lambda/config.json is malformed', async () => {
    state.repos = makeRepos(addDesignSystem);
    homeWith('{ not json');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await readDesignSystemPage(repos().folder);

    expect(page.system?.version).toBe(1);
    expect(page.designAvailable).toBeNull();
  });

  it('links the pictures on an archived setup ticket, from the tracker', async () => {
    state.repos = makeRepos(addDesignSystem);
    const url = 'https://linear.app/pawnee/issue/PAWNEE-12';
    const asked: string[] = [];
    const archived = (project: Project): TicketSource => ({
      ...openTicketSource(project, null),
      list: () => Promise.resolve([]),
      get: (id: string) => {
        asked.splice(asked.length, 0, id);

        return Promise.resolve({
          id,
          title: SETUP_TITLE,
          status: 'done',
          labels: [],
          parent: null,
          children: [],
          blockedBy: [],
          blockReason: null,
          reporter: null,
          url,
          priority: 'none',
          assignee: null,
          description: '',
        });
      },
    });

    const page = await readDesignSystemPage(repos().folder, {
      machine,
      openSource: archived,
    });

    expect(asked).toEqual(['PAWNEE-12']);
    expect(page.system?.picturesUrl).toBe(url);
  });
});

describe('Settings → Design system, the page’s reads and Make it', () => {
  const PAGE: DesignSystemPage = {
    project: PROJECT,
    branch: 'main',
    dir: '.lambda/design-system',
    look: 'none',
    components: 'none',
    designAvailable: true,
    setupTicket: null,
    system: null,
    ticketsError: null,
  };
  const MADE: MadeDesignSystem = {
    id: 'PAWNEE-12',
    title: SETUP_TITLE,
    url: null,
    existing: false,
  };

  /** Controls over fakes; `calls` records every target call in order. */
  const controlsWith = (io: {
    read?: () => Promise<DesignSystemPage>;
    make?: () => Promise<MadeDesignSystem>;
  }) => {
    const calls: [string, unknown][] = [];
    const record =
      (kind: string) =>
      (value: unknown): void => {
        calls.splice(calls.length, 0, [kind, value]);
      };
    const controls = designSystemControls({
      read: io.read ?? (() => Promise.resolve(PAGE)),
      make: io.make ?? (() => Promise.resolve(MADE)),
      load: async (request) => {
        calls.splice(calls.length, 0, ['load', null]);
        await request.then(record('page'), (caught: unknown) =>
          record('error')(String(caught))
        );
      },
      errorText: (caught) =>
        caught instanceof Error ? caught.message : String(caught),
      shown: () => 'prj_parks',
      target: {
        page: record('page'),
        error: record('error'),
        made: record('made'),
        makeError: record('makeError'),
        busy: record('busy'),
        reading: record('reading'),
      },
    });

    return { calls, controls };
  };

  it("clears the last project's page and error on a project change", async () => {
    const { calls, controls } = controlsWith({});

    await controls.open('prj_bakery');

    const beforeRead = calls.slice(
      0,
      calls.findIndex(([kind]) => kind === 'load')
    );
    expect(beforeRead).toEqual(
      expect.arrayContaining([
        ['page', null],
        ['error', null],
      ])
    );
  });

  it('reads the page again after a failed Make it, keeping its message', async () => {
    const { calls, controls } = controlsWith({
      make: () => Promise.reject(new Error('Conflict: it exists.')),
    });

    await controls.make('prj_parks');

    const failed = calls.findIndex(([kind]) => kind === 'makeError');
    expect(calls.slice(failed).map(([kind]) => kind)).toEqual(
      expect.arrayContaining(['makeError', 'load', 'page'])
    );
    expect(calls.filter(([kind]) => kind === 'makeError').at(-1)).toEqual([
      'makeError',
      { projectId: 'prj_parks', value: 'Conflict: it exists.' },
    ]);
  });

  it('says a read is on its way, so the heartbeat doesn’t stack another', async () => {
    const answer: { resolve: (page: DesignSystemPage) => void } = {
      resolve: () => undefined,
    };
    const { calls, controls } = controlsWith({
      read: () =>
        new Promise<DesignSystemPage>((resolve) => {
          answer.resolve = resolve;
        }),
    });

    const reading = controls.read('prj_parks');
    expect(calls).toContainEqual(['reading', true]);
    answer.resolve(PAGE);
    await reading;
    expect(calls.at(-1)).toEqual(['reading', false]);
  });

  it('keeps "Created …" when the read after it fails', () => {
    const html = renderToStaticMarkup(
      createElement(DesignSystemView, {
        page: null,
        made: MADE,
        busy: false,
        onMake: () => undefined,
      })
    );

    expect(html).toContain('Created PAWNEE-12');
  });
});
