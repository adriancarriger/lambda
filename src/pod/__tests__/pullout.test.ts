/**
 * A pod may start a pod only with the owner's say-so: a ticket the owner agreed to pull
 * out, at a checkpoint the owner closed, or a new Lambda the owner agreed to
 * in the chat.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Pod, Question, ThreadMessage } from '../../pod-store';
import { newAsPerson, pullOutRefusal, spinoffRefusal } from '../pullout';
import './podProject';

const pod = (completed: number[]): Pod => ({
  id: 'batch-3-a1b2',
  slug: 'batch-3',
  createdAt: '2026-10-10T00:00:00.000Z',
  status: 'active',
  phase: 2,
  completedCheckpoints: completed,
  worktreePath: '/tmp/b',
  ownsWorktree: false,
  managerCwd: '/tmp/b',
  devCwd: '/tmp/b',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  pipeline: 2,
  source: 'batch',
  tickets: ['PAWNEE-84', 'PAWNEE-83'],
});

type Row = NonNullable<
  NonNullable<Question['checkpoint']>['planTickets']
>[number];

const cp2 = (status: Question['status'], rows: Row[]): Question => ({
  id: 'q9',
  podId: 'batch-3-a1b2',
  kind: 'checkpoint',
  phase: 2,
  status,
  blocksCheckpoint: true,
  dependsOn: [],
  createdAt: '2026-10-10T00:00:00.000Z',
  options: [],
  checkpoint: { cp: 2, decisionIds: [], planTickets: rows },
});

const PULL: Row = {
  id: 'PAWNEE-84',
  title: 'Detour signs',
  name: '1 - Pull it out: detour signs need their own epic',
  proposal: 'pull-out',
};
const PLAN: Row = {
  id: 'PAWNEE-83',
  title: 'Marker typo',
  name: '2 - Plan it: fix the typo',
  proposal: 'plan',
};

describe('pullOutRefusal', () => {
  it('allows a pull-out row on a checkpoint the owner closed', () => {
    expect(
      pullOutRefusal(pod([2]), cp2('answered', [PULL, PLAN]), 'PAWNEE-84')
    ).toBeNull();
  });

  it('refuses before the owner closes the checkpoint', () => {
    expect(pullOutRefusal(pod([]), cp2('open', [PULL]), 'PAWNEE-84')).toMatch(
      /isn't closed yet/
    );
  });

  it('refuses a ticket the owner kept in the batch', () => {
    expect(
      pullOutRefusal(pod([2]), cp2('answered', [PULL, PLAN]), 'PAWNEE-83')
    ).toMatch(/isn't a pull-out/);
  });

  it('refuses without a checkpoint, or with something that is not one', () => {
    expect(pullOutRefusal(pod([2]), undefined, 'PAWNEE-84')).toMatch(
      /--from-checkpoint/
    );
    expect(
      pullOutRefusal(
        pod([2]),
        { ...cp2('answered', [PULL]), kind: 'question' },
        'PAWNEE-84'
      )
    ).toMatch(/--from-checkpoint/);
  });

  it('reads older rows by their name when they carry no proposal', () => {
    const { proposal: _proposal, ...old } = PULL;

    expect(
      pullOutRefusal(pod([2]), cp2('answered', [old]), 'PAWNEE-84')
    ).toBeNull();
  });
});

describe('spinoffRefusal', () => {
  const message = (id: string, from: ThreadMessage['from']): ThreadMessage => ({
    id,
    podId: 'batch-3-a1b2',
    from,
    mode: from === 'human' ? 'sync' : 'note',
    text: from === 'human' ? 'B' : 'A, B or C?',
    createdAt: '2026-10-18T20:00:00.000Z',
    delivery: 'received',
  });
  const thread = [message('m-ask', 'dev'), message('m-owner', 'human')];
  const text = 'Claude Design as its own epic for Pawnee Parks.';

  it("allows the owner's own message agreeing to it", () => {
    expect(spinoffRefusal(thread, 'm-owner', text)).toBeNull();
  });

  it("refuses a message that isn't the owner's", () => {
    expect(spinoffRefusal(thread, 'm-ask', text)).toMatch(/isn't the owner's/);
  });

  it('refuses a message not in this chat', () => {
    expect(spinoffRefusal(thread, 'm-other', text)).toMatch(/No message/);
  });

  it('refuses without saying what the new Lambda is about', () => {
    expect(spinoffRefusal(thread, 'm-owner', '  ')).toMatch(/--text/);
  });
});

describe('newAsPerson', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it("re-runs the running lambda with Lambda's pods root, as nobody's pod", () => {
    process.env.LAMBDA_PODS_ROOT = '/tmp/pawnee-pods';
    process.env.POD_ID = 'batch-3-a1b2';
    process.env.POD_AGENT = 'dev';
    // A stand-in `lambda` that writes down how it was run.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-bin-'));
    const runningBinary = path.join(bin, 'lambda');
    const report = path.join(bin, 'ran.json');
    fs.writeFileSync(
      runningBinary,
      `require('fs').writeFileSync(${JSON.stringify(
        report
      )}, JSON.stringify({ argv: process.argv.slice(1), env: process.env }));\n`
    );

    newAsPerson(['dog-park', '--single'], runningBinary);

    const ran: { argv: string[]; env: Record<string, string> } = JSON.parse(
      fs.readFileSync(report, 'utf8')
    );
    expect(ran.argv).toEqual([
      runningBinary,
      'pod',
      'new',
      'dog-park',
      '--single',
    ]);
    expect(ran.env.LAMBDA_PODS_ROOT).toBe('/tmp/pawnee-pods');
    expect(ran.env.POD_ID).toBeUndefined();
    expect(ran.env.POD_AGENT).toBeUndefined();
    // Whatever another tool set in this shell passes through; Lambda adds
    // nothing of its own beyond its pods root.
    expect(
      Object.keys(ran.env).filter(
        (key) => !(key in process.env) && key !== 'LAMBDA_PODS_ROOT'
      )
    ).toEqual([]);
  });
});
