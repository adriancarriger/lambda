import { buildChatHandoff } from '../resolution';
import { type HumanDecision, type ThreadMessage } from '../schemas';

const message = (
  id: string,
  from: ThreadMessage['from'],
  text: string,
  qid?: string
): ThreadMessage => ({
  id,
  podId: 'pawnee-a1b2',
  qid,
  from,
  mode: 'sync',
  text,
  chat: true,
  createdAt: `2026-10-07T10:0${id.slice(1)}:00.000Z`,
  delivery: 'received',
});

describe('the Chat panel hand-off', () => {
  it('groups what was said by topic, each with its decisions and his words', () => {
    const decisions: HumanDecision[] = [
      {
        id: 'd1',
        podId: 'pawnee-a1b2',
        qid: 'q7',
        decision: 'Keep ticket 0 as a checklist',
        quote: 'yeah keep it a checklist',
        createdAt: '2026-10-07T10:02:00.000Z',
      },
    ];
    const wire = buildChatHandoff({
      ownerName: 'Leslie Knope',
      msgId: 'm9',
      messages: [
        message('m1', 'human', 'why is ticket 0 a checklist?', 'q7'),
        message('m2', 'fork', 'Recorded: Keep ticket 0 as a checklist.', 'q7'),
        message('m3', 'human', 'where are we overall?'),
        message('m4', 'fork', 'Waiting on you at the split proposal.'),
      ],
      decisions,
      topicLabel: (qid) =>
        qid === 'q7' ? 'q7 (Checkpoint 3)' : 'the whole pod',
    });

    expect(wire.split('\n')[0]).toBe('/human-resolved chat [m:m9]');
    expect(wire).toContain('## About q7 (Checkpoint 3)');
    expect(wire).toContain('1. Keep ticket 0 as a checklist');
    expect(wire).toContain('Leslie Knope: "yeah keep it a checklist"');
    expect(wire).toContain('## About the whole pod');
    // The whole-pod topic has no decisions, and its talk is under it.
    expect(wire.split('## About the whole pod')[1]).toContain(
      '[human] where are we overall?'
    );
    expect(wire.split('## About the whole pod')[1]).toContain(
      '(none recorded)'
    );
  });
});
