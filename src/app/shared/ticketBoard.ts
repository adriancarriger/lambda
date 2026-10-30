import type { Priority, TicketState } from '../../tickets/source';
import {
  TICKET_GROUPS,
  type TicketChanges,
  type TicketGroupName,
  type TicketListItem,
  groupOfStatus,
} from './building';
import { ticketKey } from './ticketList';

/**
 * The Tickets screen's list, laid out as Linear lays out issues: groups (by
 * status unless Display says otherwise), one dense row per ticket, an epic's
 * tickets indented under it, and filters as chips. Pure: the client bundles
 * this file.
 *
 * Every status's name, icon and "only the build sets it" live in one table,
 * so statuses a project names itself later change the table, not the screen.
 */

export interface StatusLook {
  name: string;
  /** Which of the icons it draws: also its colour. */
  icon:
    | 'inbox'
    | 'planning'
    | 'ready'
    | 'building'
    | 'blocked'
    | 'shipped'
    | 'canceled';
  /** Building and Shipped: set when a pod picks a ticket up or ships it. */
  setByBuild: boolean;
}

export const STATUSES: Record<TicketState, StatusLook> = {
  inbox: { name: 'Inbox', icon: 'inbox', setByBuild: false },
  planning: { name: 'Planning', icon: 'planning', setByBuild: false },
  ready: { name: 'Ready', icon: 'ready', setByBuild: false },
  building: { name: 'Building', icon: 'building', setByBuild: true },
  blocked: { name: 'Blocked', icon: 'blocked', setByBuild: false },
  done: { name: 'Shipped', icon: 'shipped', setByBuild: true },
  canceled: { name: 'Canceled', icon: 'canceled', setByBuild: false },
};

/** The statuses a person picks from, in menu order. */
/** Every status, in the order the Status filter lists them. */
export const ALL_STATUSES: TicketState[] = [
  'inbox',
  'planning',
  'ready',
  'building',
  'blocked',
  'done',
  'canceled',
];

export const PICKABLE_STATUSES: TicketState[] = (
  ['inbox', 'planning', 'ready', 'blocked', 'canceled'] as const
).filter((status) => !STATUSES[status].setByBuild);

export const PRIORITY_NAMES: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};

/** Menu order, as Linear's. */
export const PRIORITY_ORDER: Priority[] = [
  'none',
  'urgent',
  'high',
  'medium',
  'low',
];

export const priorityOf = (item: Pick<TicketListItem, 'priority'>): Priority =>
  item.priority ?? 'none';

export const assigneeOf = (
  item: Pick<TicketListItem, 'assignee'>
): string | null => item.assignee ?? null;

// ── filters ─────────────────────────────────────────────────────────────────

export const FILTER_FIELDS = [
  'status',
  'priority',
  'assignee',
  'project',
  'label',
  'epic',
  'codebase',
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_NAMES: Record<FilterField, string> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  project: 'Project',
  label: 'Label',
  epic: 'Epic',
  codebase: 'Codebase',
};

/**
 * One chip: `assignee` with value '' is Unassigned; `epic` is the epic's id
 * (its tickets and itself).
 */
export interface FilterChip {
  field: FilterField;
  value: string;
}

/** A chip's value as the field holds it, for matching. */
const valuesOf = (item: TicketListItem, field: FilterField): string[] => {
  switch (field) {
    case 'status':
      return [item.status];
    case 'priority':
      return [priorityOf(item)];
    case 'assignee':
      return [assigneeOf(item) ?? ''];
    case 'project':
      return [item.project ?? ''];
    case 'codebase':
      return [item.projectId];
    case 'epic':
      return item.parent === null ? [item.id] : [item.parent, item.id];
    case 'label':
      return item.labels;
    default:
      return [];
  }
};

/**
 * Chips on one field are any-of; chips on different fields all apply.
 * Canceled tickets show only when a Status chip asks for them.
 */
export const matchesChips = (
  item: TicketListItem,
  chips: FilterChip[],
  search: string
): boolean => {
  const needle = search.trim().toLowerCase();
  const fields = [...new Set(chips.map((chip) => chip.field))];
  const askedCanceled = chips.some(
    (chip) => chip.field === 'status' && chip.value === 'canceled'
  );

  return (
    (needle === '' ||
      item.title.toLowerCase().includes(needle) ||
      item.id.toLowerCase().includes(needle)) &&
    (item.status !== 'canceled' || askedCanceled) &&
    fields.every((field) =>
      chips
        .filter((chip) => chip.field === field)
        .some((chip) => valuesOf(item, field).includes(chip.value))
    )
  );
};

