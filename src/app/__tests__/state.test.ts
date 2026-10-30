import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, type Question, createPodStore } from '../../pod-store';
import { orderPods } from '../client/Sidebar';
import { awaitingAgent, buildState } from '../server/state';

const pod = (id: string, createdAt: string): Pod => ({
  id,
  slug: id,
  createdAt,
  status: 'active',
  phase: 2,
  completedCheckpoints: [],
  worktreePath: '/tmp',
  ownsWorktree: false,
  managerCwd: '/tmp',
  devCwd: '/tmp',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
});

const open = (podId: string, id: string, committedAt: string): Question => ({
  id,
  podId,
  kind: 'question',
  phase: 2,
  status: 'open',
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: committedAt,
  committedAt,
  summary: 's',
  context: 'c',
  problem: 'p',
  options: [],
});

const message = (
  from: 'human' | 'dev' | 'fork',
  qid: string,
  createdAt: string
) => ({
  id: `m${createdAt.replace(/\D/g, '')}`,
  podId: 'pawnee-a1b2',
  qid,
  from,
  mode: 'async' as const,
  text: 'x',
  createdAt,
  delivery: 'received' as const,
});

describe('awaitingAgent', () => {
  const q = open('pawnee-a1b2', 'q1', '2026-10-03T01:00:00.000Z');

  it('hides a question the owner has answered until an agent responds', () => {
    expect(awaitingAgent(q, [])).toBe(false);
    expect(
      awaitingAgent(q, [message('human', 'q1', '2026-10-03T02:00:00.000Z')])
    ).toBe(true);
    expect(
      awaitingAgent(q, [
        message('human', 'q1', '2026-10-03T02:00:00.000Z'),
        message('fork', 'q1', '2026-10-03T02:01:00.000Z'),
      ])
    ).toBe(false);
  });

  it('ignores messages from before the question was committed (a re-asked question)', () => {
    expect(
      awaitingAgent(q, [message('human', 'q1', '2026-10-03T00:00:00.000Z')])
    ).toBe(false);
  });
});

describe('buildState', () => {
  it('orders the inbox by drag priority and leaves out answered-but-unresolved questions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod(pod('pawnee-a1b2', '2026-10-01T00:00:00.000Z'));
    store.writePod(pod('eagleton-c3d4', '2026-10-02T00:00:00.000Z'));
    store.writeQuestion(open('pawnee-a1b2', 'q1', '2026-10-03T01:00:00.000Z'));
    store.writeQuestion(open('pawnee-a1b2', 'q2', '2026-10-03T01:05:00.000Z'));
    store.writeQuestion(
      open('eagleton-c3d4', 'q1', '2026-10-03T02:00:00.000Z')
    );
    store.appendThread({
      id: 'manswer1',
      podId: 'pawnee-a1b2',
      qid: 'q1',
      from: 'human',
      mode: 'async',
      text: 'go with B',
      createdAt: '2026-10-03T03:00:00.000Z',
    });
    store.writeInbox({ priority: ['eagleton-c3d4'] });

    const state = buildState(store, () => []);

    expect(state.inbox.map(({ podId, qid }) => ({ podId, qid }))).toEqual([
      { podId: 'eagleton-c3d4', qid: 'q1' },
      { podId: 'pawnee-a1b2', qid: 'q2' },
    ]);
    // q1 is answered (awaiting the dev), so only q2 still needs the owner.
    expect(
      state.pods.find((summary) => summary.pod.id === 'pawnee-a1b2')?.needsYou
    ).toBe(1);
  });
});

describe('structured planning proposed by a freeform pod', () => {
  it('comes up as one item, keyed by when it was proposed, and goes once started', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    const freeform: Pod = {
      ...pod('pawnee-a1b2', '2026-10-01T00:00:00.000Z'),
      mode: 'freeform',
      structureProposal: {
        source: 'epic',
        epicId: 'PAWNEE-69',
        why: 'Settled.',
        at: '2026-10-03T01:00:00.000Z',
      },
    };
    store.writePod(freeform);
    // The dev's message offering it asks for a reply: the pitch stands in.
    store.appendThread({
      id: 'm-offer',
      podId: 'pawnee-a1b2',
      from: 'dev',
      mode: 'note',
      text: 'Press Start planning whenever you are ready.',
      expectsReply: true,
      createdAt: '2026-10-03T01:00:00.000Z',
    });

    expect(buildState(store, () => []).inbox).toEqual([
      {
        podId: 'pawnee-a1b2',
        kind: 'structure',
        key: 'pawnee-a1b2/structure/2026-10-03T01:00:00.000Z',
      },
    ]);

    store.writePod({
      ...freeform,
      mode: 'structured',
      structureProposal: undefined,
    });
    // Starting it answered the offer: no "Your turn" left behind.
    store.appendThread({
      id: 'm-start',
      podId: 'pawnee-a1b2',
      from: 'system',
      mode: 'note',
      text: 'the owner switched this pod to the structured flow.',
      wire: '/pod-structured [m:m-start]: the owner switched this pod.',
      target: 'manager',
      createdAt: '2026-10-03T02:00:00.000Z',
    });
    expect(buildState(store, () => []).inbox).toEqual([]);
  });
});

