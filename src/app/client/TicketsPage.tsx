import {
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  Priority,
  TicketState,
  TrackerProject,
} from '../../tickets/source';
import { formatMinutes, stepDisplayName } from '../shared/buildTimeline';
import type {
  BuildingPodDetail,
  NewTicket,
  TicketChanges,
  TicketListItem,
  TicketPage,
  TicketsResponse,
} from '../shared/building';
import { agoShort } from '../shared/building';
import {
  type Lambda,
  askRouteOf,
  lambdaOfTicket,
  lambdasOf,
} from '../shared/lambdas';
import {
  type ListSettings,
  NO_SETTINGS,
  decodeSettings,
  encodeSettings,
  favoriteRef,
  listSettingsOf,
  sameSettings,
} from '../shared/savedViews';
import {
  ALL_STATUSES,
  type BoardRow,
  type ComputerChoice,
  FILTER_FIELDS,
  FILTER_NAMES,
  type FilterChip,
  type FilterField,
  GROUPINGS,
  GROUPING_NAMES,
  type Grouping,
  PICKABLE_STATUSES,
  PRIORITY_NAMES,
  PRIORITY_ORDER,
  STATUSES,
  assigneeOf,
  boardGroups,
  computerChoices,
  isPriorityName,
  isStatusName,
  labelColour,
  priorityOf,
  realChanges,
  shortDate,
  ticketActivity,
  visibleRows,
} from '../shared/ticketBoard';
import {
  linkOf,
  openGroupKeysByProject,
  sourceLabel,
  talkToSend,
  ticketKey,
  ticketsRefreshDue,
} from '../shared/ticketList';
import type { AppState } from '../shared/types';
import { BlockerCard, blockerAnswer } from './BlockerCard';
import { Markdown } from './Message';
import { ProjectIcon, StarButton, ViewIcon } from './ProjectIcon';
import {
  ComputerIcon,
  LineIcon,
  PriorityIcon,
  ProgressRing,
  StatusIcon,
} from './TicketIcons';
import { MenuButton, type MenuOption, TicketMenu } from './TicketMenu';
import { ProjectPanel, ViewDialog, ViewPanel } from './ViewPanels';
import { api } from './api';
import { errorText, latestLoader } from './loading';
import type { Workspace } from './useWorkspace';

/**
 * The Tickets screen, laid out as Linear's: a dense list grouped by status
 * (or project, epic or computer), filters as chips, a ticket's own page with
 * its properties on the right, and New ticket as a dialog. Every change goes
 * to the project's ticket source through the computer holding it; Building
 * and Shipped stay the build's to set.
 */

export interface OpenTicket {
  projectId: string;
  ticketId: string;
}

const allTickets = (data: TicketsResponse): TicketListItem[] =>
  data.projects.flatMap((project) =>
    'tickets' in project ? project.tickets : []
  );

/** The editor is big: it loads with the first ticket page, not the list. */
const DescriptionEditor = lazy(() =>
  import('./DescriptionEditor').then((module) => ({
    default: module.DescriptionEditor,
  }))
);

/** A typed key goes to the box it's typed in, never to a shortcut. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

// ── the view, kept per browser ──────────────────────────────────────────────

const VIEW_KEY = 'lambda:tickets-view';

interface ViewSettings {
  groupBy: Grouping;
  chips: FilterChip[];
  /** Folded groups, by key. */
  folded: string[];
}

const isGrouping = (value: unknown): value is Grouping =>
  GROUPINGS.some((grouping) => grouping === value);

const isField = (value: unknown): value is FilterField =>
  FILTER_FIELDS.some((field) => field === value);

const loadView = (): ViewSettings => {
  const fallback: ViewSettings = { groupBy: 'status', chips: [], folded: [] };

  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(VIEW_KEY) ?? 'null'
    );

    if (typeof saved !== 'object' || saved === null) {
      return fallback;
    }

    const groupBy = 'groupBy' in saved ? saved.groupBy : undefined;
    const chips = 'chips' in saved ? saved.chips : undefined;
    const folded = 'folded' in saved ? saved.folded : undefined;

    return {
      groupBy: isGrouping(groupBy) ? groupBy : 'status',
      chips: Array.isArray(chips)
        ? chips.flatMap((chip: unknown) =>
            typeof chip === 'object' &&
            chip !== null &&
            'field' in chip &&
            'value' in chip &&
            isField(chip.field) &&
            typeof chip.value === 'string'
              ? [{ field: chip.field, value: chip.value }]
              : []
          )
        : [],
      folded: Array.isArray(folded)
        ? folded.filter((key): key is string => typeof key === 'string')
        : [],
    };
  } catch {
    return fallback;
  }
};

const PANEL_KEY = 'lambda:tickets-panel';

/** A view's or project's panel: open unless they've closed it. */
const loadPanelOpen = (): boolean => {
  try {
    return window.localStorage.getItem(PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
};

const storePanelOpen = (open: boolean): void => {
  try {
    window.localStorage.setItem(PANEL_KEY, open ? 'open' : 'closed');
  } catch {
    // Private mode: it opens again next time.
  }
};

const saveView = (view: ViewSettings): void => {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Private mode or full: the view resets on the next load.
  }
};

// ── shared bits ─────────────────────────────────────────────────────────────

interface Lookups {
  items: TicketListItem[];
  projectName: (projectId: string) => string;
  /** The computers a ticket in this project can be assigned to. */
  computersFor: (projectId: string) => ComputerChoice[];
  /** You: a ticket can be yours to do by hand, and no computer builds it. */
  owner: { name: string; initials: string };
  /** A codebase's tracker projects (Linear's), for the Project property. */
  projectsOf: (codebaseId: string) => TrackerProject[];
}

/** Who a ticket is assigned to: your initials, a laptop, or a dashed one. */
const AssigneeIcon = ({
  assignee,
  owner,
}: {
  assignee: string | null;
  owner: Lookups['owner'];
}) =>
  assignee === owner.name ? (
    <span className="tk-avatar" aria-hidden="true">
      {owner.initials}
    </span>
  ) : (
    <ComputerIcon assigned={assignee !== null} />
  );

const titleOf = (
  items: TicketListItem[],
  projectId: string,
  id: string
): string =>
  items.find((item) => item.projectId === projectId && item.id === id)?.title ??
  id;

/** The menus' options. */
const statusOptions = (): MenuOption[] =>
  PICKABLE_STATUSES.map((status) => ({
    value: status,
    label: STATUSES[status].name,
    icon: <StatusIcon status={status} label={false} />,
  }));

const priorityOptions = (): MenuOption[] =>
  PRIORITY_ORDER.map((priority) => ({
    value: priority,
    label: PRIORITY_NAMES[priority],
    icon: <PriorityIcon priority={priority} label={false} />,
  }));

const UNASSIGNED = '';

/** "Building", or "Building · In review" when the tracker calls it more. */
const statusName = (
  item: Pick<TicketListItem, 'status' | 'trackerStatus'>
): string =>
  (item.trackerStatus ?? null) === null
    ? STATUSES[item.status].name
    : `${STATUSES[item.status].name} · ${item.trackerStatus ?? ''}`;

/** Who a message of a ticket's conversation is from: whichever agent, Lambda. */
const TALKERS: Record<'you' | 'product-manager' | 'dev', string> = {
  you: 'You',
  'product-manager': 'Lambda',
  dev: 'Lambda',
};

/** A Lambda's phase in a word, for the ticket's Lambda property. */
const PHASE_WORDS: Record<Lambda['phase'], string> = {
  planning: 'planning',
  queued: 'ready',
  building: 'building',
  qa: 'in review',
  shipped: 'merged',
  done: 'done',
};

/** "Add it to the ticket": a reply kept under the description's Notes. */
const withNote = (description: string, note: string): string => {
  const body = description.trimEnd();

  return /^## Notes$/m.test(body)
    ? `${body}\n\n${note.trim()}`
    : `${body}${body === '' ? '' : '\n\n'}## Notes\n\n${note.trim()}`;
};

const assigneeOptions = (
  known: ComputerChoice[],
  owner: Lookups['owner'],
  current: string | null = null,
  /** The ticket's tracker: a computer that hasn't connected it says so. */
  tracker: string | null = null
): MenuOption[] => {
  // Assigned to a computer this Lambda doesn't know (another Lambda's, or
  // one gone): still listed, so the tick shows where it is.
  const computers =
    current === null ||
    current === owner.name ||
    known.some((computer) => computer.name === current)
      ? known
      : [...known, { name: current, state: 'unknown', hasProject: false }];

  return assigneeOptionsOf(computers, owner, tracker);
};

const TRACKER_NAMES: Record<string, string> = {
  linear: 'Linear',
  jira: 'Jira',
};

const assigneeOptionsOf = (
  computers: ComputerChoice[],
  owner: Lookups['owner'],
  tracker: string | null = null
): MenuOption[] => [
  {
    value: UNASSIGNED,
    label: 'Unassigned',
    hint: 'Any computer can take it',
    icon: <ComputerIcon assigned={false} />,
  },
  {
    value: owner.name,
    label: owner.name,
    hint: 'Yours, by hand: no computer builds it',
    icon: (
      <span className="tk-avatar" aria-hidden="true">
        {owner.initials}
      </span>
    ),
  },
  ...computers.map((computer) => ({
    value: computer.name,
    label: computer.name,
    // Lambda knows who it is in every tracker it has connected; one that
    // hasn't connected this ticket's can only be assigned by lambda.json.
    ...(tracker !== null &&
    TRACKER_NAMES[tracker] !== undefined &&
    computer.trackers !== undefined &&
    !computer.trackers.includes(tracker)
      ? { hint: `Connect ${TRACKER_NAMES[tracker] ?? ''} on it to assign it` }
      : {}),
    ...(computer.state === 'unknown' ? {} : { trail: computer.state }),
    icon: (
      <span
        className={`state-dot state-dot--${computer.state}`}
        aria-hidden="true"
      />
    ),
  })),
];

/** Epics a ticket can sit under: the project's top-level tickets. */
const epicOptions = (
  items: TicketListItem[],
  projectId: string,
  except: string | null
): MenuOption[] => [
  { value: UNASSIGNED, label: 'No epic' },
  ...items
    .filter(
      (item) =>
        item.projectId === projectId &&
        item.parent === null &&
        item.id !== except &&
        item.source !== 'pod'
    )
    .map((item) => ({
      value: item.id,
      label: item.title,
      hint: item.id,
      icon: <StatusIcon status={item.status} label={false} />,
    })),
];

const labelsOf = (items: TicketListItem[], projectId: string): string[] =>
  [
    ...new Set(
      items
        .filter((item) => item.projectId === projectId)
        .flatMap((item) => item.labels)
    ),
  ].sort();

/** A tracker project, by name, from the codebase it's in (or any). */
const trackerProjectNamed = (
  lookups: Lookups,
  codebaseIds: string[],
  name: string
): TrackerProject | undefined =>
  codebaseIds
    .flatMap((codebaseId) => lookups.projectsOf(codebaseId))
    .find((project) => project.name === name);

/** The Project choices: the trackers' projects, and any a ticket names. */
const projectOptions = (
  lookups: Lookups,
  codebaseIds: string[],
  withNone: boolean
): MenuOption[] => {
  const tracked = codebaseIds.flatMap((codebaseId) =>
    lookups.projectsOf(codebaseId)
  );
  const names = [
    ...new Set([
      ...tracked.map((project) => project.name),
      ...lookups.items
        .filter((item) => codebaseIds.includes(item.projectId))
        .flatMap((item) =>
          (item.project ?? '') === '' ? [] : [item.project ?? '']
        ),
    ]),
  ];

  return [
    ...(withNone
      ? [
          {
            value: UNASSIGNED,
            label: 'No project',
            icon: <ProjectIcon icon={null} color="var(--grey-500)" />,
          },
        ]
      : []),
    ...names.map((name) => {
      const project = tracked.find((one) => one.name === name);

      return {
        value: name,
        label: name,
        icon: <ProjectIcon icon={project?.icon} color={project?.color} />,
      };
    }),
  ];
};

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="tk-chip">{children}</span>
);

