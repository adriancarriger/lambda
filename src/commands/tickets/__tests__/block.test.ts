/**
 * A pod changes a dependency only after the owner said yes: on a question
 * they answered (`--qid`), or a checkpoint they closed (`--checkpoint`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, type Question } from '../../../pod-store/schemas';
import { createPodStore } from '../../../pod-store/store';
import { blockRefusal, checkBlockGate, checkpointRefusal } from '../gate';

const POD = 'pawnee-a1b2';

const question = (
  id: string,
  status: Question['status'],
  overrides: Partial<Question> = {}
): Question => ({
  id,
  podId: POD,
  kind: 'question',
  phase: 3,
  status,
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: '2026-10-10T00:00:00.000Z',
  options: [],
  ...overrides,
});

const checkpoint = (
  id: string,
  cp: number,
  status: Question['status']
): Question =>
  question(id, status, {
    kind: 'checkpoint',
    phase: cp,
    checkpoint: { cp, decisionIds: [] },
  });

const pod = (completedCheckpoints: number[]): Pod => ({
  id: POD,
  slug: 'pawnee',
  createdAt: '2026-10-10T00:00:00.000Z',
  status: 'active',
  phase: 5,
  completedCheckpoints,
  worktreePath: '/tmp/pawnee',
  ownsWorktree: false,
  managerCwd: '/tmp/pawnee',
  devCwd: '/tmp/pawnee',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
});

const openStore = (completed: number[] = [3]) => {
  const store = createPodStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-block-'))
  );
  store.writePod(pod(completed));
  store.writeQuestion(question('q1', 'answered'));
  store.writeQuestion(question('q2', 'open'));
  store.writeQuestion(checkpoint('q4', 3, 'answered'));
  store.writeQuestion(checkpoint('q5', 5, 'open'));

  return store;
};

const gateWith = (
  flags: { qid?: string; checkpoint?: string },
  where: { podId: string | undefined } = { podId: POD }
): void => {
  const store = openStore();

  checkBlockGate({
    podId: where.podId,
    owner: 'Leslie',
    store: () => store,
    ...flags,
  });
};

describe('the block gate', () => {
  it('refuses with no flag, allows an answered qid, refuses an open checkpoint, allows a closed one, refuses both', () => {
    expect(() => gateWith({})).toThrow(
      'A pod changes a dependency only after Leslie says so: pass --qid <the question Leslie answered> or --checkpoint <a checkpoint Leslie closed>.'
    );
    expect(() => gateWith({ qid: 'q1' })).not.toThrow();
    expect(() => gateWith({ checkpoint: 'q5' })).toThrow(
      "q5 (CP5) is open — Leslie hasn't closed it yet."
    );
    expect(() => gateWith({ checkpoint: 'q4' })).not.toThrow();
    expect(() => gateWith({ qid: 'q1', checkpoint: 'q4' })).toThrow(
      'Pass --qid or --checkpoint, not both.'
    );
  });

  it('allows anything with no POD_ID, both flags included: outside a pod there is no gate', () => {
    expect(() => gateWith({}, { podId: undefined })).not.toThrow();
    expect(() =>
      gateWith({ qid: 'q2', checkpoint: 'q5' }, { podId: undefined })
    ).not.toThrow();
  });

  it('never opens the pod store outside a pod', () => {
    const store = jest.fn(() => openStore());

    checkBlockGate({ podId: undefined, owner: 'Leslie', store });

    expect(store).not.toHaveBeenCalled();
  });
});

describe('blockRefusal', () => {
  it("names the owner when a question isn't answered", () => {
    const store = openStore();

    expect(blockRefusal(store, POD, 'q2', 'Leslie')).toBe(
      "q2 is open — Leslie hasn't answered it yet."
    );
    expect(blockRefusal(store, POD, 'q9', 'Leslie')).toBe(
      'No question q9 in this pod.'
    );
    expect(blockRefusal(store, POD, 'q1', 'Leslie')).toBeNull();
  });

  it('refuses a checkpoint passed as --qid, so a closed checkpoint is still required', () => {
    // q4 is an answered checkpoint the pod has not recorded as closed.
    const store = openStore([]);

    expect(blockRefusal(store, POD, 'q4', 'Leslie')).toBe(
      'q4 is a checkpoint, not a question — use --checkpoint.'
    );
    expect(() =>
      checkBlockGate({
        podId: POD,
        owner: 'Leslie',
        store: () => store,
        qid: 'q4',
      })
    ).toThrow('q4 is a checkpoint, not a question — use --checkpoint.');
  });
});

describe('checkpointRefusal', () => {
  it('needs a checkpoint the owner closed', () => {
    const store = openStore();

    expect(checkpointRefusal(store, POD, 'q4', 'Leslie')).toBeNull();
    expect(checkpointRefusal(store, POD, 'q1', 'Leslie')).toMatch(
      /not a checkpoint/
    );
    expect(checkpointRefusal(store, POD, 'q9', 'Leslie')).toBe(
      'No checkpoint q9 in this pod.'
    );
  });

  it('refuses an answered checkpoint the pod has not recorded as closed', () => {
    expect(checkpointRefusal(openStore([]), POD, 'q4', 'Leslie')).toMatch(
      /Leslie hasn't closed it yet/
    );
  });
});