describe('closing a checkpoint answers what the dev asked about it', () => {
  it('leaves no "Your turn" behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod(pod('pawnee-a1b2', '2026-10-01T00:00:00.000Z'));
    store.appendThread({
      id: 'm-ask',
      podId: 'pawnee-a1b2',
      from: 'dev',
      mode: 'note',
      text: 'The plan is updated. Anything else before you close it?',
      expectsReply: true,
      createdAt: '2026-10-03T01:00:00.000Z',
    });

    expect(buildState(store, () => []).inbox.map(({ kind }) => kind)).toEqual([
      'reply',
    ]);

    store.appendThread({
      id: 'm-close',
      podId: 'pawnee-a1b2',
      from: 'system',
      mode: 'note',
      text: 'Checkpoint 5 is complete (closed by the owner). Continue the pipeline.',
      wire: '/checkpoint-complete [m:m-close]: Checkpoint 5 is complete.',
      target: 'manager',
      createdAt: '2026-10-03T02:00:00.000Z',
    });
    expect(buildState(store, () => []).inbox).toEqual([]);
  });
});

describe('attention: every pod either needs the owner or is working', () => {
  const seedPod = (): {
    root: string;
    store: ReturnType<typeof createPodStore>;
  } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-attn-'));
    const store = createPodStore(root);
    store.writePod(pod('pawnee-a1b2', '2026-10-03T00:00:00.000Z'));

    return { root, store };
  };
  const say = (
    store: ReturnType<typeof createPodStore>,
    id: string,
    from: 'human' | 'dev' | 'manager',
    createdAt: string,
    target?: string,
    kind: 'ask' | 'fyi' = 'ask'
  ) =>
    store.appendThread({
      id,
      podId: 'pawnee-a1b2',
      from,
      mode: from === 'human' ? 'sync' : 'note',
      text: `${from} says`,
      ...(target === undefined ? {} : { target, wire: 'x' }),
      ...(from === 'human' ? {} : { expectsReply: kind === 'ask' }),
      createdAt,
    });

  it('a pod running a work request has nothing in the inbox until it is done', () => {
    const { store } = seedPod();
    // An ask that would normally be "Your turn"…
    say(store, 'm1', 'dev', '2026-10-03T11:56:00.000Z');
    store.writeRequest({
      id: 'r1',
      podId: 'pawnee-a1b2',
      summary: 'Rebase on Epic 1',
      quote: 'rebase on epic 1',
      status: 'working',
      createdAt: '2026-10-03T11:57:00.000Z',
    });

    const reworking = buildState(store, () => ['manager', 'dev']);
    expect(reworking.inbox).toEqual([]);
    expect(reworking.pods[0]?.status).toBe('working');
    expect(reworking.pods[0]?.request?.id).toBe('r1');

    // Done: the item comes back.
    const request = store.readRequest('pawnee-a1b2', 'r1');

    if (request === null) {
      throw new Error('The request was not saved.');
    }

    store.writeRequest({ ...request, status: 'done' });
    expect(buildState(store, () => ['manager', 'dev']).inbox).toHaveLength(1);
  });

  it("a request's own question to the owner still reaches them (never a silent stall)", () => {
    const { store } = seedPod();
    store.writeQuestion(open('pawnee-a1b2', 'q1', '2026-10-03T10:00:00.000Z'));
    store.writeRequest({
      id: 'r1',
      podId: 'pawnee-a1b2',
      summary: 'Add the ridge loop to the trail map',
      quote: 'add the ridge loop to the trail map',
      status: 'working',
      createdAt: '2026-10-03T11:57:00.000Z',
    });
    // Mid-request, the dev needs their call: A or B?
    say(store, 'm1', 'dev', '2026-10-03T11:58:00.000Z');

    const state = buildState(store, () => ['manager', 'dev']);

    expect(state.inbox.map((item) => item.kind)).toEqual(['reply']);
    expect(state.pods[0]?.status).toBe('needs-you');
  });

  it('⌘⏎ in the Chat panel keeps the pod out of the inbox until the chat answers', () => {
    const { store } = seedPod();
    store.writeQuestion(open('pawnee-a1b2', 'q1', '2026-10-03T10:00:00.000Z'));
    const chat = (
      id: string,
      from: 'human' | 'fork',
      createdAt: string,
      extra: { hold?: boolean; progress?: boolean } = {}
    ) =>
      store.appendThread({
        id,
        podId: 'pawnee-a1b2',
        from,
        mode: from === 'human' ? 'sync' : 'note',
        text: `${from} in the chat`,
        chat: true,
        ...extra,
        ...(from === 'human' ? { target: 'fork-chat', wire: 'x' } : {}),
        createdAt,
      });
    const at = (iso: string) =>
      buildState(store, () => [], new Map(), Date.parse(iso));

    chat('m1', 'human', '2026-10-03T11:00:00.000Z', { hold: true });
    expect(at('2026-10-03T11:01:00.000Z').inbox).toEqual([]);
    expect(at('2026-10-03T11:01:00.000Z').pods[0]?.chatHold).toBe(true);

    // A progress note isn't the answer.
    chat('m2', 'fork', '2026-10-03T11:02:00.000Z', { progress: true });
    expect(at('2026-10-03T11:03:00.000Z').inbox).toEqual([]);

    // The answer lets go.
    chat('m3', 'fork', '2026-10-03T11:04:00.000Z');
    const answered = at('2026-10-03T11:05:00.000Z');
    expect(answered.inbox.map((item) => item.qid)).toEqual(['q1']);
    expect(answered.pods[0]).toMatchObject({
      chatHold: false,
      chatSentAt: '2026-10-03T11:00:00.000Z',
      chatRepliedAt: '2026-10-03T11:04:00.000Z',
    });

    // No answer at all: it lets go after 15 minutes anyway.
    chat('m4', 'human', '2026-10-03T12:00:00.000Z', { hold: true });
    expect(at('2026-10-03T12:14:00.000Z').inbox).toEqual([]);
    expect(at('2026-10-03T12:16:00.000Z').inbox).toHaveLength(1);

    // A plain ⏎ message never holds.
    chat('m5', 'human', '2026-10-03T13:00:00.000Z');
    expect(at('2026-10-03T13:01:00.000Z').inbox).toHaveLength(1);
  });

  it('never surfaces an FYI — an acknowledgement after "Done — carry on" stays in the thread', () => {
    const { store } = seedPod();
    say(store, 'm1', 'human', '2026-10-03T11:55:00.000Z', 'dev');
    say(store, 'm2', 'dev', '2026-10-03T11:56:00.000Z', undefined, 'fyi');
    store.patchTurn('pawnee-a1b2', 'dev', {
      startedAt: '2026-10-03T11:57:00.000Z',
    });

    const state = buildState(store, () => ['manager', 'dev']);

    expect(state.inbox).toEqual([]);
    expect(state.pods[0]?.status).toBe('working');
  });

  it('keeps an unanswered ask in the inbox even when FYIs follow it', () => {
    const { store } = seedPod();
    say(store, 'm1', 'dev', '2026-10-03T11:50:00.000Z', undefined, 'ask');
    say(store, 'm2', 'dev', '2026-10-03T11:51:00.000Z', undefined, 'fyi');

    expect(
      buildState(store, () => ['manager', 'dev']).inbox[0]?.messageId
    ).toBe('m1');
  });

  it('surfaces a dev reply as "Your turn" first, until the owner answers', () => {
    const { store } = seedPod();
    store.writeQuestion(open('pawnee-a1b2', 'q1', '2026-10-03T10:00:00.000Z'));
    say(store, 'm1', 'human', '2026-10-03T11:00:00.000Z', 'dev');
    say(store, 'm2', 'dev', '2026-10-03T11:01:00.000Z');

    const state = buildState(store, () => ['manager', 'dev']);

    expect(state.inbox.map((item) => item.kind)).toEqual(['reply', 'question']);
    expect(state.inbox[0]?.messageId).toBe('m2');
    expect(state.pods[0]?.status).toBe('needs-you');
    expect(state.pods[0]?.needsYou).toBe(2);

    say(store, 'm3', 'human', '2026-10-03T11:02:00.000Z', 'dev');

    expect(
      buildState(store, () => ['manager', 'dev']).inbox.map((item) => item.kind)
    ).toEqual(['question']);
  });

  it('follows the sidebar order: a lower pod\'s "Your turn" waits behind the pods above it', () => {
    const { store } = seedPod();
    store.writePod(pod('eagleton-c3d4', '2026-10-04T00:00:00.000Z'));
    store.writeQuestion(open('pawnee-a1b2', 'q1', '2026-10-03T10:00:00.000Z'));
    store.writeQuestion(
      open('eagleton-c3d4', 'q1', '2026-10-04T10:00:00.000Z')
    );
    store.appendThread({
      id: 'e1',
      podId: 'eagleton-c3d4',
      from: 'dev',
      mode: 'note',
      text: 'Which one?',
      expectsReply: true,
      createdAt: '2026-10-04T11:00:00.000Z',
    });

    const order = () =>
      buildState(store, () => ['manager', 'dev']).inbox.map(
        (item) => `${item.podId}:${item.kind}`
      );

    // No drag yet: oldest pod first, as the sidebar shows it.
    expect(order()).toEqual([
      'pawnee-a1b2:question',
      'eagleton-c3d4:reply',
      'eagleton-c3d4:question',
    ]);

    store.writeInbox({ priority: ['eagleton-c3d4'] });

    expect(order()).toEqual([
      'eagleton-c3d4:reply',
      'eagleton-c3d4:question',
      'pawnee-a1b2:question',
    ]);
  });

  it('does not treat agent-to-agent traffic as a reply to the owner', () => {
    const { store } = seedPod();
    say(store, 'm1', 'manager', '2026-10-03T11:59:00.000Z', 'dev');

    expect(buildState(store, () => ['manager', 'dev']).inbox).toEqual([]);
  });

  it('is Working while an agent turn is in progress', () => {
    const { store } = seedPod();
    store.patchTurn('pawnee-a1b2', 'dev', {
      startedAt: '2026-10-03T11:00:00.000Z',
    });

    const state = buildState(store, () => ['manager', 'dev']);

    expect(state.inbox).toEqual([]);
    expect(state.pods[0]?.status).toBe('working');
  });

  it('an idle pod is still Working — the watchdog nudges it before the owner hears', () => {
    const { store } = seedPod();
    store.patchTurn('pawnee-a1b2', 'dev', {
      startedAt: '2026-10-03T11:00:00.000Z',
      endedAt: '2026-10-03T11:30:00.000Z',
    });

    const state = buildState(store, () => ['manager', 'dev']);

    expect(state.inbox).toEqual([]);
    expect(state.pods[0]?.status).toBe('working');
  });

  it('is Stalled, with why, once the watchdog escalates it', () => {
    const { store } = seedPod();
    const why = 'I nudged the manager 2 times and it made no progress';

    const state = buildState(
      store,
      () => ['manager', 'dev'],
      new Map([['pawnee-a1b2', why]])
    );

    expect(state.inbox).toEqual([
      {
        podId: 'pawnee-a1b2',
        kind: 'stalled',
        key: 'pawnee-a1b2/stalled',
        reason: why,
      },
    ]);
    expect(state.pods[0]?.status).toBe('stalled');
  });

  it('is Waiting on step 0, not Stalled, when parked on a human ticket', () => {
    const { store } = seedPod();
    store.updatePod('pawnee-a1b2', (current) => ({
      ...current,
      waitingOnHuman: {
        ticketId: 'PAWNEE-90',
        since: '2026-10-03T09:00:00.000Z',
      },
    }));

    const state = buildState(store, () => []);

    expect(state.inbox).toEqual([]);
    expect(state.pods[0]?.status).toBe('waiting-step0');
  });
});