// ── Filter and Display ──────────────────────────────────────────────────────

const valueOptions = (
  field: FilterField,
  lookups: Lookups,
  projects: Array<{ projectId: string; name: string }>
): MenuOption[] => {
  const { items } = lookups;

  switch (field) {
    case 'status':
      return ALL_STATUSES.map((status) => ({
        value: status,
        label: STATUSES[status].name,
        icon: <StatusIcon status={status} label={false} />,
      }));
    case 'priority':
      return priorityOptions();
    case 'assignee':
      return assigneeOptions(
        [
          ...new Map(
            projects
              .flatMap((project) => lookups.computersFor(project.projectId))
              .map((computer) => [computer.name, computer])
          ).values(),
        ].sort((a, b) => a.name.localeCompare(b.name)),
        lookups.owner
      );
    case 'codebase':
      return projects.map((project) => ({
        value: project.projectId,
        label: project.name,
      }));
    case 'project':
      return projectOptions(
        lookups,
        projects.map((project) => project.projectId),
        true
      );
    case 'epic':
      return items
        .filter((item) => items.some((other) => other.parent === item.id))
        .map((item) => ({ value: item.id, label: item.title, hint: item.id }));
    default:
      return [...new Set(items.flatMap((item) => item.labels))]
        .sort()
        .map((label) => ({ value: label, label }));
  }
};

const chipText = (chip: FilterChip, lookups: Lookups): string => {
  switch (chip.field) {
    case 'status':
      return isStatusName(chip.value) ? STATUSES[chip.value].name : chip.value;
    case 'priority':
      return isPriorityName(chip.value)
        ? PRIORITY_NAMES[chip.value]
        : chip.value;
    case 'assignee':
      return chip.value === UNASSIGNED ? 'Unassigned' : chip.value;
    case 'codebase':
      return lookups.projectName(chip.value);
    case 'project':
      return chip.value === '' ? 'No project' : chip.value;
    case 'epic':
      return (
        lookups.items.find((item) => item.id === chip.value)?.title ??
        chip.value
      );
    default:
      return chip.value;
  }
};

const FilterMenu = ({
  lookups,
  projects,
  chips,
  onAdd,
  onClose,
}: {
  lookups: Lookups;
  projects: Array<{ projectId: string; name: string }>;
  chips: FilterChip[];
  onAdd: (chip: FilterChip) => void;
  onClose: () => void;
}) => {
  const [field, setField] = useState<FilterField | null>(null);

  if (field === null) {
    return (
      <TicketMenu
        label="Filter"
        placeholder="Filter…"
        options={FILTER_FIELDS.map((one) => ({
          value: one,
          label: FILTER_NAMES[one],
        }))}
        selected={[]}
        onPick={(value) => setField(isField(value) ? value : null)}
        onClose={onClose}
      />
    );
  }

  return (
    <TicketMenu
      label={FILTER_NAMES[field]}
      placeholder={`${FILTER_NAMES[field]}…`}
      options={valueOptions(field, lookups, projects)}
      selected={chips
        .filter((chip) => chip.field === field)
        .map((chip) => chip.value)}
      onPick={(value) => {
        onAdd({ field, value });
        onClose();
      }}
      onClose={onClose}
    />
  );
};

// ── the list ────────────────────────────────────────────────────────────────

const Row = ({
  row,
  lookups,
  at,
  dropping,
  draggable,
  showProject,
  now,
  onOpen,
  onFocus,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  row: BoardRow;
  lookups: Lookups;
  at: boolean;
  dropping: boolean;
  draggable: boolean;
  /** Its project's chip: not on that project's own page. */
  showProject: boolean;
  now: number;
  onOpen: () => void;
  onFocus: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}) => {
  const { item, depth, progress } = row;
  const assignee = assigneeOf(item);
  const trackerProject =
    item.project === undefined || item.project === null
      ? undefined
      : trackerProjectNamed(lookups, [item.projectId], item.project);
  const epic =
    item.parent === null || depth === 1
      ? null
      : titleOf(lookups.items, item.projectId, item.parent);

  return (
    <button
      type="button"
      className={`tk-row${at ? ' tk-row--at' : ''}${
        depth === 1 ? ' tk-row--child' : ''
      }${dropping ? ' tk-row--drop' : ''}`}
      data-ticket={ticketKey(item.projectId, item.id)}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onFocus={onFocus}
      onClick={onOpen}
    >
      <span className="tk-row__priority">
        <PriorityIcon priority={priorityOf(item)} />
      </span>
      <span className="tk-row__id">{item.id}</span>
      <span className="tk-row__status" title={statusName(item)}>
        <StatusIcon status={item.status} />
      </span>
      <span className="tk-row__title">
        <span className="tk-row__text">{item.title}</span>
        {(item.trackerStatus ?? null) !== null && (
          <span
            className="tk-chip tk-chip--state"
            title={`${
              item.trackerStatus ?? ''
            } in the tracker: Lambda reads it as ${STATUSES[item.status].name}`}
          >
            {item.trackerStatus}
          </span>
        )}
        {item.status === 'blocked' && (item.blockReason ?? '') !== '' && (
          <span className="tk-row__reason"> · {item.blockReason}</span>
        )}
        {progress !== null && (
          <span className="tk-chip tk-chip--progress">
            <ProgressRing done={progress.done} total={progress.total} />
            {progress.done}/{progress.total}
          </span>
        )}
      </span>
      {epic !== null && (
        <span className="tk-chip tk-chip--epic" title={epic}>
          {epic}
        </span>
      )}
      {showProject && (item.project ?? '') !== '' && (
        <span className="tk-chip tk-chip--project" title={item.project ?? ''}>
          <ProjectIcon
            icon={trackerProject?.icon}
            color={trackerProject?.color}
            size={12}
          />
          <span className="tk-chip__text">{item.project}</span>
        </span>
      )}
      {item.labels.map((label) => (
        <span key={label} className="tk-chip tk-chip--label">
          <span
            className="tk-chip__dot"
            style={{ background: labelColour(label) }}
            aria-hidden="true"
          />
          {label}
        </span>
      ))}
      {item.status === 'done' && (item.commit ?? null) !== null && (
        <span className="tk-row__commit">{item.commit}</span>
      )}
      <span
        className={`tk-row__assignee${
          assignee === null ? ' tk-row__assignee--none' : ''
        }`}
        title={assignee ?? 'Unassigned'}
      >
        <AssigneeIcon assignee={assignee} owner={lookups.owner} />
        <span>{assignee ?? 'Unassigned'}</span>
      </span>
      <span className="tk-row__date">
        {(item.updatedAt ?? null) === null
          ? ''
          : shortDate(item.updatedAt ?? 0, now)}
      </span>
    </button>
  );
};

