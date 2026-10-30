import type { Priority, TicketState, TrackerView } from './source';

/**
 * A Linear saved view's filter (its `filterData`, Linear's IssueFilter) in
 * Lambda's terms: chips per field, any-of within a field, all fields apply.
 * Linear can say more (cycles, "or" across fields, a label's parent); what
 * Lambda can't is left out and named, never guessed at. Pure.
 */

type Chip = TrackerView['chips'][number];

export interface FilterContext {
  /** A Linear user (by id) as Lambda names its assignee; null: no one Lambda knows. */
  assigneeOf: (userId: string) => string | null;
  /** A Linear label's name as Lambda's label key. */
  labelKey: (name: string) => string;
  /** A Linear project's name, by id. */
  projectName: (projectId: string) => string | null;
  /** A Linear workflow state, by name or type, as Lambda's status. */
  stateOf: (nameOrType: string) => TicketState | null;
  /** Linear's priority number as Lambda's. */
  priorityOf: (value: number) => Priority;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every value a comparator on `prop` names (`{ prop: { eq | in } }`), at any depth. */
const valuesOf = (node: unknown, prop: string): unknown[] => {
  if (Array.isArray(node)) {
    return node.flatMap((one) => valuesOf(one, prop));
  }

  if (!isRecord(node)) {
    return [];
  }

  return Object.entries(node).flatMap(([key, inner]) => {
    // A label's parent group says nothing about the label itself.
    if (key === 'parent') {
      return [];
    }

    if (key === prop && isRecord(inner)) {
      return [
        ...(inner.eq === undefined ? [] : [inner.eq]),
        ...(Array.isArray(inner.in) ? inner.in : []),
      ];
    }

    return valuesOf(inner, prop);
  });
};

const strings = (values: unknown[]): string[] =>
  values.filter((value): value is string => typeof value === 'string');

/** Fields each branch of an `or` filters on: Lambda can say "any of" within one only. */
const fieldsOf = (node: unknown): string[] =>
  isRecord(node)
    ? Object.keys(node).flatMap((key) =>
        key === 'and' || key === 'or'
          ? (Array.isArray(node[key]) ? node[key] : []).flatMap(fieldsOf)
          : [key]
      )
    : [];

const NAMES: Record<string, string> = {
  cycle: 'the cycle',
  team: 'the team',
  creator: 'who created it',
  dueDate: 'the due date',
  estimate: 'the estimate',
  createdAt: 'when it was created',
  updatedAt: 'when it last changed',
  completedAt: 'when it was done',
  subscribers: 'its subscribers',
  description: 'its description',
  title: 'its title',
  parent: 'its parent',
};

export const translateIssueFilter = (
  filter: unknown,
  context: FilterContext
): { chips: Chip[]; dropped: string[] } => {
  // Keyed, so a value named twice is one chip; a reason given twice, one note.
  const chips = new Map<string, Chip>();
  const dropped = new Set<string>();
  const add = (field: Chip['field'], value: string): void => {
    chips.set(`${field}\u0000${value}`, { field, value });
  };
  const drop = (what: string): void => {
    dropped.add(what);
  };

  const walk = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }

    Object.entries(node).forEach(([key, inner]) => {
      switch (key) {
        case 'and':
          (Array.isArray(inner) ? inner : []).forEach(walk);

          break;
        case 'or': {
          const branches = Array.isArray(inner) ? inner : [];
          const fields = new Set(branches.flatMap(fieldsOf));

          if (fields.size > 1) {
            drop(
              `"any of" across ${[...fields].join(', ')} (read as "all of")`
            );
          }

          branches.forEach(walk);

          break;
        }
        case 'labels':
        case 'label':
          strings(valuesOf(inner, 'name')).forEach((name) =>
            add('label', context.labelKey(name))
          );

          break;
        case 'assignee': {
          if (isRecord(inner) && inner.null === true) {
            add('assignee', '');
          }

          strings(valuesOf(inner, 'id')).forEach((id) => {
            const who = context.assigneeOf(id);

            if (who === null) {
              drop('an assignee who is neither a computer nor you');
            } else {
              add('assignee', who);
            }
          });

          if (valuesOf(inner, 'isMe').length > 0) {
            drop('"assigned to me"');
          }

          break;
        }
        case 'project':
          [
            ...strings(valuesOf(inner, 'id')).map(context.projectName),
            ...strings(valuesOf(inner, 'name')),
          ].forEach((name) => {
            if (name !== null) {
              add('project', name);
            }
          });

          break;
        case 'state':
          [
            ...strings(valuesOf(inner, 'name')),
            ...strings(valuesOf(inner, 'type')),
          ].forEach((state) => {
            const status = context.stateOf(state);

            if (status === null) {
              drop(`the status "${state}"`);
            } else {
              add('status', status);
            }
          });

          break;
        case 'priority':
          valuesOf({ priority: inner }, 'priority')
            .filter((value): value is number => typeof value === 'number')
            .forEach((value) => add('priority', context.priorityOf(value)));

          break;
        default:
          drop(NAMES[key] ?? key);
      }
    });
  };

  walk(filter);

  return { chips: [...chips.values()], dropped: [...dropped] };
};