describe('orderPods', () => {
  it('puts prioritised pods first, then the rest oldest first, and hides done pods', () => {
    const summaries = [
      pod('a-0001', '2026-10-01T00:00:00.000Z'),
      pod('b-0002', '2026-10-02T00:00:00.000Z'),
      { ...pod('c-0003', '2026-10-03T00:00:00.000Z'), status: 'done' as const },
      pod('d-0004', '2026-09-30T00:00:00.000Z'),
    ].map((p) => ({
      pod: p,
      running: true,
      status: 'working' as const,
      needsYou: 0,
      liveForks: [],
      chatHold: false,
    }));

    expect(
      orderPods(summaries, ['b-0002']).map((summary) => summary.pod.id)
    ).toEqual(['b-0002', 'd-0004', 'a-0001']);
  });
});

describe("a building pod's Blocked items", () => {
  it('each come to the inbox: two in a row are two items', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod({
      ...pod('build-a1b2', '2026-10-01T00:00:00.000Z'),
      kind: 'building',
      runnerId: 'r-leslie-mac',
      sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
    });
    ['m5blocked', 'm6blocked'].forEach((id, index) =>
      store.appendThread({
        id,
        podId: 'build-a1b2',
        from: 'engineering-manager',
        mode: 'note',
        text: `**What:** Ticket ${
          index + 5
        }\n**Problem:** …\n**Options:** …\n**Recommendation:** …`,
        expectsReply: true,
        createdAt: `2026-10-23T10:0${index}:00.000Z`,
      })
    );

    const state = buildState(store, () => []);

    expect(
      state.inbox.map(({ kind, messageId }) => ({ kind, messageId }))
    ).toEqual([
      { kind: 'reply', messageId: 'm5blocked' },
      { kind: 'reply', messageId: 'm6blocked' },
    ]);
  });

  it('stay in the inbox while the owner chats with the Product manager', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod({
      ...pod('build-a1b2', '2026-10-01T00:00:00.000Z'),
      kind: 'building',
      runnerId: 'r-leslie-mac',
      sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
    });
    store.appendThread({
      id: 'm5blocked',
      podId: 'build-a1b2',
      from: 'engineering-manager',
      mode: 'note',
      text: '**What:** Ticket 5\n**Problem:** …\n**Options:** …\n**Recommendation:** …',
      expectsReply: true,
      createdAt: '2026-10-23T10:00:00.000Z',
    });
    store.appendThread({
      id: 'm6question',
      podId: 'build-a1b2',
      from: 'human',
      target: 'product-manager',
      mode: 'sync',
      text: 'why did the test fail?',
      createdAt: '2026-10-23T10:05:00.000Z',
    });

    expect(
      buildState(store, () => []).inbox.map(({ messageId }) => messageId)
    ).toEqual(['m5blocked']);

    // An answer through the item (to the Engineering manager) settles it.
    store.appendThread({
      id: 'm7answer',
      podId: 'build-a1b2',
      from: 'human',
      target: 'engineering-manager',
      mode: 'sync',
      text: 'skip it',
      createdAt: '2026-10-23T10:06:00.000Z',
    });

    expect(buildState(store, () => []).inbox).toEqual([]);
  });
});