const ListView = ({
  data,
  lookups,
  view,
  onView,
  search,
  onSearch,
  onOpen,
  onNew,
  onMove,
  title,
  titleEnd,
  headEnd,
  fixedChips,
  saveBar,
  aside,
  showProject,
}: {
  data: TicketsResponse;
  lookups: Lookups;
  view: ViewSettings;
  onView: (view: ViewSettings) => void;
  search: string;
  onSearch: (search: string) => void;
  onOpen: (ticket: OpenTicket) => void;
  onNew: (status?: TicketState) => void;
  onMove: (item: TicketListItem, after: TicketListItem) => void;
  /** The header's left: "Tickets", or a view's or project's breadcrumb. */
  title: ReactNode;
  /** After the count: a view's or project's star. */
  titleEnd: ReactNode;
  /** After Display: the panel's toggle. */
  headEnd: ReactNode;
  /** A project page's own filter: applied, never shown as a chip. */
  fixedChips: FilterChip[];
  /** Save / Update view, at the end of the filters row. */
  saveBar: ReactNode;
  /** A view's or project's panel on the right. */
  aside: ReactNode;
  showProject: boolean;
}) => {
  const [at, setAt] = useState(0);
  const [dragging, setDragging] = useState<TicketListItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const projects = data.projects.map((project) => ({
    projectId: project.projectId,
    name: project.name,
  }));
  const groups = boardGroups(lookups.items, {
    groupBy: view.groupBy,
    chips: [...fixedChips, ...view.chips],
    search,
    shippingTogether: openGroupKeysByProject(data.groupEvents),
    projectName: lookups.projectName,
  });
  const folded = new Set(view.folded);
  const rows = visibleRows(groups, folded);
  const count = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const offline = data.projects.flatMap((project) =>
    'offline' in project ? [project] : []
  );
  // Order is queue order, so only the status view, unsearched, reorders.
  const reorderable = view.groupBy === 'status' && search === '';

  // j / k move, Enter opens, / searches, c makes a ticket.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (typing(event.target) || event.metaKey || event.ctrlKey) {
        return;
      }

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setAt((now) => Math.min(now + 1, rows.length - 1));
      }

      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setAt((now) => Math.max(now - 1, 0));
      }

      if (event.key === 'Enter') {
        const row = rows[at];

        if (row !== undefined) {
          event.preventDefault();
          onOpen({ projectId: row.item.projectId, ticketId: row.item.id });
        }
      }

      if (event.key === '/') {
        event.preventDefault();
        searchBox.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [at, rows, onOpen]);

  // The row j and k reach stays in view.
  useEffect(() => {
    const row = rows[at];

    if (row === undefined) {
      return;
    }

    list.current
      ?.querySelector(
        `[data-ticket="${CSS.escape(
          ticketKey(row.item.projectId, row.item.id)
        )}"]`
      )
      ?.scrollIntoView({ block: 'nearest' });
  }, [at, rows]);

  const rowIndex = (item: TicketListItem): number =>
    rows.findIndex(
      (row) => row.item.projectId === item.projectId && row.item.id === item.id
    );

  return (
    <div
      className={`tickets-wrap${aside === null ? '' : ' tickets-wrap--aside'}`}
    >
      <section className="tickets">
        <header className="tickets__head">
          <h1 className="tickets__title">
            {title} <span className="tickets__count">{count}</span>
            {titleEnd}
          </h1>
          <MenuButton
            className="tk-button"
            label="Filter"
            menu={(close) => (
              <FilterMenu
                lookups={lookups}
                projects={projects}
                chips={view.chips}
                onAdd={(chip) =>
                  onView({
                    ...view,
                    chips: view.chips.some(
                      (one) =>
                        one.field === chip.field && one.value === chip.value
                    )
                      ? view.chips
                      : [...view.chips, chip],
                  })
                }
                onClose={close}
              />
            )}
          >
            <LineIcon name="filter" />
            Filter
          </MenuButton>
          <MenuButton
            className="tk-button"
            label="Display"
            menu={(close) => (
              <TicketMenu
                label="Group by"
                placeholder="Group by…"
                align="right"
                options={GROUPINGS.map((grouping) => ({
                  value: grouping,
                  label: `Group by ${GROUPING_NAMES[grouping].toLowerCase()}`,
                }))}
                selected={[view.groupBy]}
                onPick={(value) => {
                  onView({
                    ...view,
                    groupBy: isGrouping(value) ? value : 'status',
                  });
                  close();
                }}
                onClose={close}
              />
            )}
          >
            <LineIcon name="display" />
            Display
          </MenuButton>
          {headEnd}
          <button
            type="button"
            className="tk-button tk-button--primary"
            title="New ticket (C)"
            onClick={() => onNew()}
          >
            <LineIcon name="plus" />
            New ticket
          </button>
        </header>

        <div className="tickets__filters">
          {view.chips.map((chip) => (
            <span
              key={`${chip.field}:${chip.value}`}
              className="tk-filter-chip"
            >
              <span className="tk-filter-chip__field">
                {FILTER_NAMES[chip.field]}
              </span>{' '}
              is <strong>{chipText(chip, lookups)}</strong>
              <button
                type="button"
                aria-label={`Remove the ${FILTER_NAMES[
                  chip.field
                ].toLowerCase()} filter`}
                onClick={() =>
                  onView({
                    ...view,
                    chips: view.chips.filter((one) => one !== chip),
                  })
                }
              >
                <LineIcon name="close" size={12} />
              </button>
            </span>
          ))}
          <MenuButton
            className="tk-add-filter"
            label="Add filter"
            menu={(close) => (
              <FilterMenu
                lookups={lookups}
                projects={projects}
                chips={view.chips}
                onAdd={(chip) =>
                  onView({ ...view, chips: [...view.chips, chip] })
                }
                onClose={close}
              />
            )}
          >
            + Add filter
          </MenuButton>
          <label className="tickets__search">
            <LineIcon name="search" size={13} />
            <input
              ref={searchBox}
              type="search"
              placeholder="Search"
              aria-label="Search tickets"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  onSearch('');
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          {saveBar}
        </div>

        {offline.map((project) => (
          <p key={project.projectId} className="tickets__offline muted">
            {project.name}: {project.offline}
          </p>
        ))}

        <div className="tickets__list" ref={list}>
          {groups.length === 0 && (
            <p className="tickets__empty muted">
              {lookups.items.length === 0
                ? 'No tickets yet. Make one with New ticket.'
                : 'No tickets match.'}
            </p>
          )}
          {groups.map((group) => {
            const isFolded = folded.has(group.key);

            return (
              <div key={group.key} className="tk-group">
                <div className="tk-group__head">
                  <button
                    type="button"
                    className="tk-group__toggle"
                    aria-expanded={!isFolded}
                    onClick={() =>
                      onView({
                        ...view,
                        folded: isFolded
                          ? view.folded.filter((key) => key !== group.key)
                          : [...view.folded, group.key],
                      })
                    }
                  >
                    <svg
                      className={`tk-group__chevron${
                        isFolded ? ' tk-group__chevron--folded' : ''
                      }`}
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M5 8h14l-7 9z" />
                    </svg>
                    {group.status !== null && (
                      <StatusIcon status={group.status} label={false} />
                    )}
                    <span className="tk-group__name">{group.label}</span>
                    <span className="tk-group__count">{group.rows.length}</span>
                  </button>
                  {group.status !== null &&
                    !STATUSES[group.status].setByBuild && (
                      <button
                        type="button"
                        className="tk-group__add"
                        aria-label={`New ${STATUSES[
                          group.status
                        ].name.toLowerCase()} ticket`}
                        onClick={() => onNew(group.status ?? undefined)}
                      >
                        <LineIcon name="plus" />
                      </button>
                    )}
                </div>
                {!isFolded &&
                  group.rows.map((row) => (
                    <Row
                      key={ticketKey(row.item.projectId, row.item.id)}
                      row={row}
                      lookups={lookups}
                      at={rows[at] === row}
                      now={now}
                      draggable={reorderable && row.item.source !== 'pod'}
                      showProject={showProject}
                      dropping={
                        dragging !== null &&
                        over === ticketKey(row.item.projectId, row.item.id)
                      }
                      onOpen={() =>
                        onOpen({
                          projectId: row.item.projectId,
                          ticketId: row.item.id,
                        })
                      }
                      onFocus={() => setAt(rowIndex(row.item))}
                      onDragStart={() => setDragging(row.item)}
                      onDragOver={() =>
                        setOver(ticketKey(row.item.projectId, row.item.id))
                      }
                      onDrop={() => {
                        if (dragging !== null && dragging !== row.item) {
                          onMove(dragging, row.item);
                        }

                        setDragging(null);
                        setOver(null);
                      }}
                    />
                  ))}
              </div>
            );
          })}
        </div>

        <p className="tickets__keys">
          <kbd>j</kbd> <kbd>k</kbd> move · <kbd>↵</kbd> open · <kbd>/</kbd>{' '}
          search · <kbd>c</kbd> new ticket
        </p>
      </section>
      {aside}
    </div>
  );
};