// ── groups and rows ─────────────────────────────────────────────────────────

export const GROUPINGS = [
  'status',
  'assignee',
  'project',
  'epic',
  'codebase',
] as const;

export type Grouping = (typeof GROUPINGS)[number];

export const GROUPING_NAMES: Record<Grouping, string> = {
  status: 'Status',
  assignee: 'Assignee',
  project: 'Project',
  epic: 'Epic',
  codebase: 'Codebase',
};

export interface BoardRow {
  item: TicketListItem;
  /** 1 for a ticket listed under its epic. */
  depth: 0 | 1;
  /** An epic's tickets: how many have shipped, of how many. */
  progress: { done: number; total: number } | null;
}

export interface BoardGroup {
  key: string;
  label: string;
  /** Grouped by status: the status its icon shows. */
  status: TicketState | null;
  rows: BoardRow[];
}

export interface BoardOptions {
  groupBy: Grouping;
  chips: FilterChip[];
  search: string;
  /** Keys of tickets in an open shipping-together group. */
  shippingTogether: Set<string>;
  projectName: (projectId: string) => string;
}

/** A pod-made ticket the source also has is listed once, as the source's. */
const unique = (items: TicketListItem[]): TicketListItem[] => {
  const fromSource = new Set(
    items
      .filter((item) => item.source !== 'pod')
      .map((item) => ticketKey(item.projectId, item.id))
  );
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = ticketKey(item.projectId, item.id);

    if (seen.has(key) || (item.source === 'pod' && fromSource.has(key))) {
      return false;
    }

    seen.add(key);

    return true;
  });
};

/** Each epic's progress, by its key: its tickets shipped of all of them. */
export const epicProgress = (
  items: TicketListItem[]
): Map<string, { done: number; total: number }> =>
  items.reduce((progress, item) => {
    if (item.parent === null || item.status === 'canceled') {
      return progress;
    }

    const key = ticketKey(item.projectId, item.parent);
    const sofar = progress.get(key) ?? { done: 0, total: 0 };

    return progress.set(key, {
      done: sofar.done + (item.status === 'done' ? 1 : 0),
      total: sofar.total + 1,
    });
  }, new Map<string, { done: number; total: number }>());

/**
 * A group's rows in queue order, each ticket whose epic is in the same group
 * right under it.
 */
const rowsOf = (
  members: TicketListItem[],
  progress: Map<string, { done: number; total: number }>
): BoardRow[] => {
  const keys = new Set(
    members.map((item) => ticketKey(item.projectId, item.id))
  );
  const underEpic = (item: TicketListItem): boolean =>
    item.parent !== null && keys.has(ticketKey(item.projectId, item.parent));
  const row = (item: TicketListItem, depth: 0 | 1): BoardRow => ({
    item,
    depth,
    progress: progress.get(ticketKey(item.projectId, item.id)) ?? null,
  });

  return members
    .filter((item) => !underEpic(item))
    .flatMap((item) => [
      row(item, 0),
      ...members
        .filter(
          (child) =>
            underEpic(child) &&
            child.projectId === item.projectId &&
            child.parent === item.id
        )
        .map((child) => row(child, 1)),
    ]);
};

const statusGroupState: Record<TicketGroupName, TicketState | null> = {
  Building: 'building',
  'Shipping together': null,
  Ready: 'ready',
  Planning: 'planning',
  Inbox: 'inbox',
  Blocked: 'blocked',
  Shipped: 'done',
  Canceled: 'canceled',
};

