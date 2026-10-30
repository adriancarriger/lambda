import { pendingAsk } from '../conversation';
import type { ThreadMessage } from '../schemas';

const message = (
  id: string,
  fields: Partial<Omit<ThreadMessage, 'delivery'>> & Pick<ThreadMessage, 'from'>
): ThreadMessage => ({
  id,
  podId: 'p',
  mode: 'note',
  text: id,
  createdAt: `2026-10-09T00:00:0${id.length}.000Z`,
  delivery: 'delivered',
  ...fields,
});

const opening = message('open', {
  from: 'human',
  mode: 'sync',
  text: 'Does the ticket look complete?',
  target: 'dev',
});

describe('pendingAsk — what holds Shape open', () => {
  it("the dev's answer to his opening question waits on his reply", () => {
    const answer = message('answer', { from: 'dev', expectsReply: true });

    expect(pendingAsk([opening, answer])?.id).toBe('answer');
  });

  it('his reply settles it', () => {
    const thread = [
      opening,
      message('answer', { from: 'dev', expectsReply: true }),
      message('reply', { from: 'human', mode: 'sync', target: 'dev' }),
    ];

    expect(pendingAsk(thread)).toBeNull();
  });

  it('FYIs, agent-to-agent traffic and question threads never hold it', () => {
    const thread = [
      opening,
      message('fyi', { from: 'dev' }),
      message('phase', { from: 'manager', target: 'dev', expectsReply: true }),
      message('onq', { from: 'dev', qid: 'q1', expectsReply: true }),
    ];

    expect(pendingAsk(thread)).toBeNull();
  });
});

describe('pendingAsk — the side chat is not his answer', () => {
  it('a side-chat message (a photo, a question) leaves his turn open; a real reply ends it', () => {
    const ask = message('ask', { from: 'dev', expectsReply: true });
    const sideChat = message('side', {
      from: 'human',
      chat: true,
      text: '[Image: /x/_uploads/img_a_b.png]',
    });
    const reply = message('reply1', { from: 'human', text: 'Go with A.' });

    expect(pendingAsk([opening, ask, sideChat])?.id).toBe('ask');
    expect(pendingAsk([opening, ask, sideChat, reply])).toBeNull();
  });
});

describe('pendingAsk — his chat with the Product manager is not his answer', () => {
  it('an Engineering manager --ask stays open through a PM chat; a real reply ends it', () => {
    const ask = message('ask', {
      from: 'engineering-manager',
      expectsReply: true,
    });
    const pmChat = message('pmchat', {
      from: 'human',
      target: 'product-manager',
      text: 'What did we decide about the Harvest Festival?',
    });
    const reply = message('reply2', { from: 'human', text: 'Ship it.' });

    expect(pendingAsk([opening, ask, pmChat])?.id).toBe('ask');
    expect(pendingAsk([opening, ask, pmChat, reply])).toBeNull();
  });
});
