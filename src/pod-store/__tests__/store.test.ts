import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, type Question, podRenderMode } from '../schemas';
import { PodScopeError, createPodStore, writeJsonAtomic } from '../store';

const tmpRoot = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'pod-store-'));

const pod = (id: string): Pod => ({
  id,
  slug: id,
  createdAt: '2026-10-03T00:00:00.000Z',
  status: 'active',
  phase: 1,
  completedCheckpoints: [],
  worktreePath: `/tmp/${id}`,
  ownsWorktree: true,
  managerCwd: `/tmp/${id}/manager`,
  devCwd: `/tmp/${id}`,
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
});

const draft = (podId: string, id: string): Question => ({
  id,
  podId,
  kind: 'question',
  phase: 2,
  status: 'draft',
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: new Date().toISOString(),
  options: [],
});

describe('createPodStore', () => {
  it('round-trips a pod and lists only directories that hold a pod.json', () => {
    const root = tmpRoot();
    const store = createPodStore(root);
    store.writePod(pod('pawnee-a1b2'));
    fs.mkdirSync(path.join(root, 'not-a-pod'));

    expect(store.listPodIds()).toEqual(['pawnee-a1b2']);
    expect(store.requirePod('pawnee-a1b2').slug).toBe('pawnee-a1b2');
  });

  it('refuses any operation on another pod when scoped', () => {
    const root = tmpRoot();
    createPodStore(root).writePod(pod('pawnee-a1b2'));
    createPodStore(root).writePod(pod('eagleton-c3d4'));
    const scoped = createPodStore(root, { scopePodId: 'pawnee-a1b2' });

    expect(() => scoped.writeQuestion(draft('eagleton-c3d4', 'q1'))).toThrow(
      PodScopeError
    );
    expect(() => scoped.readQuestion('eagleton-c3d4', 'q1')).toThrow(
      PodScopeError
    );
    expect(scoped.listPodIds()).toEqual(['pawnee-a1b2']);
    expect(() =>
      scoped.writeQuestion(draft('pawnee-a1b2', 'q1'))
    ).not.toThrow();
  });

  it('reads a pod with no renderMode as full on a computer with Claude Design, and refuses an unknown one', () => {
    const root = tmpRoot();
    const store = createPodStore(root);
    store.writePod(pod('pawnee-a1b2'));
    const written = store.requirePod('pawnee-a1b2');

    expect(written.renderMode).toBeUndefined();
    expect(podRenderMode(written, { design: { available: true } })).toBe(
      'full'
    );

    store.writePod({ ...pod('pawnee-a1b2'), renderMode: 'ascii' });
    expect(
      podRenderMode(store.requirePod('pawnee-a1b2'), {
        design: { available: true },
      })
    ).toBe('ascii');

    fs.writeFileSync(
      path.join(root, 'pawnee-a1b2', 'pod.json'),
      JSON.stringify({ ...pod('pawnee-a1b2'), renderMode: 'fast' })
    );
    expect(() => store.readPod('pawnee-a1b2')).toThrow();
  });

  it('rejects path-traversal ids', () => {
    const store = createPodStore(tmpRoot());

    expect(() => store.readPod('../etc')).toThrow('Invalid pod id');
    expect(() => store.readQuestion('pawnee-a1b2', '../../x')).toThrow(
      'Invalid question id'
    );
  });

  it('numbers questions without reusing a withdrawn number', () => {
    const store = createPodStore(tmpRoot());
    store.writePod(pod('pawnee-a1b2'));
    store.writeQuestion({ ...draft('pawnee-a1b2', 'q1'), status: 'withdrawn' });
    store.writeQuestion(draft('pawnee-a1b2', 'q2'));

    expect(store.nextQuestionId('pawnee-a1b2')).toBe('q3');
  });

  it('folds delivery events: pending → delivered → received', () => {
    const store = createPodStore(tmpRoot());
    store.writePod(pod('pawnee-a1b2'));
    store.appendThread({
      id: 'm1',
      podId: 'pawnee-a1b2',
      from: 'human',
      mode: 'async',
      text: 'go with B',
      wire: '/human-async q1 [m:m1]: go with B',
      target: 'dev',
      createdAt: new Date().toISOString(),
    });

    expect(store.readThread('pawnee-a1b2')[0]?.delivery).toBe('pending');

    store.appendDelivery('pawnee-a1b2', {
      msgId: 'm1',
      status: 'delivered',
      at: new Date().toISOString(),
    });

    expect(store.readThread('pawnee-a1b2')[0]?.delivery).toBe('delivered');

    store.appendDelivery('pawnee-a1b2', {
      msgId: 'm1',
      status: 'received',
      at: new Date().toISOString(),
    });

    expect(store.readThread('pawnee-a1b2')[0]?.delivery).toBe('received');
  });

  it('treats agent-authored entries (no wire text) as already received', () => {
    const store = createPodStore(tmpRoot());
    store.writePod(pod('pawnee-a1b2'));
    store.appendThread({
      id: 'm2',
      podId: 'pawnee-a1b2',
      from: 'dev',
      mode: 'sync',
      text: 'B, because…',
      createdAt: new Date().toISOString(),
    });

    expect(store.readThread('pawnee-a1b2')[0]?.delivery).toBe('received');
  });

  it('writes atomically, leaving no temp files behind', () => {
    const root = tmpRoot();
    writeJsonAtomic(path.join(root, 'x', 'a.json'), { ok: true });

    expect(fs.readdirSync(path.join(root, 'x'))).toEqual(['a.json']);
  });

  it('amends one autonomous decision in place, keeping its id and order', () => {
    const store = createPodStore(tmpRoot());
    store.writePod(pod('pawnee-a1b2'));
    const base = {
      podId: 'pawnee-a1b2',
      phase: 3,
      why: 'why',
      createdAt: '2026-10-03T00:00:00.000Z',
    };
    store.appendAutonomousDecision({ ...base, id: 'd1', decision: 'First' });
    store.appendAutonomousDecision({ ...base, id: 'd2', decision: 'Second' });

    store.updateAutonomousDecision('pawnee-a1b2', 'd1', (decision) => ({
      ...decision,
      decision: 'First, in plain words',
      details: 'the technical part',
    }));

    expect(store.readAutonomousDecisions('pawnee-a1b2')).toMatchObject([
      {
        id: 'd1',
        decision: 'First, in plain words',
        details: 'the technical part',
      },
      { id: 'd2', decision: 'Second' },
    ]);
    expect(() =>
      store.updateAutonomousDecision(
        'pawnee-a1b2',
        'd9',
        (decision) => decision
      )
    ).toThrow('No autonomous decision d9');
  });

  it('defaults the inbox to an empty priority list', () => {
    const store = createPodStore(tmpRoot());

    expect(store.readInbox()).toEqual({ priority: [] });
    store.writeInbox({ priority: ['eagleton-c3d4', 'pawnee-a1b2'] });
    expect(store.readInbox().priority).toEqual([
      'eagleton-c3d4',
      'pawnee-a1b2',
    ]);
  });
});
