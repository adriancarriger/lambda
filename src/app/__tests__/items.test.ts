import type { Question, ThreadMessage } from '../../pod-store';
import { pendingReply } from '../shared/conversation';
import {
  awaitingAgent,
  exchangeView,
  exchangesOf,
  itemChat,
  originView,
  splitExchange,
  waitingOnSpawned,
} from '../shared/items';
import { contextSections } from '../shared/speech';

const at = (minute: number): string =>
  `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`;

const msg = (
  id: string,
  from: ThreadMessage['from'],
  text: string,
  minute: number,
  extra: Partial<ThreadMessage> = {}
): ThreadMessage => ({
  id,
  podId: 'pawnee-a1b2',
  qid: 'q1',
  from,
  mode: 'async',
  text,
  createdAt: at(minute),
  delivery: 'received',
  ...(from === 'human' ? { target: 'dev' } : {}),
  ...extra,
});

const question = (id: string, overrides: Partial<Question> = {}): Question => ({
  id,
  podId: 'pawnee-a1b2',
  kind: 'question',
  phase: 1,
  status: 'open',
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: at(0),
  committedAt: at(0),
  summary: 'Should the ten-day fallback ship? I recommend A.',
  options: [],
  ...overrides,
});

const checkpoint = question('q1', {
  kind: 'checkpoint',
  summary: 'I read the epic.',
  checkpoint: { cp: 1, decisionIds: [] },
});

