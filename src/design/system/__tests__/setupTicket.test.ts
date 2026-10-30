import * as fs from 'fs';
import * as path from 'path';

import {
  type Project,
  ProjectConfigSchema,
} from '../../../config/projectConfig';
import {
  JIRA_FAKE_PROJECT,
  JIRA_FAKE_SITE,
  JIRA_FAKE_STATUSES,
  createJiraFake,
} from '../../../tickets/__tests__/fakes/jiraFake';
import {
  PAWNEE_STATUSES,
  createLinearFake,
} from '../../../tickets/__tests__/fakes/linearFake';
import {
  type SourceContext,
  createTicketSource,
} from '../../../tickets/context';
import { type TicketSource } from '../../../tickets/source';
import { manifestText } from '../manifest';
import {
  HasDesignSystemError,
  SETUP_TICKET_TITLE,
  createSetupTicket,
  setupTicketBody,
} from '../setupTicket';
import { HAND_MADE_MANIFEST } from './fixtures/handMade';
import { cloneOfUpstream, commitAll, initRepo, put, run } from './gitFixture';

const leslie = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };
const MANIFEST = '.lambda/design-system/design-system.json';

const noFetch: typeof fetch = async () => {
  throw new Error('No network call expected.');
};

const TICKETS = { source: 'markdown', prefix: 'PAWNEE' } as const;

/** A clone of an upstream Pawnee parks map, so origin/main exists. */
const fixture = (
  design: Record<string, unknown> = {}
): { project: Project; upstream: string; source: TicketSource } => {
  const { upstream, clone } = cloneOfUpstream({
    'TASKS.md': '# Tasks\n\n',
    'package.json': '{ "name": "pawnee-parks-map" }\n',
  });
  const project: Project = {
    root: clone,
    file: path.join(clone, 'lambda.json'),
    config: ProjectConfigSchema.parse({ tickets: TICKETS, design }),
  };
  const source = createTicketSource({
    root: clone,
    config: project.config.tickets,
    tokens: undefined,
    env: {},
    fetch: noFetch,
    runner: leslie,
  });

  return { project, upstream, source };
};

const make = (project: Project, source: TicketSource) =>
  createSetupTicket({
    project,
    projectName: 'Pawnee parks map',
    by: 'Leslie Knope',
    source,
  });

/** Commit a manifest upstream and fetch it into the clone's origin/main. */
const shipManifest = (
  project: Project,
  upstream: string,
  body: Record<string, unknown>
): void => {
  put(upstream, MANIFEST, manifestText(body));
  commitAll(upstream, 'PAWNEE-12: Make the design system from the app');
  run(project.root, ['fetch', '-q', 'origin']);
};

const EXPECTED_BODY = [
  "Pull the app's look into a new design system. One direction only: from the app to the design system. Never change the app's own code.",
  '',
  'Design system: .lambda/design-system (lambda.json design.system.dir)',
  "There's no design system yet: make one in this folder.",
  'Asked for by Leslie Knope from Settings.',
  '',
  '1. Read the app: lambda design system detect.',
  "2. Write the design system's source in .lambda/design-system: the bundle entry, the catalog, the components it re-exports from the app, the pattern copies (hand-made copies of app pieces that can't run in a canvas), the source map (sources.json), one sample data set (sampleData.ts) and the reference screens (screens/).",
  '3. Build and check it: lambda design system build --check. Fix what it names in the design system, never in the app.',
  '4. Photograph 3 to 5 real screens with the photo hook, draw each as a reference screen with the design system and the sample data, and grade each pair on the visual severity scale.',
  '5. Loop: fix the design system and repeat from step 3 until lambda design system round record says MATCH or CLOSE. Round 7 is the most.',
  "6. Write the manifest with lambda design system manifest write, post the last round's pictures on this ticket, and ship it as usual.",
  '',
  "The full steps are Lambda's design-system-setup instructions.",
].join('\n');

/** A source whose list and create are watched. */
const watched = (source: TicketSource) => {
  const list = jest.fn(source.list.bind(source));
  const create = jest.fn(source.create.bind(source));

  return { source: { ...source, list, create }, list, create };
};