/** The list's groups with tickets in them, in screen order. */
export const boardGroups = (
  items: TicketListItem[],
  options: BoardOptions
): BoardGroup[] => {
  const all = unique(items);
  const progress = epicProgress(all);
  const shown = all.filter((item) =>
    matchesChips(item, options.chips, options.search)
  );
  const titleOf = (projectId: string, id: string): string =>
    all.find((item) => item.projectId === projectId && item.id === id)?.title ??
    id;

  if (options.groupBy === 'status') {
    const groupOf = (item: TicketListItem): TicketGroupName =>
      options.shippingTogether.has(ticketKey(item.projectId, item.id))
        ? 'Shipping together'
        : groupOfStatus(item.status);

    return TICKET_GROUPS.map((name) => ({
      key: name,
      label: name,
      status: statusGroupState[name],
      rows: rowsOf(
        shown.filter((item) => groupOf(item) === name),
        progress
      ),
    })).filter((group) => group.rows.length > 0);
  }

  const keyOf = (item: TicketListItem): { key: string; label: string } => {
    switch (options.groupBy) {
      case 'codebase':
        return {
          key: item.projectId,
          label: options.projectName(item.projectId),
        };
      case 'project':
        return (item.project ?? null) === null
          ? { key: '', label: 'No project' }
          : { key: item.project ?? '', label: item.project ?? '' };
      case 'epic': {
        const epic =
          item.parent ??
          (progress.has(ticketKey(item.projectId, item.id)) ? item.id : null);

        return epic === null
          ? { key: '', label: 'No epic' }
          : {
              key: ticketKey(item.projectId, epic),
              label: titleOf(item.projectId, epic),
            };
      }
      default: {
        const computer = assigneeOf(item);

        return computer === null
          ? { key: '', label: 'Unassigned' }
          : { key: computer, label: computer };
      }
    }
  };
  const order = [
    ...new Map(shown.map((item) => [keyOf(item).key, keyOf(item)])).values(),
  ].sort(
    (a, b) =>
      // "No epic", "No project" and "Unassigned" come last.
      Number(a.key === '') - Number(b.key === '') ||
      a.label.localeCompare(b.label)
  );

  return order.map(({ key, label }) => ({
    key,
    label,
    status: null,
    rows: rowsOf(
      shown.filter((item) => keyOf(item).key === key),
      progress
    ),
  }));
};

/** Every row on screen, top to bottom, skipping folded groups: for j and k. */
export const visibleRows = (
  groups: BoardGroup[],
  folded: Set<string>
): BoardRow[] =>
  groups.flatMap((group) => (folded.has(group.key) ? [] : group.rows));

