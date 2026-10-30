import {
  chosenProjectId,
  defaultProjectId,
  groupByProject,
  showsProjects,
  ticketShortcut,
  withProjectTag,
} from '../client/projects';
import type { LambdaInfo } from '../shared/types';

const pawnee = {
  id: 'prj_pawnee',
  name: 'Pawnee Parks site',
  ticketPrefix: 'PAWNEE',
};
const sweetums = {
  id: 'prj_sweetums',
  name: 'Sweetums recipe app',
  ticketPrefix: null,
};

const lambda = (projects: LambdaInfo['projects']): LambdaInfo => ({
  owner: { name: 'Leslie Knope', initials: 'LK' },
  projects,
  lastProjectId: projects.at(-1)?.id ?? null,
  podProjects: {
    'dog-park': 'prj_pawnee',
    benches: 'prj_pawnee',
    nougat: 'prj_sweetums',
  },
  waiting: [],
});

const pods = ['dog-park', 'benches', 'nougat'].map((id) => ({ pod: { id } }));

describe('projects in the app', () => {
  it('looks as it always has with one project: no headings, no tags', () => {
    const one = lambda([pawnee]);

    expect(showsProjects(one)).toBe(false);
    expect(groupByProject(pods, one)).toEqual([
      { project: null, other: false, pods, waiting: [] },
    ]);
    expect(withProjectTag('Dog park map', 'dog-park', one)).toBe(
      'Dog park map'
    );
  });

  it('groups under project headings and tags items with two or more', () => {
    const two = lambda([pawnee, sweetums]);
    const groups = groupByProject(pods, two);

    expect(
      groups.map((group) => [
        group.project?.name,
        group.pods.map((summary) => summary.pod.id),
      ])
    ).toEqual([
      ['Pawnee Parks site', ['dog-park', 'benches']],
      ['Sweetums recipe app', ['nougat']],
    ]);
    expect(withProjectTag('Dog park map', 'dog-park', two)).toBe(
      'Dog park map · Pawnee Parks site'
    );
  });

  it('keeps pods with no project in a trailing group with two or more', () => {
    const two = lambda([pawnee, sweetums]);
    const withStray = [...pods, { pod: { id: 'unfiled' } }];
    const groups = groupByProject(withStray, two);

    expect(
      groups.map((group) => [
        group.project?.name ?? null,
        group.other,
        group.pods.map((summary) => summary.pod.id),
      ])
    ).toEqual([
      ['Pawnee Parks site', false, ['dog-park', 'benches']],
      ['Sweetums recipe app', false, ['nougat']],
      [null, true, ['unfiled']],
    ]);
  });

  it('still has one empty group to say "Nothing matches." with two or more', () => {
    const groups = groupByProject([], lambda([pawnee, sweetums]));

    expect(groups).toEqual([
      { project: null, other: false, pods: [], waiting: [] },
    ]);
  });

  it('sends a new idea to the last project used', () => {
    expect(defaultProjectId(lambda([pawnee, sweetums]))).toBe('prj_sweetums');
    expect(defaultProjectId(undefined)).toBeNull();
  });

  it('uses the project’s own ticket prefix, and hides the shortcut without one', () => {
    expect(ticketShortcut('PAWNEE')).toEqual({
      label: 'Plan a ticket or epic — PAWNEE-…',
      fill: 'Plan PAWNEE-',
    });
    expect(ticketShortcut(null)).toBeNull();
  });

  it('follows the projects as they come, until one is picked', () => {
    // A page opened before any project exists says "Add a codebase first.";
    // once one is added it shows that project without being reopened.
    expect(chosenProjectId(null, lambda([]))).toBeNull();
    expect(chosenProjectId(null, lambda([pawnee]))).toBe('prj_pawnee');
    expect(chosenProjectId('prj_pawnee', lambda([pawnee, sweetums]))).toBe(
      'prj_pawnee'
    );
    // A picked project that's gone falls back to the default.
    expect(chosenProjectId('prj_gone', lambda([pawnee, sweetums]))).toBe(
      'prj_sweetums'
    );
  });
});