describe("a building pod's state, once per build", () => {
  it("reads each building pod's building state once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    ['build-a1b2', 'build-c3d4'].forEach((id) =>
      store.writePod({
        ...pod(id, '2026-10-01T00:00:00.000Z'),
        kind: 'building',
        runnerId: 'r-leslie-mac',
        sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
      })
    );
    const readBuilding = jest.fn(store.readBuilding);

    buildState({ ...store, readBuilding }, () => []);

    expect(readBuilding.mock.calls).toEqual([['build-a1b2'], ['build-c3d4']]);
  });
});

describe("a building pod's Blocked item answered on its own", () => {
  it('settles only the item the answer is about, leaving the one before it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod({
      ...pod('build-a1b2', '2026-10-01T00:00:00.000Z'),
      kind: 'building',
      runnerId: 'r-leslie-mac',
      sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
    });
    ['m5blocked', 'm6blocked'].forEach((id, index) =>
      store.appendThread({
        id,
        podId: 'build-a1b2',
        from: 'engineering-manager',
        mode: 'note',
        text: `**What:** Ticket ${index + 5}`,
        expectsReply: true,
        createdAt: `2026-10-23T10:0${index}:00.000Z`,
      })
    );
    store.appendThread({
      id: 'm7answer',
      podId: 'build-a1b2',
      from: 'human',
      target: 'engineering-manager',
      about: 'm6blocked',
      mode: 'sync',
      text: 'add the key',
      createdAt: '2026-10-23T10:06:00.000Z',
    });

    expect(
      buildState(store, () => []).inbox.map(({ messageId }) => messageId)
    ).toEqual(['m5blocked']);
  });
});

