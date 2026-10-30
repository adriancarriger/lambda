import * as fs from 'fs';

import { runStatus } from '../../pod/lifecycle';
import { buildingPodStore } from './fakes';

/** `lambda pod status` on a building pod: its tickets, not planning's phases. */
describe('the status of a building pod', () => {
  const lines: string[] = [];
  const roots: string[] = [];

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.splice(lines.length, 0, line);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    lines.splice(0);
    delete process.env.LAMBDA_PODS_ROOT;
    roots
      .splice(0)
      .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it('shows the ticket it is on and what shipped, never a planning phase', () => {
    const { store, root, podId } = buildingPodStore();
    roots.splice(roots.length, 0, root);
    process.env.LAMBDA_PODS_ROOT = store.root;
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: [
        {
          id: 'PAWNEE-1',
          title: 'Park map page',
          step: 'build',
          attempt: 2,
          startedAt: '2026-10-25T17:05:17.894Z',
          shippedAt: '2026-10-25T17:08:34.777Z',
          claim: 'claimed',
        },
        {
          id: 'PAWNEE-2',
          title: 'Volunteer sign-up form',
          step: 'check-ticket',
          attempt: 1,
          startedAt: '2026-10-25T17:09:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [{ id: 'PAWNEE-3', title: 'Ice Town banner' }],
    }));

    runStatus(podId);
    const text = lines.join('\n');

    expect(text).toContain(
      'ticket:       PAWNEE-2 Volunteer sign-up form — step check-ticket, attempt 1'
    );
    expect(text).toContain('shipped:      PAWNEE-1');
    expect(text).toContain('up next:      PAWNEE-3');
    expect(text).toContain('engineering-manager turn:');
    expect(text).not.toMatch(/phase:|track:|checkpoints:/);
  });
});