// ── a ticket's page ─────────────────────────────────────────────────────────

const PropertyRow = ({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) => (
  <div className="tk-prop">
    <span className="tk-prop__heading">{heading}</span>
    <div className="tk-prop__value">{children}</div>
  </div>
);

const TicketView = ({
  open,
  lookups,
  order,
  tick,
  buildingOn,
  onBack,
  onOpen,
  onOpenPod,
  onChange,
  lambda,
  onChat,
  onPlan,
  starred,
  onStar,
  backLabel,
}: {
  open: OpenTicket;
  lookups: Lookups;
  /** The list's tickets in order, for previous and next. */
  order: OpenTicket[];
  tick: number;
  /** The computer building a ticket now, if any. */
  buildingOn: (projectId: string, ticketId: string) => string | null;
  onBack: () => void;
  onOpen: (ticket: OpenTicket) => void;
  onOpenPod: (podId: string) => void;
  onChange: (item: TicketListItem, changes: TicketChanges) => Promise<void>;
  /** The Lambda it's part of, if any. */
  lambda: Lambda | undefined;
  /** "Chat with Lambda": its Lambda, or a new planning chat about it. */
  onChat: () => void;
  /** "Plan with Lambda" under a reply. */
  onPlan: () => void;
  /** It's in the sidebar's Favorites. */
  starred: boolean;
  onStar: () => void;
  /** Where Back goes: "Tickets", or the view or project it was opened from. */
  backLabel: string;
}) => {
  const [page, setPage] = useState<TicketPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  // A build blocked on the owner: its question, from its computer's pod.
  const [blockDetail, setBlockDetail] = useState<BuildingPodDetail | null>(
    null
  );
  const [choice, setChoice] = useState<number | null>(null);
  const [words, setWords] = useState('');
  const route = askRouteOf(lambda, open.ticketId);
  const blockPod = route.to === 'block' ? route.podId : null;
  const blockMessage = route.to === 'block' ? route.messageId : null;

  useEffect(() => {
    if (blockPod === null) {
      setBlockDetail(null);

      return;
    }

    api
      .building(blockPod)
      .then(setBlockDetail)
      .catch(() => setBlockDetail(null));
  }, [blockPod, tick]);
  const load = useMemo(
    () => latestLoader<TicketPage>({ value: setPage, error: setError }),
    []
  );
  const key = `${open.projectId}\u0000${open.ticketId}`;
  const loadedFor = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const opening = loadedFor.current?.key !== key;
    const now = Date.now();

    if (!opening && !ticketsRefreshDue(loadedFor.current?.at ?? null, now)) {
      return;
    }

    if (opening) {
      setPage(null);
    }

    void load(api.ticketPage(open.projectId, open.ticketId, opening));
    loadedFor.current = { key, at: now };
  }, [load, key, open.projectId, open.ticketId, tick]);

  const reread = useCallback(() => {
    loadedFor.current = { key, at: Date.now() };
    void load(api.ticketPage(open.projectId, open.ticketId));
  }, [load, key, open.projectId, open.ticketId]);

  useEffect(() => setTitle(page?.ticket.title ?? ''), [page?.ticket.title]);

  const index = order.findIndex(
    (one) => one.projectId === open.projectId && one.ticketId === open.ticketId
  );
  const step = (by: number): void => {
    const next = order[index + by];

    if (next !== undefined) {
      onOpen(next);
    }
  };

  // Esc goes back; j and k step through the list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (typing(event.target) || event.metaKey || event.ctrlKey) {
        return;
      }

      if (event.key === 'Escape') {
        onBack();
      }

      if (event.key === 'j') {
        step(1);
      }

      if (event.key === 'k') {
        step(-1);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  });

  const item: TicketListItem | null =
    lookups.items.find(
      (one) => one.projectId === open.projectId && one.id === open.ticketId
    ) ?? (page === null ? null : page.ticket);
  const editable =
    item !== null && item.source !== 'pod' && item.readOnly !== true;
  const change = (changes: TicketChanges): void => {
    if (item === null) {
      return;
    }

    const real = realChanges(item, page?.ticket.description ?? null, changes);

    if (real === null) {
      return;
    }

    setActionError(null);
    onChange(item, real)
      .then(reread)
      .catch((caught: unknown) => setActionError(errorText(caught)));
  };
  const computer =
    item?.status === 'building'
      ? buildingOn(open.projectId, open.ticketId) ?? assigneeOf(item)
      : null;
  // Edits and the build as lines; the conversation as comments, by time.
  const activity: Array<
    | { kind: 'line'; at: number; who: string; text: string }
    | { kind: 'comment'; at: number; who: string; text: string; podId: string }
  > =
    page === null
      ? []
      : [
          ...ticketActivity(page.events, stepDisplayName, formatMinutes).map(
            (entry) => ({ kind: 'line' as const, ...entry })
          ),
          ...(page.talk ?? []).map((message) => ({
            kind: 'comment' as const,
            at: Date.parse(message.at),
            who: TALKERS[message.from],
            text: message.text,
            podId: message.podId,
          })),
        ].sort((a, b) => a.at - b.at);
  const now = Date.now();
  const epic =
    item === null || item.parent === null
      ? null
      : lookups.items.find(
          (one) => one.projectId === item.projectId && one.id === item.parent
        ) ?? null;
  const epicChildren =
    epic === null
      ? []
      : lookups.items.filter(
          (one) =>
            one.projectId === epic.projectId &&
            one.parent === epic.id &&
            one.status !== 'canceled'
        );
  const link = linkOf(item?.url ?? null);
  const tracker = item === null ? null : sourceLabel(item.source);
  const labels = item === null ? [] : labelsOf(lookups.items, item.projectId);
  const itemProject =
    item === null || (item.project ?? '') === ''
      ? undefined
      : trackerProjectNamed(lookups, [item.projectId], item.project ?? '');

  const talk = (): void => {
    const said = talkToSend(comment, sending);

    if (said === null) {
      return;
    }

    setSending(true);
    setActionError(null);
    // While it's blocked, words in the box answer the block.
    (blockPod !== null && blockMessage !== null
      ? api.chat(blockPod, said, blockMessage)
      : api.talkTicket(open.projectId, open.ticketId, said)
    )
      .then(() => {
        setComment('');
        reread();
      })
      .catch((caught: unknown) => setActionError(errorText(caught)))
      .finally(() => setSending(false));
  };

  const blocker = blockDetail?.building.runs.find(
    (run) => run.blocked?.messageId === blockMessage
  )?.blocked;
  const where = lambda?.tickets.find((one) => one.id === open.ticketId)?.where;
  const blockedOn = where?.kind === 'blocked' ? where.computer : null;
  const answerBlock = (): void => {
    const text = blockerAnswer(blocker, choice, words);

    if (text === '' || blockPod === null || blockMessage === null) {
      return;
    }

    setSending(true);
    setActionError(null);
    api
      .chat(blockPod, text, blockMessage)
      .then(() => {
        setWords('');
        setChoice(null);
        reread();
      })
      .catch((caught: unknown) => setActionError(errorText(caught)))
      .finally(() => setSending(false));
  };
  const last = activity.at(-1);
  const lastReply =
    last?.kind === 'comment' && last.who !== TALKERS.you ? last : null;
  const lastAsked =
    last?.kind === 'comment' && last.who === TALKERS.you ? last : null;

  return (
    <section className="ticket">
      <header className="ticket__head">
        <nav className="ticket__crumbs" aria-label="Breadcrumb">
          <button type="button" className="ticket__crumb" onClick={onBack}>
            {backLabel}
          </button>
          <span aria-hidden="true">›</span>
          {epic !== null && (
            <>
              <button
                type="button"
                className="ticket__crumb"
                onClick={() =>
                  onOpen({ projectId: epic.projectId, ticketId: epic.id })
                }
              >
                {epic.title}
              </button>
              <span aria-hidden="true">›</span>
            </>
          )}
          <span className="ticket__crumb ticket__crumb--here">
            {open.ticketId} {item?.title ?? ''}
          </span>
          <StarButton on={starred} onToggle={onStar} what="ticket" />
        </nav>
        {item?.readOnly !== true && (
          <button type="button" className="tk-chat-button" onClick={onChat}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
            </svg>
            Chat with Lambda
          </button>
        )}
        {index !== -1 && (
          <span className="ticket__position">
            {index + 1} / {order.length}
          </span>
        )}
        <button
          type="button"
          className="tk-icon-button"
          aria-label="Next ticket (J)"
          title="Next ticket (J)"
          disabled={index === -1 || index >= order.length - 1}
          onClick={() => step(1)}
        >
          <LineIcon name="down" />
        </button>
        <button
          type="button"
          className="tk-icon-button"
          aria-label="Previous ticket (K)"
          title="Previous ticket (K)"
          disabled={index <= 0}
          onClick={() => step(-1)}
        >
          <LineIcon name="up" />
        </button>
        <button
          type="button"
          className="tk-icon-button"
          aria-label={copied ? 'Link copied' : 'Copy link'}
          title={copied ? 'Copied' : 'Copy link'}
          onClick={() => {
            navigator.clipboard
              .writeText(window.location.href)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          <LineIcon name={copied ? 'check' : 'link'} />
        </button>
      </header>

      {error !== null && <p className="error">{error}</p>}
      {actionError !== null && (
        <button
          type="button"
          className="error"
          onClick={() => setActionError(null)}
        >
          {actionError} (dismiss)
        </button>
      )}

      {item === null ? (
        error === null && <p className="muted ticket__loading">Loading…</p>
      ) : (
        <div className="ticket__body">
          <article className="ticket__main">
            {route.to === 'block' ? (
              <div
                className="ticket__notice ticket__notice--blocked"
                role="status"
              >
                <span className="ticket__notice-dot" aria-hidden="true" />
                <span>
                  Blocked: {blockedOn ?? 'the build'} is waiting on you. Answer
                  below.
                </span>
              </div>
            ) : lambda?.phase === 'planning' ? (
              <div
                className="ticket__notice ticket__notice--planning"
                role="status"
              >
                <StatusIcon status="planning" label={false} />
                <span className="ticket__notice-text">
                  Being planned in <strong>{lambda.title}</strong>.
                </span>
                {lambda.planningPodId !== null && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      lambda.planningPodId !== null &&
                      onOpenPod(lambda.planningPodId)
                    }
                  >
                    Open the planning chat
                  </button>
                )}
              </div>
            ) : (
              computer !== null && (
                <div className="ticket__notice" role="status">
                  <StatusIcon status="building" label={false} />
                  <span>
                    Being built on {computer}. Changes you make reach it at its
                    next check.
                  </span>
                </div>
              )
            )}
            {editable ? (
              <input
                className="ticket__title"
                aria-label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => {
                  if (title.trim() !== '' && title.trim() !== item.title) {
                    change({ title: title.trim() });
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }

                  if (event.key === 'Escape') {
                    setTitle(item.title);
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <h1 className="ticket__title">{item.title}</h1>
            )}
            {epic !== null && (
              <p className="ticket__parent">
                Sub-ticket of
                <StatusIcon status={epic.status} />
                <button
                  type="button"
                  className="ticket__parent-link"
                  onClick={() =>
                    onOpen({ projectId: epic.projectId, ticketId: epic.id })
                  }
                >
                  {epic.id} {epic.title}
                </button>
                <span className="tk-chip">
                  {epicChildren.filter((one) => one.status === 'done').length}/
                  {epicChildren.length}
                </span>
              </p>
            )}

            {page === null ? (
              <p className="muted ticket__description">Loading…</p>
            ) : (
              <Suspense
                fallback={
                  <div className="ticket__description">
                    <Markdown text={page.ticket.description} />
                  </div>
                }
              >
                <DescriptionEditor
                  // Another ticket is a new editor: never the last one's,
                  // which is destroyed as the new ticket's is made.
                  key={key}
                  ticketKey={key}
                  markdown={page.ticket.description}
                  editable={editable}
                  onSave={(description) => onChange(item, { description })}
                />
              </Suspense>
            )}

            <section className="ticket__activity" aria-label="Activity">
              <h2>Activity</h2>
              {activity.length === 0 && (
                <p className="muted ticket__quiet">Nothing yet.</p>
              )}
              {activity.map((entry) =>
                entry.kind === 'comment' ? (
                  <div
                    key={`${entry.at}:${entry.text}`}
                    className={`ticket__talk${
                      entry.who === TALKERS.you ? ' ticket__talk--you' : ''
                    }`}
                  >
                    <span className="ticket__talk-who">
                      {entry.who} · {agoShort(entry.at, now)}
                    </span>
                    <Markdown text={entry.text} />
                  </div>
                ) : (
                  <div
                    key={`${entry.at}:${entry.text}`}
                    className="ticket__event"
                  >
                    <span className="ticket__event-dot" aria-hidden="true" />
                    <span>
                      <strong>{entry.who}</strong> {entry.text} ·{' '}
                      <span className="muted">{agoShort(entry.at, now)}</span>
                    </span>
                  </div>
                )
              )}
              {lastAsked !== null && route.to === 'planning' && (
                <p className="muted ticket__queued">
                  In the planning chat&apos;s queue · read at its next turn
                </p>
              )}
              {lastReply !== null && route.to !== 'block' && (
                <div className="ticket__reply-actions">
                  {editable && page !== null && (
                    <button
                      type="button"
                      className="tk-button"
                      onClick={() =>
                        change({
                          description: withNote(
                            page.ticket.description,
                            lastReply.text
                          ),
                        })
                      }
                    >
                      Add it to the ticket
                    </button>
                  )}
                  <button type="button" className="tk-button" onClick={onPlan}>
                    Plan with Lambda
                  </button>
                </div>
              )}
              {route.to === 'block' && (
                <BlockerCard
                  blocker={blocker}
                  computer={blockedOn}
                  fallback={<p className="muted">Loading the question…</p>}
                  choice={choice}
                  words={words}
                  busy={sending}
                  onChoice={setChoice}
                  onWords={setWords}
                  onAnswer={answerBlock}
                  onPlanMore={onChat}
                />
              )}
              {item.readOnly === true ? (
                <p className="muted ticket__quiet">
                  Read-only here: this codebase mirrors its tracker, so nothing
                  is changed or started from this page.
                </p>
              ) : (
                <div className="ticket__comment">
                  <textarea
                    rows={2}
                    aria-label="Ask about this ticket"
                    placeholder={
                      route.to === 'block'
                        ? 'Answer in your own words, or ask something…'
                        : 'Ask about this ticket…'
                    }
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && event.metaKey) {
                        talk();
                      }
                    }}
                  />
                  <span className="ticket__comment-foot">
                    <span>
                      {route.to === 'block' ? (
                        'Goes to Lambda · while it’s blocked, this answers the block'
                      ) : route.to === 'planning' ? (
                        'Goes to the planning chat, at its next turn'
                      ) : (
                        <>
                          Goes to Lambda · for anything bigger,{' '}
                          <button
                            type="button"
                            className="link-button"
                            onClick={onChat}
                          >
                            Chat with Lambda
                          </button>
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      className="tk-button tk-button--primary"
                      disabled={sending || comment.trim() === ''}
                      onClick={talk}
                    >
                      Send
                    </button>
                  </span>
                </div>
              )}
            </section>
          </article>

          <aside className="ticket__props" aria-label="Properties">
            <h2 className="tk-props__title">Properties</h2>
            {STATUSES[item.status].setByBuild || !editable ? (
              <div className="tk-prop-line" title="Set by the build">
                <StatusIcon status={item.status} label={false} />
                <span className="tk-prop-line__text">{statusName(item)}</span>
                {STATUSES[item.status].setByBuild && (
                  <span
                    className="tk-prop-line__lock"
                    role="img"
                    aria-label="Set by the build"
                  >
                    <LineIcon name="lock" size={12} />
                  </span>
                )}
              </div>
            ) : (
              <MenuButton
                className="tk-prop-line"
                label={`Status: ${statusName(item)}`}
                menu={(close) => (
                  <TicketMenu
                    label="Status"
                    placeholder="Change status…"
                    options={statusOptions()}
                    selected={[item.status]}
                    onPick={(value) => {
                      close();

                      if (isStatusName(value)) {
                        change({ status: value });
                      }
                    }}
                    onClose={close}
                  />
                )}
              >
                <StatusIcon status={item.status} label={false} />
                <span className="tk-prop-line__text">{statusName(item)}</span>
              </MenuButton>
            )}

            <MenuButton
              className="tk-prop-line"
              label={`Priority: ${PRIORITY_NAMES[priorityOf(item)]}`}
              disabled={!editable}
              menu={(close) => (
                <TicketMenu
                  label="Priority"
                  placeholder="Set priority…"
                  options={priorityOptions()}
                  selected={[priorityOf(item)]}
                  onPick={(value) => {
                    close();

                    if (isPriorityName(value)) {
                      change({ priority: value });
                    }
                  }}
                  onClose={close}
                />
              )}
            >
              <PriorityIcon priority={priorityOf(item)} label={false} />
              <span className="tk-prop-line__text">
                {priorityOf(item) === 'none'
                  ? 'Set priority'
                  : PRIORITY_NAMES[priorityOf(item)]}
              </span>
            </MenuButton>

            <MenuButton
              className="tk-prop-line"
              label={`Assignee: ${assigneeOf(item) ?? 'Unassigned'}`}
              disabled={!editable}
              menu={(close) => (
                <TicketMenu
                  label="Assignee"
                  placeholder="Assign to…"
                  options={assigneeOptions(
                    lookups.computersFor(item.projectId),
                    lookups.owner,
                    assigneeOf(item),
                    item.source
                  )}
                  selected={[assigneeOf(item) ?? UNASSIGNED]}
                  onPick={(value) => {
                    close();
                    change({ assignee: value === UNASSIGNED ? null : value });
                  }}
                  onClose={close}
                />
              )}
            >
              <AssigneeIcon assignee={assigneeOf(item)} owner={lookups.owner} />
              <span className="tk-prop-line__text">
                {assigneeOf(item) ?? 'Unassigned'}
              </span>
            </MenuButton>

            <PropertyRow heading="Labels">
              <div className="tk-labels">
                {item.labels.map((label) => (
                  <span key={label} className="tk-chip tk-chip--label">
                    <span
                      className="tk-chip__dot"
                      style={{ background: labelColour(label) }}
                      aria-hidden="true"
                    />
                    {label}
                    {editable && (
                      <button
                        type="button"
                        className="tk-chip__remove"
                        aria-label={`Remove the ${label} label`}
                        onClick={() => change({ removeLabels: [label] })}
                      >
                        <LineIcon name="close" size={10} />
                      </button>
                    )}
                  </span>
                ))}
                {editable && (
                  <MenuButton
                    className="tk-chip tk-chip--add"
                    label="Add label"
                    menu={(close) => (
                      <TicketMenu
                        label="Labels"
                        placeholder="Add label…"
                        options={labels
                          .filter((label) => !item.labels.includes(label))
                          .map((label) => ({ value: label, label }))}
                        selected={[]}
                        onPick={(value) => {
                          close();
                          change({ labels: [value] });
                        }}
                        onCreate={(text) => {
                          close();
                          change({ labels: [text] });
                        }}
                        onClose={close}
                      />
                    )}
                  >
                    +
                  </MenuButton>
                )}
              </div>
            </PropertyRow>

            <PropertyRow heading="Project">
              <MenuButton
                className="tk-prop-line tk-prop-line--inline"
                label={`Project: ${item.project ?? 'No project'}`}
                disabled={!editable}
                menu={(close) => (
                  <TicketMenu
                    label="Project"
                    placeholder="Move to project…"
                    options={projectOptions(lookups, [item.projectId], true)}
                    selected={[item.project ?? UNASSIGNED]}
                    onPick={(value) => {
                      close();
                      change({ project: value === UNASSIGNED ? null : value });
                    }}
                    onClose={close}
                  />
                )}
              >
                {(item.project ?? '') !== '' && (
                  <ProjectIcon
                    icon={itemProject?.icon}
                    color={itemProject?.color}
                  />
                )}
                <span className="tk-prop-line__text">
                  {(item.project ?? '') === '' ? 'No project' : item.project}
                </span>
              </MenuButton>
            </PropertyRow>

            <PropertyRow heading="Lambda">
              {item.readOnly === true && lambda === undefined ? (
                <span className="muted">Not on this computer</span>
              ) : lambda === undefined ? (
                <span className="muted">
                  None yet. Chat with Lambda starts one.
                </span>
              ) : (
                <button
                  type="button"
                  className="tk-prop-line tk-prop-line--inline"
                  onClick={onChat}
                >
                  <span className="tk-prop-line__text">
                    {lambda.title}{' '}
                    <span
                      className={
                        route.to === 'block' ? 'ticket__blocked-word' : 'muted'
                      }
                    >
                      ·{' '}
                      {route.to === 'block'
                        ? 'blocked'
                        : PHASE_WORDS[lambda.phase]}
                    </span>
                  </span>
                </button>
              )}
            </PropertyRow>

            <PropertyRow heading="Codebase">
              {lookups.projectName(item.projectId)}
            </PropertyRow>

            <PropertyRow heading="Epic">
              <MenuButton
                className="tk-prop-line tk-prop-line--inline"
                label={`Epic: ${epic?.title ?? 'No epic'}`}
                disabled={!editable}
                menu={(close) => (
                  <TicketMenu
                    label="Epic"
                    placeholder="Move to epic…"
                    options={epicOptions(
                      lookups.items,
                      item.projectId,
                      item.id
                    )}
                    selected={[item.parent ?? UNASSIGNED]}
                    onPick={(value) => {
                      close();
                      change({ parent: value === UNASSIGNED ? null : value });
                    }}
                    onClose={close}
                  />
                )}
              >
                <span className="tk-prop-line__text">
                  {epic === null ? 'No epic' : epic.title}
                </span>
              </MenuButton>
            </PropertyRow>

            <PropertyRow heading="Source">
              <div className="tk-source">
                {link !== null && tracker !== null ? (
                  <a href={link} target="_blank" rel="noreferrer">
                    Open in {tracker} ↗
                  </a>
                ) : item.source === 'markdown' ? (
                  <code>tickets/{item.id}.md</code>
                ) : (
                  <span>Planned in a pod, not written yet</span>
                )}
                <span className="muted">
                  {item.status === 'done'
                    ? (item.commit ?? null) === null
                      ? 'Commit: not found'
                      : `Commit: ${item.commit ?? ''}`
                    : 'Commit: not shipped yet'}
                </span>
              </div>
            </PropertyRow>
          </aside>
        </div>
      )}
    </section>
  );
};