describe("a building pod's Blocked item once its ticket is unblocked", () => {
  const blockedRun = (id: string, messageId: string) => ({
    id,
    title: `Ticket ${id}`,
    step: 'test',
    attempt: 1,
    startedAt: '2026-10-23T09:00:00.000Z',
    blocked: {
      at: '2026-10-23T10:00:00.000Z',
      what: `Ticket ${id}`,
      problem: 'No progress on Test for 40 minutes',
      options: '1) look at the Agents tab  2) set it back to Ready to retry',
      recommendation: 'Check the Agents tab.',
      messageId,
    },
  });

  it('leaves the inbox when the ticket is back in the queue, or picked up again', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod({
      ...pod('build-a1b2', '2026-10-01T00:00:00.000Z'),
      kind: 'building',
      runnerId: 'r-leslie-mac',
      sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
    });
    ['5', '6'].forEach((ticketId) =>
      store.appendThread({
        id: `m${ticketId}blocked`,
        podId: 'build-a1b2',
        from: 'engineering-manager',
        mode: 'note',
        text: `**What:** Ticket ${ticketId}\n**Problem:** …\n**Options:** …\n**Recommendation:** …`,
        expectsReply: true,
        createdAt: `2026-10-23T10:0${ticketId}:00.000Z`,
      })
    );
    const asked = () =>
      buildState(store, () => []).inbox.map(({ messageId }) => messageId);

    store.writeBuilding('build-a1b2', {
      runs: [blockedRun('5', 'm5blocked'), blockedRun('6', 'm6blocked')],
      upNext: [],
    });
    expect(asked()).toEqual(['m5blocked', 'm6blocked']);

    // Ticket 5 set back to Ready: the runner's poll lists it in Up next.
    store.updateBuilding('build-a1b2', (state) => ({
      ...state,
      upNext: [{ id: '5', title: 'Ticket 5' }],
    }));
    expect(asked()).toEqual(['m6blocked']);

    // Ticket 6 set back to Ready and picked up again: a later run of it.
    store.updateBuilding('build-a1b2', (state) => ({
      ...state,
      runs: [
        ...state.runs,
        {
          id: '6',
          title: 'Ticket 6',
          step: 'pick-up',
          attempt: 1,
          startedAt: '2026-10-23T11:00:00.000Z',
        },
      ],
    }));
    expect(asked()).toEqual([]);
  });
});

