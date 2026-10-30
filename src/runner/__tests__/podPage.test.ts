import * as fs from 'fs';
import * as path from 'path';

import { ticketTimeline } from '../../app/shared/buildTimeline';
import { buildingPodStore } from '../../building/__tests__/fakes';
import type { Screenshot } from '../../pod-store';
import { buildingDetail } from '../podPage';

/**
 * A building pod's page as its runner reads it: the pod, its building
 * state, the codebase's steps and every test attempt's screenshots.
 */

const roots: string[] = [];

afterEach(() => {
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

const shot = (
  ticketId: string,
  attempt: number,
  passed: boolean
): Screenshot => ({
  file: `${attempt}-ramsett.png`,
  ticketId,
  attempt,
  url: 'http://localhost:3000/parks/ramsett',
  consoleErrors: passed ? [] : ['TypeError: pin is undefined'],
  conclusion: passed
    ? 'The Ramsett Park pin appeared.'
    : 'The Ramsett Park pin never appeared.',
  passed,
  at: '2026-10-23T10:00:00.000Z',
});

const setUp = () => {
  const made = buildingPodStore();
  roots.splice(roots.length, 0, made.root);

  return made;
};

const detailOf = (made: ReturnType<typeof setUp>) =>
  buildingDetail({
    store: made.store,
    podId: made.podId,
    projectRoot: made.root,
    windows: ['engineering-manager', 'dev'],
    computer: "Leslie's Mac",
  });

describe('buildingDetail', () => {
  it('marks a step the project switched off, and the rail leaves it out', () => {
    const made = setUp();
    fs.mkdirSync(path.join(made.root, '.lambda', 'building'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(made.root, '.lambda', 'building', 'a11y-check.md'),
      '# Accessibility check\n'
    );
    fs.writeFileSync(
      path.join(made.root, '.lambda', 'building', 'workflow.json'),
      JSON.stringify({
        extends: 'standard',
        add: [
          {
            id: 'a11y-check',
            label: 'Accessibility check',
            run: '/a11y-check',
            after: 'test',
            switch: true,
          },
        ],
        off: ['a11y-check'],
      })
    );

    const { steps } = detailOf(made);

    // Kept, marked off, so a ticket's "switched off" skip has a row.
    expect(steps.find((step) => step.id === 'a11y-check')).toEqual({
      id: 'a11y-check',
      label: 'Accessibility check',
      off: true,
    });
    // With no skip reported, the rail has no row for a step that never runs.
    expect(
      ticketTimeline([], '3', steps).steps.map((step) => step.id)
    ).not.toContain('a11y-check');
  });

  it("answers the pod, its windows, its computer and the codebase's steps once each", () => {
    const made = setUp();

    const detail = detailOf(made);

    expect(detail.pod.id).toBe(made.podId);
    expect(detail.windows).toEqual(['engineering-manager', 'dev']);
    expect(detail.computer).toBe("Leslie's Mac");
    expect(detail.screenshots).toEqual({});
    const ids = detail.steps.map((step) => step.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reads every attempt of every ticket, by <ticket>/<attempt>', () => {
    const made = setUp();
    made.store.writeScreenshots(made.podId, '3', 1, [shot('3', 1, false)]);
    made.store.writeScreenshots(made.podId, '3', 2, [shot('3', 2, true)]);

    expect(detailOf(made).screenshots).toEqual({
      '3/1': [shot('3', 1, false)],
      '3/2': [shot('3', 2, true)],
    });
  });

  it("skips what isn't a ticket's attempt: a stray file, a bad name, a non-numbered folder", () => {
    const made = setUp();
    made.store.writeScreenshots(made.podId, '3', 1, [shot('3', 1, true)]);
    const dir = made.store.file(made.podId, 'screenshots');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'bad name'));
    fs.mkdirSync(path.join(dir, '3', 'latest'));

    expect(Object.keys(detailOf(made).screenshots)).toEqual(['3/1']);
  });

  it('skips a dangling link instead of failing the whole page', () => {
    const made = setUp();
    made.store.writeScreenshots(made.podId, '3', 1, [shot('3', 1, true)]);
    fs.symlinkSync(
      path.join(made.root, 'gone'),
      path.join(made.store.file(made.podId, 'screenshots'), '4')
    );

    expect(Object.keys(detailOf(made).screenshots)).toEqual(['3/1']);
  });
});
