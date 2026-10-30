import {
  firstRailOf,
  planningRailOf,
  planningRailsOf,
  railFor,
  sideRowNeedsYou,
} from '../shared/screenChoice';

describe('the rail a Lambda opens on', () => {
  it('opens a building pod on Workflow on its own page', () => {
    expect(firstRailOf({ kind: 'building' }, true)).toBe('workflow');
  });

  it('opens a building pod from the inbox on Plan, never the planning Workflow', () => {
    expect(firstRailOf({ kind: 'building' }, false)).toBe('plan');
  });

  it('opens a structured planning pod on Plan and a freeform one shut', () => {
    expect(firstRailOf({ kind: 'planning', mode: 'structured' }, false)).toBe(
      'plan'
    );
    expect(firstRailOf({ mode: 'freeform' }, false)).toBeNull();
    expect(firstRailOf(undefined, false)).toBe('plan');
  });
});

describe("the planning screen's rail", () => {
  const on = { offPod: false, buildingPod: false };

  it('hides the Workflow rail when the pod behind it is a building pod', () => {
    expect(planningRailOf('workflow', { ...on, buildingPod: true })).toBeNull();
    expect(planningRailOf('workflow', on)).toBe('workflow');
  });

  it('shows Tickets and Plan only on a planning pod', () => {
    expect(planningRailOf('tickets', on)).toBe('tickets');
    expect(planningRailOf('tickets', { ...on, offPod: true })).toBeNull();
    expect(planningRailOf('tickets', { ...on, buildingPod: true })).toBeNull();
    expect(planningRailOf('plan', { ...on, offPod: true })).toBeNull();
    expect(planningRailOf('plan', on)).toBe('plan');
    expect(planningRailOf('agents', { ...on, buildingPod: true })).toBe(
      'agents'
    );
  });
});

describe("the planning screen's rail buttons", () => {
  it('offers a planning pod every planning rail', () => {
    expect(planningRailsOf('planning')).toEqual([
      'plan',
      'tickets',
      'workflow',
      'made',
      'agents',
    ]);
    expect(planningRailsOf(undefined)).toContain('workflow');
  });

  it('offers a building pod no Workflow button there', () => {
    expect(planningRailsOf('building')).not.toContain('workflow');
    expect(planningRailsOf('building')).not.toContain('tickets');
    expect(planningRailsOf('building')).toContain('plan');
  });
});

describe('the rail a Lambda comes back to', () => {
  const building = ['workflow', 'tickets', 'agents'];

  it('opens on its first rail the first time', () => {
    expect(railFor(undefined, building, 'workflow')).toBe('workflow');
  });

  it('keeps the rail left open, or shut, where that rail exists', () => {
    expect(railFor('tickets', building, 'workflow')).toBe('tickets');
    expect(railFor('', building, 'workflow')).toBeNull();
  });

  it("falls back to the first rail when the one left open isn't one of its rails", () => {
    // Opened from the inbox on Plan, then picked in the sidebar.
    expect(railFor('plan', building, 'workflow')).toBe('workflow');
    expect(railFor('nonsense', building, 'workflow')).toBe('workflow');
  });
});

describe('a sidebar row that needs you', () => {
  it('is marked while the pod has an inbox item, a Blocked one included', () => {
    expect(sideRowNeedsYou({ needsYou: 1 })).toBe(' side-row--needs-you');
    expect(sideRowNeedsYou({ needsYou: 0 })).toBe('');
  });
});