describe("a building pod's items, tagged for Auto and a Lambda's page", () => {
  it('names the ticket, and tags a build blocker apart from a review', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-app-'));
    const store = createPodStore(root);
    store.writePod({
      ...pod('build-a1b2', '2026-10-01T00:00:00.000Z'),
      kind: 'building',
      runnerId: 'r-leslie-mac',
      sessions: { 'engineering-manager': 'em', dev: 'd', qa: 'q' },
    });
    store.appendThread({
      id: 'm5blocked',
      podId: 'build-a1b2',
      from: 'engineering-manager',
      mode: 'note',
      text: '**What:** Ticket 5\n**Problem:** …\n**Options:** …\n**Recommendation:** …',
      expectsReply: true,
      createdAt: '2026-10-23T10:05:00.000Z',
    });
    store.appendThread({
      id: 'm7review',
      podId: 'build-a1b2',
      from: 'engineering-manager',
      mode: 'note',
      text: 'Ticket 7 is built and tested: ready for your review.',
      expectsReply: true,
      review: { ticketId: '7' },
      createdAt: '2026-10-23T10:07:00.000Z',
    });
    store.writeBuilding('build-a1b2', {
      runs: [
        {
          id: '5',
          title: 'Ticket 5',
          step: 'test',
          attempt: 1,
          startedAt: '2026-10-23T09:00:00.000Z',
          blocked: {
            at: '2026-10-23T10:00:00.000Z',
            what: 'Ticket 5',
            problem: 'No progress on Test for 40 minutes',
            options: '1) look at the Agents tab',
            recommendation: 'Check the Agents tab.',
            messageId: 'm5blocked',
          },
        },
      ],
      upNext: [],
    });

    expect(
      buildState(store, () => []).inbox.map(({ messageId, ticketId, tag }) => ({
        messageId,
        ticketId,
        tag,
      }))
    ).toEqual([
      { messageId: 'm5blocked', ticketId: '5', tag: 'blocked' },
      { messageId: 'm7review', ticketId: '7', tag: 'review' },
    ]);
  });
});