/** "Oct 26" for a time this year, "Oct 26, 2025" for another. */
export const shortDate = (at: number, now: number): string => {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

// ── a ticket's Activity ─────────────────────────────────────────────────────

export interface ActivityEntry {
  at: number;
  /** Who did it: the person, a computer or "Lambda". */
  who: string;
  text: string;
}

/** What a person's change reads as: "set priority to High". */
const editText = (name: string, note: string): string => {
  switch (name) {
    case 'priority':
      return isPriorityName(note)
        ? `set priority to ${PRIORITY_NAMES[note]}`
        : `set priority to ${note}`;
    case 'assignee':
      return note === '' ? 'unassigned it' : `assigned it to ${note}`;
    case 'status':
      return `moved it to ${isStatusName(note) ? STATUSES[note].name : note}`;
    case 'title':
      return `renamed it to “${note}”`;
    case 'description':
      return 'edited the description';
    case 'labels':
      return note
        .split(', ')
        .map((one) =>
          one.startsWith('-')
            ? `removed the ${one.slice(1)} label`
            : `added the ${one.replace(/^\+/, '')} label`
        )
        .join(', ');
    case 'parent':
      return note === '' ? 'took it out of its epic' : `moved it under ${note}`;
    default:
      return `changed ${name}`;
  }
};

export const isPriorityName = (value: string): value is Priority =>
  PRIORITY_ORDER.some((priority) => priority === value);

export const isStatusName = (value: string): value is TicketState =>
  Object.keys(STATUSES).some((state) => state === value);

interface ActivityEvent {
  type: string;
  name: string | null;
  result: string | null;
  at: number;
  skipped?: boolean;
  note?: string | null;
  source?: string | null;
}

/**
 * A ticket's Activity, oldest first: who changed what on the Tickets screen,
 * when the build picked it up, one line for its steps so far ("Build ✓ 9m ·
 * Test now") and when it shipped.
 */
export const ticketActivity = (
  events: ActivityEvent[],
  stepName: (id: string) => string,
  minutes: (ms: number) => string
): ActivityEntry[] => {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const edits = ordered.flatMap((event): ActivityEntry[] => {
    if (event.type === 'ticket.create') {
      return [
        { at: event.at, who: event.source ?? 'Someone', text: 'created it' },
      ];
    }

    if (event.type === 'ticket.edit') {
      return [
        {
          at: event.at,
          who: event.source ?? 'Someone',
          text: editText(event.name ?? '', event.note ?? ''),
        },
      ];
    }

    return [];
  });
  const stages = ordered.filter(
    (event) =>
      (event.type === 'stage.start' || event.type === 'stage.end') &&
      event.name !== null
  );
  const [first] = stages;

  if (first === undefined) {
    return edits;
  }

  const names = [
    ...new Set(
      stages
        .filter((event) => event.skipped !== true)
        .map((event) => event.name ?? '')
    ),
  ].filter((name) => name !== 'pick-up');
  const parts = names.flatMap((name) => {
    const own = stages.filter((event) => event.name === name);
    const start = own.find((event) => event.type === 'stage.start');
    const end = [...own].reverse().find((event) => event.type === 'stage.end');

    if (end === undefined) {
      return [`${stepName(name)} now`];
    }

    if (end.result === 'fail') {
      return [`${stepName(name)} ✗`];
    }

    return [
      start === undefined || start.at > end.at
        ? `${stepName(name)} ✓`
        : `${stepName(name)} ✓ ${minutes(end.at - start.at)}`,
    ];
  });
  const last = stages.at(-1) ?? first;
  const shipped = stages.find(
    (event) =>
      event.type === 'stage.end' &&
      event.name === 'ship' &&
      event.result !== 'fail'
  );
  const build: ActivityEntry[] = [
    { at: first.at, who: 'Lambda', text: 'picked it up' },
    ...(parts.length === 0
      ? []
      : [{ at: last.at, who: 'Lambda', text: parts.join(' · ') }]),
    ...(shipped === undefined
      ? []
      : [{ at: shipped.at, who: 'Lambda', text: 'shipped it' }]),
  ];

  return [...edits, ...build].sort((a, b) => a.at - b.at);
};

/** Label dots, as Linear colours them: each label keeps its own colour. */
const LABEL_COLOURS = [
  '#3b6fb6',
  '#b4542f',
  '#2f7d4a',
  '#8a5bb5',
  '#c27b12',
  '#2a8c8c',
];

export const labelColour = (label: string): string =>
  LABEL_COLOURS[
    [...label.toLowerCase()].reduce(
      (sum, char) => (sum * 31 + char.charCodeAt(0)) % 997,
      7
    ) % LABEL_COLOURS.length
  ] ?? '#3b6fb6';

// ── computers, for the assignee picker ──────────────────────────────────────

export interface ComputerChoice {
  name: string;
  /** building, testing, shipping, blocked, idle, paused or offline. */
  state: string;
  /** Has this ticket's project: listed first. */
  hasProject: boolean;
  /** The trackers it knows its own user in; left out: unknown. */
  trackers?: string[];
}

/**
 * Every computer and what it's doing now: its building pod's state, else
 * idle, or offline when its socket is closed.
 */
export const computerChoices = (
  computers: Array<{
    name: string;
    connected: boolean;
    projectIds: string[];
    trackers?: string[];
  }>,
  building: Array<{ computer: string; state: string }>,
  projectId: string
): ComputerChoice[] =>
  computers
    .map((computer) => ({
      name: computer.name,
      state: !computer.connected
        ? 'offline'
        : building.find((one) => one.computer === computer.name)?.state ??
          'idle',
      hasProject: computer.projectIds.includes(projectId),
      ...(computer.trackers === undefined
        ? {}
        : { trackers: computer.trackers }),
    }))
    .sort(
      (a, b) =>
        Number(b.hasProject) - Number(a.hasProject) ||
        a.name.localeCompare(b.name)
    );

/**
 * Only what a change really changes: picking the value a ticket already has
 * sends nothing, and leaves nothing in its Activity. Null when nothing is
 * left.
 */
export const realChanges = (
  item: TicketListItem,
  description: string | null,
  changes: TicketChanges
): TicketChanges | null => {
  const kept: TicketChanges = {
    ...(changes.title === undefined || changes.title === item.title
      ? {}
      : { title: changes.title }),
    ...(changes.description === undefined || changes.description === description
      ? {}
      : { description: changes.description }),
    ...(changes.status === undefined || changes.status === item.status
      ? {}
      : { status: changes.status }),
    ...(changes.priority === undefined || changes.priority === priorityOf(item)
      ? {}
      : { priority: changes.priority }),
    ...(changes.assignee === undefined || changes.assignee === assigneeOf(item)
      ? {}
      : { assignee: changes.assignee }),
    ...(changes.parent === undefined || changes.parent === item.parent
      ? {}
      : { parent: changes.parent }),
  };
  const adding = (changes.labels ?? []).filter(
    (label) => !item.labels.includes(label)
  );
  const removing = (changes.removeLabels ?? []).filter((label) =>
    item.labels.includes(label)
  );
  const all: TicketChanges = {
    ...kept,
    ...(adding.length === 0 ? {} : { labels: adding }),
    ...(removing.length === 0 ? {} : { removeLabels: removing }),
  };

  return Object.keys(all).length === 0 ? null : all;
};
