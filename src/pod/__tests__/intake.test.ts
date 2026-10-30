/**
 * The one-box "New pod" read through the codebase's ticket source (markdown
 * here, no tracker key), freeform → structured, the owner's skips, and a name
 * the owner chose staying theirs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadProjectConfig } from '../../config/projectConfig';
import { type Pod, createPodStore } from '../../pod-store';
import { openTicketSource } from '../../tickets/context';
import * as epic from '../../tickets/epic';
import { type TicketSource } from '../../tickets/source';
import {
  configuredTicketKeys,
  openingMessage,
  readIntake,
  runProposeStructure,
  runSkip,
  runStructure,
  ticketIds,
} from '../intake';
import { runNew, runRename } from '../lifecycle';
import { sendMessage } from '../messaging';
import { usePodProject } from './podProject';

// No tmux in tests: the manager is told by message, and agents start nowhere.
jest.mock('../messaging', () => ({
  sendMessage: jest.fn(async () => ({ id: 'm1' })),
  deliverEntry: jest.fn(),
  chatTopic: jest.fn(),
}));
jest.mock('../launch', () => ({
  ...jest.requireActual('../launch'),
  launchAgent: jest.fn(async () => true),
}));

const mockSend = jest.mocked(sendMessage);

const POD = 'pawnee-a1b2';

const TASKS = [
  '# Pawnee Parks app',
  '',
  '- [ ] PAWNEE-16: Park map page',
  '  - [ ] PAWNEE-17: Pins for each park',
  '- [ ] PAWNEE-84: Lot 48 photo gallery',
  '- [ ] PAWNEE-83: Volunteer sign-up form',
  '- [ ] PAWNEE-80: Ice Town hours',
  '- [ ] dog-park-3: A dog park in Pawnee',
  '',
].join('\n');

/** A markdown-tickets project (no tracker key anywhere); the current folder. */
const markdownProject = (): { root: string; source: TicketSource } => {
  const root = usePodProject({ tickets: { source: 'markdown' } });
  fs.writeFileSync(path.join(root, 'TASKS.md'), TASKS);
  const project = loadProjectConfig(root);

  if (project === null) {
    throw new Error('No project.');
  }

  return { root, source: openTicketSource(project, null, {}) };
};

const pod = (overrides: Partial<Pod> = {}): Pod => ({
  id: POD,
  slug: 'pawnee',
  createdAt: '2026-10-09T00:00:00.000Z',
  status: 'active',
  phase: 1,
  completedCheckpoints: [],
  worktreePath: '/tmp/pawnee',
  ownsWorktree: false,
  managerCwd: '/tmp/pawnee',
  devCwd: '/tmp/pawnee',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  pipeline: 2,
  ...overrides,
});

const saved = { ...process.env };

const withPod = (value: Pod, agent?: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-intake-'));
  const store = createPodStore(root);
  store.writePod(value);
  process.env.LAMBDA_PODS_ROOT = root;
  delete process.env.POD_ID;
  delete process.env.POD_AGENT;

  if (agent !== undefined) {
    process.env.POD_ID = POD;
    process.env.POD_AGENT = agent;
  }

  return store;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation();
});

afterEach(() => {
  process.env = { ...saved };
  jest.restoreAllMocks();
});