describe('createSetupTicket: the ticket', () => {
  it('creates one ticket in ready with the fixed title and body', async () => {
    const { project, source } = fixture();

    const made = await make(project, source);
    const tickets = await source.list();
    const got = await source.get(made.id);

    expect(made).toMatchObject({
      id: 'PAWNEE-1',
      title: SETUP_TICKET_TITLE,
      status: 'ready',
      existing: false,
    });
    expect(SETUP_TICKET_TITLE).toBe('Make the design system from the app');
    expect(tickets).toHaveLength(1);
    expect(got.status).toBe('ready');
    expect(got.title).toBe('Make the design system from the app');
    expect(got.description.trim()).toBe(EXPECTED_BODY);
    expect(got.reporter?.name).toBe('Leslie Knope');
  });

  it('two Make it presses at once create one ticket; the second gets it as existing', async () => {
    const { project, source } = fixture();
    const spy = watched(source);
    // Each list answers a beat later, so both presses would list before
    // either creates.
    const slow: TicketSource = {
      ...spy.source,
      list: async () => {
        const tickets = await spy.source.list();
        await new Promise((resolve) => setTimeout(resolve, 20));

        return tickets;
      },
    };

    const [first, second] = await Promise.all([
      make(project, slow),
      make(project, slow),
    ]);

    expect(spy.create).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ id: 'PAWNEE-1', existing: false });
    expect(second).toMatchObject({ id: 'PAWNEE-1', existing: true });
    expect(await source.list()).toHaveLength(1);
  });

  it('creates it on a markdown project that has no TASKS.md yet', async () => {
    const { project, source } = fixture();
    fs.rmSync(path.join(project.root, 'TASKS.md'));

    const made = await make(project, source);

    expect(made).toMatchObject({
      id: 'PAWNEE-1',
      title: SETUP_TICKET_TITLE,
      existing: false,
    });
    expect(fs.readFileSync(path.join(project.root, 'TASKS.md'), 'utf8')).toBe(
      `- [ ] PAWNEE-1: ${SETUP_TICKET_TITLE}\n`
    );
  });

  it('holds the six steps and the one-direction rules', () => {
    const body = setupTicketBody({
      dir: '.lambda/design-system',
      by: 'Leslie Knope',
    });

    expect(body).toBe(EXPECTED_BODY);
    [1, 2, 3, 4, 5, 6].forEach((step) =>
      expect(body).toMatch(new RegExp(`^${step}\\. `, 'm'))
    );
    expect(body).not.toMatch(/^7\. /m);
    expect(body).toContain(
      'One direction only: from the app to the design system.'
    );
    expect(body).toContain("Never change the app's own code.");
    expect(body).toContain('Round 7 is the most.');
  });

  it('names design.system.dir in the body', async () => {
    const { project, source } = fixture({ system: { dir: 'src/ds' } });

    const made = await make(project, source);
    const { description } = await source.get(made.id);

    expect(description).toContain(
      'Design system: src/ds (lambda.json design.system.dir)'
    );
    expect(description).toContain(
      "Write the design system's source in src/ds:"
    );
    expect(description).not.toContain('.lambda/design-system');
  });

  it('returns the open ticket while it is ready, then building; a new one once canceled', async () => {
    const { project, source } = fixture();
    const first = await make(project, source);

    expect(await make(project, source)).toMatchObject({
      id: first.id,
      existing: true,
      status: 'ready',
    });

    await source.update(first.id, { status: 'building' });
    expect(await make(project, source)).toMatchObject({
      id: first.id,
      existing: true,
      status: 'building',
    });
    expect(await source.list()).toHaveLength(1);

    await source.update(first.id, { status: 'canceled' });
    const second = await make(project, source);

    expect(second.existing).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect((await source.list()).map(({ status }) => status)).toEqual([
      'canceled',
      'ready',
    ]);
  });

  it('a done setup ticket with still no manifest on main makes a new one', async () => {
    const { project, source } = fixture();
    const first = await make(project, source);
    await source.update(first.id, { status: 'done' });

    expect((await make(project, source)).existing).toBe(false);
  });

  it.each([
    ['a Lambda-made manifest', { namespace: 'PawneeParksMap', version: 3 }],
    ['a hand-made manifest', HAND_MADE_MANIFEST],
  ])(
    'refuses with %s on origin/main, never listing or creating',
    async (_, body) => {
      const { project, upstream, source } = fixture();
      shipManifest(project, upstream, body);
      const spy = watched(source);

      const outcome = await make(project, spy.source).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(outcome).toBeInstanceOf(HasDesignSystemError);
      expect(outcome instanceof Error && outcome.message).toBe(
        'Pawnee parks map already has a design system.'
      );
      expect(spy.list).not.toHaveBeenCalled();
      expect(spy.create).not.toHaveBeenCalled();
      expect(await source.list()).toEqual([]);
    }
  );

  it('reads origin/main, not the working tree: an uncommitted manifest does not count', async () => {
    const { project, source } = fixture();
    put(
      project.root,
      MANIFEST,
      manifestText({ namespace: 'Pawnee', version: 1 })
    );

    expect((await make(project, source)).existing).toBe(false);
  });

  it('a manifest on main that origin has not got yet does not count', async () => {
    const { project, source } = fixture();
    put(
      project.root,
      MANIFEST,
      manifestText({ namespace: 'Pawnee', version: 1 })
    );
    commitAll(project.root, 'Local only');

    expect((await make(project, source)).existing).toBe(false);
  });

  it("returns create's rejection as Couldn't create the design system ticket", async () => {
    const { project, source } = fixture();
    const failing: TicketSource = {
      ...source,
      create: async () => {
        throw new Error('The tracker is down.');
      },
    };

    await expect(make(project, failing)).rejects.toThrow(
      "Couldn't create the design system ticket: The tracker is down."
    );
    expect(await source.list()).toEqual([]);
  });

  it("returns list's rejection the same way, creating nothing", async () => {
    const { project, source } = fixture();
    const spy = watched(source);
    const failing: TicketSource = {
      ...spy.source,
      list: async () => {
        throw new Error('no queue');
      },
    };

    await expect(make(project, failing)).rejects.toThrow(
      "Couldn't create the design system ticket: no queue."
    );
    expect(spy.create).not.toHaveBeenCalled();
  });
});

