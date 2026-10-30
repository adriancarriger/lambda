/**
 * Where the owner was in each item's plan — the audio's position (as a section
 * and the seconds into it, so it survives clips' real lengths replacing the
 * estimates) and how far the Plan rail was scrolled — so a reload, or coming
 * back to the item later, picks up where they left off. Kept in this browser
 * only, for the most recent MAX_PLACES items.
 */

const STORAGE_KEY = 'pods.places';
const MAX_PLACES = 60;

export interface PlanPlace {
  audio?: { section: string; offset: number };
  scrollTop?: number;
  /** The card at the top of the rail, and how far into it — see anchorAt. */
  anchor?: ScrollAnchor;
  /** Last written (ms), to keep the newest. */
  at: number;
}

type Places = Record<string, PlanPlace>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readAll = (): Places => {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}'
    );

    if (!isRecord(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]): [string, PlanPlace][] => {
        if (!isRecord(value) || typeof value.at !== 'number') {
          return [];
        }

        const { audio, scrollTop, anchor } = value;

        return [
          [
            key,
            {
              at: value.at,
              scrollTop: typeof scrollTop === 'number' ? scrollTop : undefined,
              anchor:
                isRecord(anchor) &&
                typeof anchor.key === 'string' &&
                typeof anchor.offset === 'number'
                  ? { key: anchor.key, offset: anchor.offset }
                  : undefined,
              audio:
                isRecord(audio) &&
                typeof audio.section === 'string' &&
                typeof audio.offset === 'number'
                  ? { section: audio.section, offset: audio.offset }
                  : undefined,
            },
          ],
        ];
      })
    );
  } catch {
    return {};
  }
};

export const loadPlace = (itemKey: string): PlanPlace | undefined =>
  readAll()[itemKey];

export const savePlace = (
  itemKey: string,
  change: Partial<Omit<PlanPlace, 'at'>>
): void => {
  const places = readAll();
  const next: Places = {
    ...places,
    [itemKey]: { ...places[itemKey], ...change, at: Date.now() },
  };
  const kept = Object.fromEntries(
    Object.entries(next)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_PLACES)
  );

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Private mode or full: the place just isn't remembered.
  }
};

/**
 * A place in the Plan rail as "this card, this far into it", so it holds when
 * cards above it grow, shrink, appear or go (a new version of the plan).
 * Cards are the `[data-card]` screens, tickets and decisions; between them,
 * the `[data-section]` blocks. Pixels from the top are only the fallback.
 */
export interface ScrollAnchor {
  key: string;
  offset: number;
}

const ANCHORS = '[data-card], [data-section]';

const keyOfAnchor = (element: HTMLElement): string | undefined =>
  element.dataset.card !== undefined
    ? `card:${element.dataset.card}`
    : element.dataset.section !== undefined
    ? `section:${element.dataset.section}`
    : undefined;

/** The innermost card or section across the rail's top edge. */
export const anchorAt = (box: HTMLElement): ScrollAnchor | undefined => {
  const { top } = box.getBoundingClientRect();
  const [inner] = [...box.querySelectorAll<HTMLElement>(ANCHORS)]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top <= top + 1 && rect.bottom > top + 1)
    .sort((a, b) => a.rect.height - b.rect.height);
  const key = inner === undefined ? undefined : keyOfAnchor(inner.element);

  return inner === undefined || key === undefined
    ? undefined
    : { key, offset: top - inner.rect.top };
};

/** Scroll so the anchor sits where it was. False: it isn't on the page. */
export const scrollToAnchor = (
  box: HTMLElement,
  anchor: ScrollAnchor
): boolean => {
  const element = [...box.querySelectorAll<HTMLElement>(ANCHORS)].find(
    (candidate) => keyOfAnchor(candidate) === anchor.key
  );

  if (element === undefined) {
    return false;
  }

  box.scrollTop +=
    element.getBoundingClientRect().top +
    anchor.offset -
    box.getBoundingClientRect().top;

  return true;
};