describe('the item chat', () => {
  const thread = [
    msg('m1', 'human', 'what if the trail map is offline?', 1),
    msg('m2', 'dev', 'on it — reading the trail-marker ticket', 2, {
      progress: true,
    }),
    msg('m3', 'dev', 'Leslie, that needs two decisions from you.', 3),
    msg('m4', 'dev', 'resolution for the dev', 4, {
      from: 'fork',
      target: 'dev',
    }),
    msg('m5', 'system', 'startup', 5),
  ];

  it('holds what the owner said and what Claude said TO them — not agent traffic', () => {
    expect(itemChat(thread, 'q1').map((message) => message.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('shows the latest exchange without progress notes', () => {
    const { exchange } = exchangeView(itemChat(thread, 'q1'));

    expect(exchange?.you?.id).toBe('m1');
    expect(exchange?.replies.map((reply) => reply.id)).toEqual(['m3']);
  });

  it('talking about it in the Chat panel never takes it out of the inbox', () => {
    expect(
      awaitingAgent(checkpoint, [
        msg('c1', 'human', 'what is a trail marker?', 1, {
          mode: 'sync',
          chat: true,
          target: 'fork-chat',
        }),
      ])
    ).toBe(false);
  });

  it('ending a live conversation with no last word does not hide the item', () => {
    const live = [
      msg('l1', 'human', 'does Ron have to inspect it?', 1, { mode: 'sync' }),
      msg('l2', 'fork', 'No: a photo is enough.', 2),
      msg('l3', 'human', '', 3, { mode: 'sync' }),
    ];

    expect(awaitingAgent(checkpoint, live)).toBe(false);
    // A last word still waits for Claude.
    expect(
      awaitingAgent(checkpoint, [
        ...live.slice(0, 2),
        msg('l4', 'human', 'ok, apply it', 3, { mode: 'sync' }),
      ])
    ).toBe(true);
  });

  it('keeps the item out of the inbox until the real reply, not the progress note', () => {
    expect(awaitingAgent(checkpoint, thread.slice(0, 2))).toBe(true);
    expect(awaitingAgent(checkpoint, thread.slice(0, 3))).toBe(false);
  });
});

describe('decisions spawned from a message', () => {
  const thread = [
    msg('m1', 'human', 'what if the trail map is offline?', 1),
    msg('m3', 'dev', 'That needs two decisions from you.', 3),
  ];
  const spawned = (id: string, overrides: Partial<Question> = {}) =>
    question(id, {
      origin: { kind: 'message', messageId: 'm1', qid: 'q1' },
      ...overrides,
    });

  it('hides the item while they are open', () => {
    expect(
      waitingOnSpawned(
        checkpoint,
        [checkpoint, spawned('q2'), spawned('q3')],
        thread
      )
    ).toBe(true);
  });

  it('keeps it hidden until Claude replies after the last answer', () => {
    const answered = [
      checkpoint,
      spawned('q2', { status: 'answered', answeredAt: at(10) }),
      spawned('q3', { status: 'answered', answeredAt: at(11) }),
    ];

    expect(waitingOnSpawned(checkpoint, answered, thread)).toBe(true);
    expect(
      waitingOnSpawned(checkpoint, answered, [
        ...thread,
        msg('m9', 'dev', 'Applied both: …', 12),
      ])
    ).toBe(false);
  });

  it('a reply on the spawned question itself brings the item back too', () => {
    const answered = [
      checkpoint,
      spawned('q2', { status: 'answered', answeredAt: at(10) }),
    ];

    // The dev answered on q2 ("Going with A… the card is updated"), not on
    // the checkpoint: that used to leave it hidden — a stall nothing nudged.
    expect(
      waitingOnSpawned(checkpoint, answered, [
        ...thread,
        msg('m9', 'dev', 'Going with A: the card is updated.', 12, {
          qid: 'q2',
        }),
      ])
    ).toBe(false);
  });

  it('so does an edit to the card after the answer', () => {
    const edited = {
      ...checkpoint,
      checkpoint: {
        cp: 1,
        decisionIds: [],
        ...checkpoint.checkpoint,
        refreshedAt: at(12),
      },
    };
    const answered = [
      edited,
      spawned('q2', { status: 'answered', answeredAt: at(10) }),
    ];

    expect(waitingOnSpawned(edited, answered, thread)).toBe(false);
  });

  it('quotes their own words, links back, and numbers the series', () => {
    const questions = [checkpoint, spawned('q2'), spawned('q3')];
    const origin = originView(spawned('q3'), questions, thread);

    expect(origin?.lead).toBe('From what you said on Checkpoint 1');
    expect(origin?.link).toEqual({ qid: 'q1', label: 'Checkpoint 1' });
    expect(origin?.quote).toBe('what if the trail map is offline?');
    expect(origin?.reply).toBe('That needs two decisions from you.');
    expect(origin?.series).toEqual({ index: 1, total: 2 });
    expect(origin?.spoken).toBe(
      'This comes from what you said on Checkpoint 1: "what if the trail map is offline?". Lambda answered: "That needs two decisions from you." It\'s the second of 2 decisions.'
    );
  });
});

describe('a question from one part of a long message', () => {
  it('quotes just that part and the answer to it — the whole message is kept aside', () => {
    const long = '1: the legend?\n2: why north always up?\n3: closed trails?';
    const thread = [
      msg('m1', 'human', long, 1),
      msg('m3', 'dev', '1: … 2: … 3: … (answers to everything)', 3),
    ];
    const decision = question('q2', {
      origin: {
        kind: 'message',
        messageId: 'm1',
        qid: 'q1',
        quote: '1: the legend?',
        reply: 'The legend lets a ranger hide a closed trail in one tap.',
      },
    });
    const origin = originView(decision, [checkpoint, decision], thread);

    expect(origin?.quote).toBe('1: the legend?');
    expect(origin?.reply).toBe(
      'The legend lets a ranger hide a closed trail in one tap.'
    );
    expect(origin?.fullMessage).toBe(long);
    expect(origin?.spoken).not.toContain('north always');
    expect(origin?.spoken).toContain(
      'Lambda answered: "The legend lets a ranger hide a closed trail in one tap."'
    );
  });
});

describe('a reply answered part by part', () => {
  const long = '1: the legend?\n\n2: when would a trail stay hidden?';
  const thread = [
    msg('m1', 'human', long, 1),
    msg('m2', 'dev', 'An old, plain reply to everything.', 2),
    msg('m3', 'dev', '1: …\n2: …', 3, {
      replyTo: 'm1',
      parts: [
        {
          quote: '1: the legend?',
          answer: 'It lets a ranger hide a closed trail.',
        },
        {
          quote: '2: when would a trail stay hidden?',
          answer: 'Only while it is closed.',
        },
      ],
    }),
  ];
  const decision = question('q2', {
    status: 'answered',
    origin: {
      kind: 'message',
      messageId: 'm1',
      qid: 'q1',
      quote: '1: the legend?',
    },
  });
  const human = [{ qid: 'q2', decision: 'drop the legend' }];

  it('pairs each part with its answer and the decision it became', () => {
    const split = splitExchange(
      exchangeView(itemChat(thread, 'q1')).exchange,
      [checkpoint, decision],
      human
    );

    expect(split?.parts.map((part) => part.answer)).toEqual([
      'It lets a ranger hide a closed trail.',
      'Only while it is closed.',
    ]);
    expect(split?.parts[0]?.decision).toMatchObject({
      qid: 'q2',
      resolved: true,
      chose: 'drop the legend',
    });
    expect(split?.parts[1]?.decision).toBeUndefined();
    // The split reply replaces the plain one before it.
    expect(split?.rest).toEqual([]);
  });
});

describe('what is read first', () => {
  it("reads how it got here — not the item's back-and-forth, which is in the chat", () => {
    const decision = question('q2', {
      origin: {
        kind: 'work',
        phase: 2,
        doing: 'checking the trail-marker ticket against the code',
      },
    });
    const thread = [
      msg('m1', 'human', 'what about the ridge loop?', 1, { qid: 'q2' }),
      msg('m2', 'dev', 'It counts as a main trail.', 2, { qid: 'q2' }),
    ];
    const sections = contextSections(decision, [decision], thread);

    expect(sections.map((section) => section.key)).toEqual(['origin']);
    expect(sections[0]?.text).toBe(
      'This came up during Epic review, while checking the trail-marker ticket against the code.'
    );
  });

  it('adds nothing for an item nobody has talked about', () => {
    expect(contextSections(checkpoint, [checkpoint], [])).toEqual([]);
  });
});

describe('a live question does not replace what the item opens with', () => {
  const thread = [
    msg('m1', 'human', 'why blue markers?', 1),
    msg('m2', 'dev', 'Because red means closed.', 2),
    msg('m3', 'human', 'and the ridge loop?', 3),
    msg('m4', 'dev', 'It stays on the map.', 4),
    // Then a live (⌘⏎) question about it.
    msg('m5', 'human', 'does Ron have to walk it first?', 5, {
      mode: 'sync',
    }),
    msg('m6', 'fork', 'No: a photo is enough.', 6),
  ];
  const chat = itemChat(thread, 'q1');

  it('splits the chat into exchanges, oldest first', () => {
    expect(
      exchangesOf(chat).map((exchange) => [
        exchange.you?.id,
        exchange.replies.map((reply) => reply.id),
      ])
    ).toEqual([
      ['m1', ['m2']],
      ['m3', ['m4']],
      ['m5', ['m6']],
    ]);
  });

  it('opens with the last sent reply, and reads the live talk after it', () => {
    const view = exchangeView(chat);

    expect(view.exchange?.you?.id).toBe('m3');
    expect(view.index).toBe(1);
    expect(view.total).toBe(3);
    expect(view.liveAfter.map((exchange) => exchange.you?.id)).toEqual(['m5']);
  });

  it('steps back to an earlier exchange — with no live tail', () => {
    const view = exchangeView(chat, 0);

    expect(view.exchange?.you?.id).toBe('m1');
    expect(view.isDefault).toBe(false);
    expect(view.liveAfter).toEqual([]);
  });

  it('opens with the last live exchange when there is nothing else', () => {
    expect(
      exchangeView(itemChat(thread.slice(4), 'q1')).exchange?.you?.id
    ).toBe('m5');
  });
});

describe('pendingReply — the side chat never ends their turn', () => {
  it('keeps "Your turn" through a side-chat message', () => {
    const at = (n: number) => `2026-10-10T00:00:0${n}.000Z`;
    const base = {
      podId: 'p',
      mode: 'note' as const,
      delivery: 'delivered' as const,
    };
    const ask = {
      ...base,
      id: 'a',
      from: 'dev' as const,
      text: 'Which?',
      expectsReply: true,
      createdAt: at(1),
    };
    const side = {
      ...base,
      id: 's',
      from: 'human' as const,
      text: 'photo',
      chat: true,
      createdAt: at(2),
    };

    expect(pendingReply([ask, side])?.id).toBe('a');
    expect(
      pendingReply([
        ask,
        side,
        {
          ...base,
          id: 'r',
          from: 'human' as const,
          text: 'A',
          createdAt: at(3),
        },
      ])
    ).toBeNull();
  });

  it('in a freeform chat, any reply from the dev is their turn', () => {
    const at = (n: number) => `2026-10-19T00:00:0${n}.000Z`;
    const base = {
      podId: 'p',
      mode: 'note' as const,
      delivery: 'delivered' as const,
    };
    const theirs = {
      ...base,
      id: 'h',
      from: 'human' as const,
      text: '1. A',
      createdAt: at(1),
    };
    const fyi = {
      ...base,
      id: 'f',
      from: 'dev' as const,
      text: 'All three are applied in Linear.',
      createdAt: at(2),
    };
    const progress = {
      ...fyi,
      id: 'p1',
      text: 'checking PAWNEE-34',
      progress: true,
      createdAt: at(3),
    };

    expect(pendingReply([theirs, fyi])).toBeNull();
    expect(pendingReply([theirs, fyi], true)?.id).toBe('f');
    expect(pendingReply([theirs, fyi, progress], true)?.id).toBe('f');
    expect(pendingReply([theirs], true)).toBeNull();
  });

  it("their answer on one of the pod's items answers the dev's ask too", () => {
    const base = {
      podId: 'p',
      mode: 'note' as const,
      delivery: 'delivered' as const,
    };
    const ask = {
      ...base,
      id: 'a',
      from: 'dev' as const,
      text: 'One question is left: the marker-colour one.',
      expectsReply: true,
      createdAt: '2026-10-19T00:00:01.000Z',
    };
    const onItem = {
      ...base,
      id: 'd',
      from: 'human' as const,
      text: 'Go with D.',
      qid: 'q5',
      createdAt: '2026-10-19T00:00:02.000Z',
    };

    expect(pendingReply([ask])?.id).toBe('a');
    expect(pendingReply([ask, onItem])).toBeNull();
  });
});
