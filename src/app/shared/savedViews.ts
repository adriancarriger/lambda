import type { TicketListItem } from './building';
import {
  FILTER_FIELDS,
  type FilterChip,
  type FilterField,
  GROUPINGS,
  type Grouping,
} from './ticketBoard';

/**
 * Saved views as the app uses them: a Tickets list's filters and grouping,
 * kept in the address (`?filter=`) while they're being changed, saved as a
 * view, and compared with it to offer Save. Pure: the client bundles it.
 */

export interface ListSettings {
  groupBy: Grouping;
  chips: FilterChip[];
}

export type Visibility = 'personal' | 'workspace';

export interface SavedView {
  id: string;
  owner: string;
  name: string;
  icon: string | null;
  description: string;
  visibility: Visibility;
  settings: { groupBy: string; chips: Array<{ field: string; value: string }> };
  linearId: string | null;
  /** The signed-in owner's own (the list says; a save's answer doesn't). */
  mine?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type FavoriteKind = 'view' | 'project' | 'ticket' | 'lambda';

export interface Favorite {
  id: string;
  kind: FavoriteKind;
  ref: string;
  position: number;
  /** Its name when starred (a ticket's title); null: the app names it. */
  label: string | null;
}

export const NO_SETTINGS: ListSettings = { groupBy: 'status', chips: [] };

const isField = (value: unknown): value is FilterField =>
  FILTER_FIELDS.some((field) => field === value);

const isGrouping = (value: unknown): value is Grouping =>
  GROUPINGS.some((grouping) => grouping === value);

/** A view's stored settings, checked: an unknown field or grouping is dropped. */
export const listSettingsOf = (raw: {
  groupBy?: unknown;
  chips?: unknown;
}): ListSettings => ({
  groupBy: isGrouping(raw.groupBy) ? raw.groupBy : 'status',
  chips: Array.isArray(raw.chips)
    ? raw.chips.flatMap((chip: unknown): FilterChip[] =>
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
});

const chipKey = (chip: FilterChip): string =>
  `${chip.field}\u0000${chip.value}`;

/** The same filters (in any order) and grouping. */
export const sameSettings = (a: ListSettings, b: ListSettings): boolean =>
  a.groupBy === b.groupBy &&
  a.chips.length === b.chips.length &&
  a.chips.every((chip) =>
    b.chips.some((other) => chipKey(other) === chipKey(chip))
  );

const toBase64Url = (text: string): string =>
  btoa(
    encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = (text: string): string =>
  decodeURIComponent(
    Array.from(
      atob(text.replace(/-/g, '+').replace(/_/g, '/')),
      (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    ).join('')
  );

/** The address's `?filter=`: the settings, as Linear keeps them in its URLs. */
export const encodeSettings = (settings: ListSettings): string =>
  toBase64Url(JSON.stringify(settings));

/** `?filter=` read back; null when it's missing or not one of ours. */
export const decodeSettings = (text: string | null): ListSettings | null => {
  if (text === null || text === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(fromBase64Url(text));

    return typeof parsed === 'object' && parsed !== null
      ? listSettingsOf(parsed)
      : null;
  } catch {
    return null;
  }
};

/** A view panel's tab: how many of its tickets each assignee, label or project has. */
export const viewCounts = (
  items: TicketListItem[],
  by: 'assignee' | 'label' | 'project'
): Array<{ key: string; label: string; count: number }> => {
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  items.forEach((item) => {
    if (by === 'label') {
      item.labels.forEach(bump);

      return;
    }

    bump(by === 'assignee' ? item.assignee ?? '' : item.project ?? '');
  });

  return [...counts]
    .map(([key, count]) => ({
      key,
      label:
        key !== ''
          ? key
          : by === 'assignee'
          ? 'No assignee'
          : by === 'project'
          ? 'No project'
          : key,
      count,
    }))
    .sort(
      (a, b) => Number(a.key === '') - Number(b.key === '') || b.count - a.count
    );
};

/** A favorite of a project or ticket: `<codebase>/<name or id>`. */
export const favoriteRef = (codebaseId: string, name: string): string =>
  `${codebaseId}/${name}`;

export const splitFavoriteRef = (
  ref: string
): { codebaseId: string; name: string } => {
  const at = ref.indexOf('/');

  return at === -1
    ? { codebaseId: '', name: ref }
    : { codebaseId: ref.slice(0, at), name: ref.slice(at + 1) };
};