describe('readIntake — what the one box is about', () => {
  it('no ticket id: a new idea, named from its first words', async () => {
    const { source } = markdownProject();
    const get = jest.spyOn(source, 'get');

    expect(
      await readIntake(
        'Volunteers should see closed trails on the map',
        false,
        source
      )
    ).toMatchObject({
      source: 'idea',
      title: 'Volunteers should see closed trails on',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('one id with children is an epic; without, a lone ticket — named after it', async () => {
    const { source } = markdownProject();

    expect(
      await readIntake('plan PAWNEE-16 please', false, source)
    ).toMatchObject({
      source: 'epic',
      epicId: 'PAWNEE-16',
      title: 'Park map page',
    });
    expect(await readIntake('PAWNEE-84', false, source)).toMatchObject({
      source: 'ticket',
      epicId: 'PAWNEE-84',
    });
  });

  it('several ids are a batch, in the order given, each once — unless one pod was asked for', async () => {
    const { source } = markdownProject();

    expect(
      await readIntake(
        'PAWNEE-84, PAWNEE-83 and pawnee-84 again, PAWNEE-80',
        false,
        source
      )
    ).toEqual({
      source: 'batch',
      tickets: ['PAWNEE-84', 'PAWNEE-83', 'PAWNEE-80'],
      title: 'Batch of 3 tickets',
      slug: 'batch-3',
    });
    expect(
      await readIntake('PAWNEE-84 is like PAWNEE-83', true, source)
    ).toMatchObject({ source: 'ticket', epicId: 'PAWNEE-84' });
  });

  it('keeps a lowercase markdown id exactly as it is', async () => {
    const { source } = markdownProject();

    expect(await readIntake('dog-park-3', false, source)).toMatchObject({
      source: 'ticket',
      epicId: 'dog-park-3',
      slug: 'dog-park-3',
    });
  });

  it('an id the ticket source cannot find fails before any pod exists', async () => {
    const { source } = markdownProject();

    await expect(readIntake('PAWNEE-9999', false, source)).rejects.toThrow(
      'ticket PAWNEE-9999 not found. Nothing was created.'
    );
    await expect(
      readIntake('PAWNEE-84 and PAWNEE-9999', false, source)
    ).rejects.toThrow('ticket PAWNEE-9999 not found. Nothing was created.');
  });

  it("reads id-shaped words that aren't the codebase's as part of the idea", async () => {
    const { source } = markdownProject();
    const get = jest.spyOn(source, 'get');

    expect(
      await readIntake(
        'Support Windows-11 and x86-64 kiosks, follow-up-2 from the forum',
        false,
        source
      )
    ).toMatchObject({ source: 'idea' });
    expect(get).not.toHaveBeenCalled();
  });

  it('with no key configured, an id on a stem the project has still fails loudly', async () => {
    const { source } = markdownProject();

    await expect(
      readIntake('plan dog-park-99 on Windows-11', false, source)
    ).rejects.toThrow('ticket dog-park-99 not found. Nothing was created.');
  });

  it("with the codebase's keys, only ids on those keys count, and no list is read", async () => {
    const { source } = markdownProject();
    const list = jest.spyOn(source, 'list');

    // dog-park-3 isn't on the key, so it's words here.
    expect(
      await readIntake('plan PAWNEE-84 like dog-park-3', false, source, [
        'PAWNEE',
      ])
    ).toMatchObject({ source: 'ticket', epicId: 'PAWNEE-84' });
    await expect(
      readIntake('PAWNEE-99 on Windows-11', false, source, ['PAWNEE'])
    ).rejects.toThrow('ticket PAWNEE-99 not found. Nothing was created.');
    // The key matches in any case, so a mistyped case is looked up (and
    // refused by an exact-id source), never quietly read as words.
    await expect(
      readIntake('plan pawnee-84', false, source, ['PAWNEE'])
    ).rejects.toThrow('ticket pawnee-84 not found. Nothing was created.');
    expect(list).not.toHaveBeenCalled();
  });

  it("ticketIds reads a sub-ticket's id with its letter", () => {
    expect(
      ticketIds('About PAWNEE-2a Park map page, and PAWNEE-12b too')
    ).toEqual(['PAWNEE-2a', 'PAWNEE-12b']);
  });

  it('ticketIds ignores things that only look close', () => {
    expect(ticketIds('see PAWNEE-12 and v2-beta, not H-1')).toEqual([
      'PAWNEE-12',
    ]);
  });
});

describe('lambda pod new with an id that is not a ticket', () => {
  it.each([
    ['--ticket', { ticket: 'PAWNEE-99' }],
    ['--epic', { epic: 'PAWNEE-99' }],
    ['--text', { text: 'plan PAWNEE-99 please' }],
  ])('%s: refused, and nothing is created', async (_flag, options) => {
    const { root, source } = markdownProject();
    const project = loadProjectConfig(root);

    if (project === null) {
      throw new Error('No project.');
    }

    await expect(
      runNew(
        'pawnee-dog-park',
        { launch: true, ...options },
        { project, tickets: () => source, print: () => undefined }
      )
    ).rejects.toThrow('ticket PAWNEE-99 not found. Nothing was created.');
    expect(fs.existsSync(path.join(root, '.lambda'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it("--text uses lambda.json's ticket prefix to tell ids from words", async () => {
    const root = usePodProject({
      tickets: { source: 'markdown', prefix: 'PAWNEE' },
    });
    fs.writeFileSync(
      path.join(root, 'TASKS.md'),
      TASKS.replace('- [ ] dog-park-3: A dog park in Pawnee\n', '')
    );
    const project = loadProjectConfig(root);

    if (project === null) {
      throw new Error('No project.');
    }

    const source = openTicketSource(project, null, {});
    const list = jest.spyOn(source, 'list');

    expect(configuredTicketKeys(project.config.tickets)).toEqual(['PAWNEE']);
    await expect(
      runNew(
        'pawnee-dog-park',
        { launch: true, text: 'plan PAWNEE-99 for Windows-11' },
        { project, tickets: () => source, print: () => undefined }
      )
    ).rejects.toThrow('ticket PAWNEE-99 not found. Nothing was created.');
    expect(list).not.toHaveBeenCalled();
  });

  it('--ticket reads a markdown ticket and its children, and starts planning both', async () => {
    const { root, source } = markdownProject();
    const project = loadProjectConfig(root);

    if (project === null) {
      throw new Error('No project.');
    }

    const lookup = jest.spyOn(epic, 'findEpic');

    await runNew(
      'park-map',
      { launch: true, ticket: 'PAWNEE-16' },
      { project, tickets: () => source, print: () => undefined }
    );

    expect(lookup).toHaveBeenCalledWith(source, 'PAWNEE-16');
    await expect(lookup.mock.results[0]?.value).resolves.toMatchObject({
      id: 'PAWNEE-16',
      children: ['PAWNEE-17'],
    });
    const store = createPodStore(path.join(root, '.lambda', 'pods'));
    const [id] = store.listPodIds();

    expect(id === undefined ? undefined : store.requirePod(id)).toMatchObject({
      source: 'ticket',
      epicId: 'PAWNEE-16',
    });
    expect((await source.get('PAWNEE-16')).children).toEqual(['PAWNEE-17']);
    expect((await source.get('PAWNEE-16')).status).toBe('planning');
    expect((await source.get('PAWNEE-17')).status).toBe('planning');
    expect((await source.get('PAWNEE-84')).status).toBe('ready');
  });

  it('--ticket reads a markdown ticket and keeps its id as the source gives it', async () => {
    const { root, source } = markdownProject();
    const project = loadProjectConfig(root);

    if (project === null) {
      throw new Error('No project.');
    }

    await runNew(
      'pawnee-dog-park',
      { launch: false, ticket: 'dog-park-3' },
      { project, tickets: () => source, print: () => undefined }
    );
    const store = createPodStore(path.join(root, '.lambda', 'pods'));
    const [id] = store.listPodIds();

    expect(id === undefined ? undefined : store.requirePod(id)).toMatchObject({
      source: 'ticket',
      epicId: 'dog-park-3',
    });
  });
});

describe('openingMessage', () => {
  it('a freeform pod gets the words as they are; a batch is told it is a batch', () => {
    expect(
      openingMessage(pod({ mode: 'freeform' }), '  what about detours? ')
    ).toBe('what about detours?');
    expect(
      openingMessage(
        pod({ source: 'batch', tickets: ['PAWNEE-84', 'PAWNEE-83'] }),
        'PAWNEE-84 PAWNEE-83'
      )
    ).toContain('these 2 existing tickets as a batch');
  });
});

describe('runStructure — freeform to structured, one way', () => {
  it('keeps what the pod already knew, starts phase 1, and tells the manager', async () => {
    const store = withPod(
      pod({
        mode: 'freeform',
        source: 'ticket',
        epicId: 'PAWNEE-84',
        phase: 1,
      })
    );

    await runStructure(POD, {});

    expect(store.requirePod(POD)).toMatchObject({
      mode: 'structured',
      source: 'ticket',
      epicId: 'PAWNEE-84',
      phase: 1,
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: 'manager', command: '/pod-structured' })
    );
    await expect(runStructure(POD, {})).rejects.toThrow(
      'already on the structured flow'
    );
  });

  it('can be pointed at a batch when the talk settled on several tickets', async () => {
    const store = withPod(pod({ mode: 'freeform', source: 'idea' }));

    await runStructure(POD, { batch: 'dog-park-3, PAWNEE-83' });

    expect(store.requirePod(POD)).toMatchObject({
      source: 'batch',
      tickets: ['dog-park-3', 'PAWNEE-83'],
    });
  });
});

describe('runProposeStructure — the dev proposes, the owner starts it', () => {
  it('records the proposal, and starting it plans exactly what was proposed', async () => {
    const store = withPod(pod({ mode: 'freeform', source: 'idea' }), 'dev');

    await runProposeStructure(POD, {
      epic: 'PAWNEE-69',
      why: 'The map layout is settled; the epic needs its tickets.',
    });

    expect(store.requirePod(POD).structureProposal).toMatchObject({
      source: 'epic',
      epicId: 'PAWNEE-69',
      why: 'The map layout is settled; the epic needs its tickets.',
    });
    expect(store.requirePod(POD).mode).toBe('freeform');

    await runStructure(POD, {});

    const started = store.requirePod(POD);
    expect(started).toMatchObject({
      mode: 'structured',
      source: 'epic',
      epicId: 'PAWNEE-69',
      phase: 1,
    });
    expect(started.structureProposal).toBeUndefined();
  });

  it('a new idea needs no flag; proposing again replaces the last', async () => {
    const store = withPod(pod({ mode: 'freeform', source: 'idea' }), 'dev');

    await runProposeStructure(POD, {
      batch: 'PAWNEE-1,PAWNEE-2',
      why: 'Two bugs.',
    });
    await runProposeStructure(POD, { why: 'It is one new idea after all.' });

    expect(store.requirePod(POD).structureProposal).toMatchObject({
      source: 'idea',
      why: 'It is one new idea after all.',
    });
  });

  it('refuses without a reason, with two targets, or once structured', async () => {
    withPod(pod({ mode: 'freeform' }), 'dev');

    await expect(runProposeStructure(POD, { why: '  ' })).rejects.toThrow(
      '--why'
    );
    await expect(
      runProposeStructure(POD, {
        epic: 'PAWNEE-1',
        ticket: 'PAWNEE-2',
        why: 'x',
      })
    ).rejects.toThrow('one of --epic');

    withPod(pod({ mode: 'structured' }), 'dev');
    await expect(runProposeStructure(POD, { why: 'x' })).rejects.toThrow(
      'already on the structured flow'
    );
  });
});

describe("runSkip — the owner's call", () => {
  it("records the skip as the owner's decision and tells the manager", async () => {
    const store = withPod(pod({ source: 'ticket', epicId: 'PAWNEE-84' }));

    await runSkip(POD, 'research', {});

    expect(store.requirePod(POD).skipped).toEqual(['research']);
    expect(store.readHumanDecisions(POD)[0]?.decision).toBe('Skip 3 Research');
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: 'manager', command: '/pod-skip' })
    );
  });

  it("an agent may only relay it with the owner's words", async () => {
    withPod(pod({ source: 'ticket', epicId: 'PAWNEE-84' }), 'dev');

    await expect(runSkip(POD, 'research', {})).rejects.toThrow(
      'Only the owner skips a stage'
    );
    await expect(
      runSkip(POD, 'research', { quote: 'skip research, I know this code' })
    ).resolves.toBeUndefined();
  });

  it('refuses a stage this pod does not have', async () => {
    withPod(pod({ source: 'ticket', epicId: 'PAWNEE-84' }));

    await expect(runSkip(POD, 'triage', {})).rejects.toThrow(
      'No stage "triage"'
    );
  });
});

describe('runRename — a name the owner chose stays theirs', () => {
  it('the dev names it; after the owner renames it, the dev cannot', () => {
    const store = withPod(pod({ title: 'PAWNEE-84', titleBy: 'agent' }), 'dev');

    runRename(POD, 'Lot 48 gallery refresh race');
    expect(store.requirePod(POD).title).toBe('Lot 48 gallery refresh race');

    delete process.env.POD_AGENT;
    runRename(POD, 'Gallery card flake');
    expect(store.requirePod(POD)).toMatchObject({
      title: 'Gallery card flake',
      titleBy: 'owner',
    });

    process.env.POD_AGENT = 'dev';
    runRename(POD, 'Something else');
    expect(store.requirePod(POD).title).toBe('Gallery card flake');
  });
});