// ── New ticket ──────────────────────────────────────────────────────────────

const NewTicketDialog = ({
  projects,
  lookups,
  startProject,
  startTrackerProject,
  startStatus,
  onClose,
  onCreated,
  onPlan,
}: {
  projects: Array<{ projectId: string; name: string }>;
  lookups: Lookups;
  startProject: string;
  /** On a project's page: that project. */
  startTrackerProject: string | null;
  startStatus: TicketState;
  onClose: () => void;
  onCreated: (item: TicketListItem) => void;
  onPlan: (projectId: string, text: string) => void;
}) => {
  const [projectId, setProjectId] = useState(startProject);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TicketState>(startStatus);
  const [priority, setPriority] = useState<Priority>('none');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [trackerProject, setTrackerProject] = useState<string | null>(
    startTrackerProject
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const project = projects.find((one) => one.projectId === projectId);
  const parentItem =
    parent === null
      ? null
      : lookups.items.find(
          (one) => one.projectId === projectId && one.id === parent
        ) ?? null;

  const create = (): void => {
    if (title.trim() === '' || busy) {
      return;
    }

    const ticket: NewTicket = {
      title: title.trim(),
      ...(description.trim() === '' ? {} : { description }),
      status,
      priority,
      assignee,
      ...(labels.length === 0 ? {} : { labels }),
      ...(parent === null ? {} : { parent }),
      ...(trackerProject === null ? {} : { project: trackerProject }),
    };
    setBusy(true);
    setProblem(null);
    api
      .newTicket(projectId, ticket)
      .then(onCreated)
      .catch((caught: unknown) => setProblem(errorText(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="tk-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="tk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New ticket"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          }

          if (event.key === 'Enter' && event.metaKey) {
            create();
          }
        }}
      >
        <header className="tk-dialog__head">
          <h2>New ticket</h2>
          <MenuButton
            className="tk-dialog__project"
            label={`Codebase: ${project?.name ?? ''}`}
            menu={(close) => (
              <TicketMenu
                label="Codebase"
                placeholder="Codebase…"
                align="right"
                options={projects.map((one) => ({
                  value: one.projectId,
                  label: one.name,
                }))}
                selected={[projectId]}
                onPick={(value) => {
                  setProjectId(value);
                  setParent(null);
                  setAssignee(null);
                  setTrackerProject(null);
                  close();
                }}
                onClose={close}
              />
            )}
          >
            {project?.name ?? 'Codebase'} ▾
          </MenuButton>
          <button
            type="button"
            className="tk-icon-button tk-icon-button--bare"
            aria-label="Close"
            onClick={onClose}
          >
            <LineIcon name="close" />
          </button>
        </header>
        <input
          className="tk-dialog__title"
          aria-label="Ticket title"
          placeholder="Ticket title"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="tk-dialog__description"
          aria-label="Description"
          placeholder="Add a description…"
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="tk-dialog__props">
          <MenuButton
            className="tk-pill"
            label={`Status: ${STATUSES[status].name}`}
            menu={(close) => (
              <TicketMenu
                label="Status"
                placeholder="Status…"
                options={statusOptions()}
                selected={[status]}
                onPick={(value) => {
                  if (isStatusName(value)) {
                    setStatus(value);
                  }
                  close();
                }}
                onClose={close}
              />
            )}
          >
            <StatusIcon status={status} label={false} />
            {STATUSES[status].name}
          </MenuButton>
          <MenuButton
            className="tk-pill"
            label={`Priority: ${PRIORITY_NAMES[priority]}`}
            menu={(close) => (
              <TicketMenu
                label="Priority"
                placeholder="Priority…"
                options={priorityOptions()}
                selected={[priority]}
                onPick={(value) => {
                  if (isPriorityName(value)) {
                    setPriority(value);
                  }
                  close();
                }}
                onClose={close}
              />
            )}
          >
            <PriorityIcon priority={priority} label={false} />
            {priority === 'none' ? 'Priority' : PRIORITY_NAMES[priority]}
          </MenuButton>
          <MenuButton
            className="tk-pill"
            label={`Assignee: ${assignee ?? 'Unassigned'}`}
            menu={(close) => (
              <TicketMenu
                label="Assignee"
                placeholder="Assign to…"
                options={assigneeOptions(
                  lookups.computersFor(projectId),
                  lookups.owner,
                  null,
                  lookups.items.find((one) => one.projectId === projectId)
                    ?.source ?? null
                )}
                selected={[assignee ?? UNASSIGNED]}
                onPick={(value) => {
                  setAssignee(value === UNASSIGNED ? null : value);
                  close();
                }}
                onClose={close}
              />
            )}
          >
            <AssigneeIcon assignee={assignee} owner={lookups.owner} />
            {assignee ?? 'Unassigned'}
          </MenuButton>
          <MenuButton
            className="tk-pill"
            label="Labels"
            menu={(close) => (
              <TicketMenu
                label="Labels"
                placeholder="Add label…"
                options={labelsOf(lookups.items, projectId).map((label) => ({
                  value: label,
                  label,
                }))}
                selected={labels}
                onPick={(value) =>
                  setLabels(
                    labels.includes(value)
                      ? labels.filter((one) => one !== value)
                      : [...labels, value]
                  )
                }
                onCreate={(text) => {
                  setLabels([...labels, text]);
                  close();
                }}
                onClose={close}
              />
            )}
          >
            {labels.length === 0 ? 'Labels' : labels.join(', ')}
          </MenuButton>
          <MenuButton
            className="tk-pill"
            label={`Epic: ${parentItem?.title ?? 'none'}`}
            menu={(close) => (
              <TicketMenu
                label="Epic"
                placeholder="Epic…"
                options={epicOptions(lookups.items, projectId, null)}
                selected={[parent ?? UNASSIGNED]}
                onPick={(value) => {
                  setParent(value === UNASSIGNED ? null : value);
                  close();
                }}
                onClose={close}
              />
            )}
          >
            {parentItem === null ? 'Epic' : parentItem.title}
          </MenuButton>
          {projectOptions(lookups, [projectId], false).length > 0 && (
            <MenuButton
              className="tk-pill"
              label={`Project: ${trackerProject ?? 'none'}`}
              menu={(close) => (
                <TicketMenu
                  label="Project"
                  placeholder="Project…"
                  options={projectOptions(lookups, [projectId], true)}
                  selected={[trackerProject ?? UNASSIGNED]}
                  onPick={(value) => {
                    setTrackerProject(value === UNASSIGNED ? null : value);
                    close();
                  }}
                  onClose={close}
                />
              )}
            >
              <ProjectIcon
                icon={
                  trackerProject === null
                    ? null
                    : trackerProjectNamed(lookups, [projectId], trackerProject)
                        ?.icon
                }
                color={
                  trackerProject === null
                    ? 'var(--grey-500)'
                    : trackerProjectNamed(lookups, [projectId], trackerProject)
                        ?.color
                }
              />
              {trackerProject ?? 'Project'}
            </MenuButton>
          )}
        </div>
        {problem !== null && <p className="tk-dialog__problem">{problem}</p>}
        <footer className="tk-dialog__foot">
          <button
            type="button"
            className="tk-button tk-button--quiet"
            onClick={() =>
              onPlan(
                projectId,
                [title.trim(), description.trim()]
                  .filter((part) => part !== '')
                  .join('\n\n')
              )
            }
          >
            <LineIcon name="sparkle" />
            Plan with Lambda
          </button>
          <button
            type="button"
            className="tk-button tk-button--primary"
            disabled={title.trim() === '' || busy}
            title="Create ticket (⌘↵)"
            onClick={create}
          >
            Create ticket
          </button>
        </footer>
      </div>
    </div>
  );
};

// ── the screen ──────────────────────────────────────────────────────────────

/** The whole list, a tracker project's tickets, or a saved view's. */
export type TicketsScope =
  | { kind: 'all' }
  | { kind: 'project'; codebaseId: string; name: string }
  | { kind: 'view'; viewId: string };

const scopeKey = (scope: TicketsScope): string =>
  scope.kind === 'all'
    ? 'all'
    : scope.kind === 'project'
    ? `project:${scope.codebaseId}:${scope.name}`
    : `view:${scope.viewId}`;

export const TicketsPage = ({
  state,
  tick,
  open,
  onOpen,
  onOpenPod,
  onOpenLambda,
  onPlan,
  onChatAbout,
  scope,
  filter,
  onFilter,
  workspace,
  onOpenProjects,
  onOpenViews,
  onOpenView,
}: {
  state: AppState;
  tick: number;
  scope: TicketsScope;
  /** The address's `?filter=`: a scoped list's unsaved filters. */
  filter: string | undefined;
  onFilter: (filter: string | undefined) => void;
  workspace: Workspace;
  onOpenProjects: () => void;
  onOpenViews: () => void;
  onOpenView: (viewId: string) => void;
  /** The ticket page up, if any. */
  open: OpenTicket | null;
  onOpen: (ticket: OpenTicket | null) => void;
  onOpenPod: (podId: string) => void;
  /** A Lambda: its planning chat while planning, else its page. */
  onOpenLambda: (lambda: Lambda) => void;
  /** A new chat about a ticket: the New page, the ticket attached. */
  onChatAbout: (
    projectId: string,
    ticket: { id: string; title: string }
  ) => void;
  /** "Plan with Lambda": a new planning chat, its first message typed in. */
  onPlan: (projectId: string, text: string) => void;
}) => {
  const [data, setData] = useState<TicketsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [stored, setStored] = useState(loadView);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState<{ status: TicketState } | null>(
    null
  );
  const [made, setMade] = useState<TicketListItem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useMemo(
    () => latestLoader<TicketsResponse>({ value: setData, error: setError }),
    []
  );
  // A view's or project's page: its settings from the address, folded
  // groups kept while it's up.
  const [scopedFolded, setScopedFolded] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
  const key = scopeKey(scope);

  useEffect(() => {
    setScopedFolded([]);
  }, [key]);

  const scopedView =
    scope.kind === 'view'
      ? workspace.views?.find((one) => one.id === scope.viewId) ?? null
      : null;
  const base: ListSettings =
    scope.kind === 'all'
      ? { groupBy: stored.groupBy, chips: stored.chips }
      : scopedView === null
      ? NO_SETTINGS
      : listSettingsOf(scopedView.settings);
  const settings: ListSettings =
    scope.kind === 'all' ? base : decodeSettings(filter ?? null) ?? base;
  const view: ViewSettings = {
    ...settings,
    folded: scope.kind === 'all' ? stored.folded : scopedFolded,
  };
  const setView = (next: ViewSettings): void => {
    if (scope.kind === 'all') {
      setStored(next);
      saveView(next);

      return;
    }

    setScopedFolded(next.folded);
    const changed = { groupBy: next.groupBy, chips: next.chips };
    onFilter(sameSettings(changed, base) ? undefined : encodeSettings(changed));
  };
  const fixedChips: FilterChip[] =
    scope.kind === 'project'
      ? [
          { field: 'codebase', value: scope.codebaseId },
          { field: 'project', value: scope.name },
        ]
      : [];

  // Every project's sources are asked again on each read: a tick (any app
  // event, or the 20s poll) only re-reads once TICKETS_REFRESH_MS has passed.
  // A reload (after a change) always does.
  const loadedAt = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();

    if (!ticketsRefreshDue(loadedAt.current, now)) {
      return;
    }

    loadedAt.current = now;
    void load(api.tickets());
  }, [load, tick]);

  useEffect(() => {
    if (reload === 0) {
      return;
    }

    loadedAt.current = Date.now();
    void load(api.tickets());
  }, [load, reload]);

  // c makes a ticket, wherever on the Tickets screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key === 'c' &&
        !typing(event.target) &&
        !event.metaKey &&
        !event.ctrlKey &&
        creating === null
      ) {
        event.preventDefault();
        setCreating({ status: 'inbox' });
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);

  const items = data === null ? [] : allTickets(data);
  const projects =
    data?.projects.map((project) => ({
      projectId: project.projectId,
      name: project.name,
    })) ??
    (state.lambda?.projects ?? []).map((project) => ({
      projectId: project.id,
      name: project.name,
    }));
  const projectName = (projectId: string): string =>
    projects.find((project) => project.projectId === projectId)?.name ??
    projectId;
  // What each computer's building pod is doing now, by computer name.
  const building = state.pods.flatMap((summary) => {
    const computer = state.lambda?.podComputers?.[summary.pod.id];

    return summary.pod.kind === 'building' &&
      summary.pod.talk === undefined &&
      summary.status !== 'done' &&
      computer !== undefined &&
      summary.building !== undefined
      ? [{ computer, state: summary.building.state, summary }]
      : [];
  });
  const lambdas = useMemo(() => lambdasOf(state), [state]);
  const openLambda =
    open === null
      ? undefined
      : lambdaOfTicket(lambdas, open.projectId, open.ticketId);
  /** A new chat about the open ticket, the ticket attached. */
  const planTicket = (): void => {
    if (open === null) {
      return;
    }

    onChatAbout(open.projectId, {
      id: open.ticketId,
      title:
        items.find(
          (one) => one.projectId === open.projectId && one.id === open.ticketId
        )?.title ?? '',
    });
  };
  const lookups: Lookups = {
    items,
    projectName,
    computersFor: (projectId) =>
      computerChoices(state.lambda?.computers ?? [], building, projectId),
    owner: state.lambda?.owner ?? { name: 'You', initials: 'Y' },
    projectsOf: workspace.projectsOf,
  };
  const order: OpenTicket[] =
    data === null
      ? []
      : visibleRows(
          boardGroups(items, {
            groupBy: view.groupBy,
            chips: [...fixedChips, ...view.chips],
            search,
            shippingTogether: openGroupKeysByProject(data.groupEvents),
            projectName,
          }),
          new Set(view.folded)
        ).map((row) => ({
          projectId: row.item.projectId,
          ticketId: row.item.id,
        }));

  /** Shows the change at once, then reads the list again. */
  const change = async (
    item: TicketListItem,
    changes: TicketChanges
  ): Promise<void> => {
    const after = await api.updateTicket(item.projectId, item.id, changes);
    setData((now) =>
      now === null
        ? now
        : {
            ...now,
            projects: now.projects.map((project) =>
              'tickets' in project && project.projectId === item.projectId
                ? {
                    ...project,
                    tickets: project.tickets.map((one) =>
                      one.id === item.id ? { ...one, ...after } : one
                    ),
                  }
                : project
            ),
          }
    );
    setReload((value) => value + 1);
  };

  const startProject =
    [...fixedChips, ...view.chips].find((chip) => chip.field === 'codebase')
      ?.value ??
    state.lambda?.lastProjectId ??
    projects[0]?.projectId ??
    '';

  /** The tickets the list shows, for the panel's breakdown. */
  const shown = boardGroups(items, {
    groupBy: 'status',
    chips: [...fixedChips, ...view.chips],
    search: '',
    shippingTogether: new Set(),
    projectName,
  }).flatMap((group) => group.rows.map((row) => row.item));
  const anyProject = (name: string): TrackerProject | undefined =>
    trackerProjectNamed(
      lookups,
      projects.map((project) => project.projectId),
      name
    );
  const dirty =
    scope.kind === 'view'
      ? scopedView !== null && !sameSettings(settings, base)
      : settings.chips.length > 0 ||
        (scope.kind === 'project' && settings.groupBy !== 'status');
  const togglePanel = (): void => {
    storePanelOpen(!panelOpen);
    setPanelOpen(!panelOpen);
  };
  const panelButton = (
    <button
      type="button"
      className={`tk-icon-button${panelOpen ? ' tk-icon-button--on' : ''}`}
      aria-label={panelOpen ? 'Hide the details' : 'Show the details'}
      aria-pressed={panelOpen}
      title="Details"
      onClick={togglePanel}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M14.5 4.5v15" />
      </svg>
    </button>
  );
  const title: ReactNode =
    scope.kind === 'all' ? (
      'Tickets'
    ) : (
      <span className="tickets__crumbs">
        <button
          type="button"
          className="ticket__crumb"
          onClick={scope.kind === 'view' ? onOpenViews : onOpenProjects}
        >
          {scope.kind === 'view' ? 'Views' : 'Projects'}
        </button>
        <span aria-hidden="true">›</span>
        <span className="tickets__crumb-here">
          {scope.kind === 'view' ? (
            <ViewIcon icon={scopedView?.icon} />
          ) : (
            <ProjectIcon
              icon={anyProject(scope.name)?.icon}
              color={anyProject(scope.name)?.color}
            />
          )}
          {scope.kind === 'view'
            ? scopedView?.name ??
              (workspace.views === null ? 'Loading…' : 'No such view')
            : scope.name}
        </span>
      </span>
    );
  // A view's or project's star, beside its name.
  const starred =
    scope.kind === 'view'
      ? { kind: 'view' as const, ref: scope.viewId }
      : scope.kind === 'project'
      ? {
          kind: 'project' as const,
          ref: favoriteRef(scope.codebaseId, scope.name),
        }
      : null;
  const titleEnd: ReactNode =
    starred === null ? null : (
      <StarButton
        what={starred.kind}
        on={workspace.isFavorite(starred.kind, starred.ref)}
        onToggle={() =>
          workspace.setFavorite(
            starred.kind,
            starred.ref,
            !workspace.isFavorite(starred.kind, starred.ref)
          )
        }
      />
    );
  const saveBar: ReactNode = dirty ? (
    <span className="tickets__save">
      {scope.kind !== 'all' && (
        <button
          type="button"
          className="tk-button tk-button--quiet"
          onClick={() => onFilter(undefined)}
        >
          {scope.kind === 'view' ? 'Reset' : 'Clear'}
        </button>
      )}
      <button
        type="button"
        className={`tk-button${
          scope.kind === 'view' ? '' : ' tk-button--primary'
        }`}
        onClick={() => setSaving(true)}
      >
        Save as new view
      </button>
      {scope.kind === 'view' && scopedView !== null && (
        <button
          type="button"
          className="tk-button tk-button--primary"
          disabled={
            scopedView.mine === false && scopedView.visibility === 'personal'
          }
          onClick={() => {
            api
              .updateView(scopedView.id, { settings })
              .then(() => workspace.reloadViews())
              .then(() => onFilter(undefined))
              .catch((caught: unknown) => setProblem(errorText(caught)));
          }}
        >
          Save to view
        </button>
      )}
    </span>
  ) : null;
  const aside: ReactNode = !panelOpen ? null : scope.kind === 'view' ? (
    scopedView === null ? null : (
      <ViewPanel
        view={scopedView}
        items={shown}
        ownerName={lookups.owner.name}
        projectIcon={anyProject}
        onChange={(changes) => {
          api
            .updateView(scopedView.id, changes)
            .then(() => workspace.reloadViews())
            .catch((caught: unknown) => setProblem(errorText(caught)));
        }}
        onDelete={() => {
          api
            .deleteView(scopedView.id)
            .then(() => workspace.reloadViews())
            .then(onOpenViews)
            .catch((caught: unknown) => setProblem(errorText(caught)));
        }}
      />
    )
  ) : scope.kind === 'project' ? (
    <ProjectPanel
      name={scope.name}
      project={trackerProjectNamed(lookups, [scope.codebaseId], scope.name)}
      codebase={projectName(scope.codebaseId)}
      items={shown}
    />
  ) : null;

  return (
    <div className="tickets-screen">
      {error !== null && <p className="error">{error}</p>}
      {problem !== null && (
        <button
          type="button"
          className="error"
          onClick={() => setProblem(null)}
        >
          {problem} (dismiss)
        </button>
      )}
      {made !== null && (
        <div className="tk-toast" role="status">
          <StatusIcon status={made.status} label={false} />
          {made.id} created
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onOpen({ projectId: made.projectId, ticketId: made.id });
              setMade(null);
            }}
          >
            View
          </button>
          <button
            type="button"
            className="tk-icon-button tk-icon-button--bare"
            aria-label="Dismiss"
            onClick={() => setMade(null)}
          >
            <LineIcon name="close" size={12} />
          </button>
        </div>
      )}
      {open !== null ? (
        <TicketView
          open={open}
          lookups={lookups}
          order={order}
          tick={tick}
          buildingOn={(projectId, ticketId) =>
            building.find(
              ({ summary }) =>
                summary.building?.current?.id === ticketId &&
                (state.lambda?.podProjects[summary.pod.id] ?? projectId) ===
                  projectId
            )?.computer ?? null
          }
          onBack={() => onOpen(null)}
          onOpen={onOpen}
          onOpenPod={onOpenPod}
          onChange={change}
          backLabel={
            scope.kind === 'project'
              ? scope.name
              : scope.kind === 'view'
              ? scopedView?.name ?? 'Tickets'
              : 'Tickets'
          }
          starred={workspace.isFavorite(
            'ticket',
            favoriteRef(open.projectId, open.ticketId)
          )}
          onStar={() =>
            workspace.setFavorite(
              'ticket',
              favoriteRef(open.projectId, open.ticketId),
              !workspace.isFavorite(
                'ticket',
                favoriteRef(open.projectId, open.ticketId)
              ),
              items.find(
                (one) =>
                  one.projectId === open.projectId && one.id === open.ticketId
              )?.title
            )
          }
          lambda={openLambda}
          onChat={() => {
            if (openLambda !== undefined) {
              onOpenLambda(openLambda);

              return;
            }

            planTicket();
          }}
          onPlan={planTicket}
        />
      ) : data === null ? (
        error === null && <p className="muted tickets__loading">Loading…</p>
      ) : (
        <ListView
          data={data}
          lookups={lookups}
          view={view}
          onView={setView}
          search={search}
          onSearch={setSearch}
          onOpen={onOpen}
          onNew={(status) => setCreating({ status: status ?? 'inbox' })}
          title={title}
          titleEnd={titleEnd}
          headEnd={scope.kind === 'all' ? null : panelButton}
          fixedChips={fixedChips}
          saveBar={saveBar}
          aside={aside}
          showProject={scope.kind !== 'project'}
          onMove={(item, after) => {
            if (
              item.projectId !== after.projectId ||
              item.parent !== after.parent
            ) {
              setProblem(
                `${item.id} can only move among the tickets beside it in the queue.`
              );

              return;
            }

            api
              .moveTicket(item.projectId, item.id, after.id)
              .then(() => setReload((value) => value + 1))
              .catch((caught: unknown) => setProblem(errorText(caught)));
          }}
        />
      )}
      {creating !== null && (
        <NewTicketDialog
          projects={projects}
          lookups={lookups}
          startProject={startProject}
          startTrackerProject={scope.kind === 'project' ? scope.name : null}
          startStatus={creating.status}
          onClose={() => setCreating(null)}
          onCreated={(item) => {
            setCreating(null);
            setMade(item);
            setReload((value) => value + 1);
          }}
          onPlan={(projectId, text) => {
            setCreating(null);
            onPlan(projectId, text);
          }}
        />
      )}
      {saving && (
        <ViewDialog
          onClose={() => setSaving(false)}
          onSave={async (fields) => {
            const made = await api.newView({
              ...fields,
              settings: {
                groupBy: settings.groupBy,
                chips: [...fixedChips, ...settings.chips],
              },
            });
            await workspace.reloadViews();
            setSaving(false);
            onOpenView(made.id);
          }}
        />
      )}
    </div>
  );
};