describe("createSetupTicket on the shared contract suite's Linear and Jira fakes", () => {
  const context = (
    root: string,
    overrides: Partial<SourceContext>
  ): SourceContext => ({
    root,
    config: TICKETS,
    tokens: undefined,
    env: {},
    fetch: noFetch,
    runner: leslie,
    ...overrides,
  });

  const TRACKERS: Array<[string, (root: string) => TicketSource]> = [
    [
      'linear',
      (root) =>
        createTicketSource(
          context(root, {
            config: {
              source: 'linear',
              statuses: PAWNEE_STATUSES,
              team: 'PAWNEE',
              prefix: 'PAWNEE',
            },
            tokens: { linear: 'lin_api_test' },
            fetch: createLinearFake({ viewer: leslie }).fetch,
          })
        ),
    ],
    [
      'jira',
      (root) =>
        createTicketSource(
          context(root, {
            config: {
              source: 'jira',
              statuses: JIRA_FAKE_STATUSES,
              site: JIRA_FAKE_SITE,
              project: JIRA_FAKE_PROJECT,
              prefix: 'PAWNEE',
            },
            tokens: { jira: { email: leslie.email, apiToken: 'jira-test' } },
            fetch: createJiraFake().fetch,
          })
        ),
    ],
  ];

  it.each(TRACKERS)(
    '%s: same title, status and body, and one ticket on a second press',
    async (_, open) => {
      const { project } = fixture();
      const source = open(project.root);

      const made = await make(project, source);
      const got = await source.get(made.id);

      expect(made).toMatchObject({
        title: SETUP_TICKET_TITLE,
        status: 'ready',
        existing: false,
      });
      expect(got.title).toBe(SETUP_TICKET_TITLE);
      expect(got.status).toBe('ready');
      expect(got.description.trim()).toBe(EXPECTED_BODY);
      expect(await make(project, source)).toMatchObject({
        id: made.id,
        existing: true,
      });
    }
  );
});

describe('a project with nothing committed yet', () => {
  it('has no design system, so Make it creates the ticket', async () => {
    const root = initRepo();
    put(root, 'TASKS.md', '# Tasks\n\n');

    try {
      const project: Project = {
        root,
        file: path.join(root, 'lambda.json'),
        config: ProjectConfigSchema.parse({ tickets: TICKETS }),
      };
      const source = createTicketSource({
        root,
        config: project.config.tickets,
        tokens: undefined,
        env: {},
        fetch: noFetch,
        runner: leslie,
      });

      expect(await make(project, source)).toMatchObject({
        title: SETUP_TICKET_TITLE,
        existing: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
