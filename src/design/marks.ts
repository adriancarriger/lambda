/**
 * Numbered callouts on a design's still pictures.
 *
 * A prototype marks an element with `data-mark="<n>"`; one screen-wide
 * `marks.json` (`[{n, label}]`) says what each number means, so a number means
 * the same thing in every state. `lambda design walk --stills` measures the marked
 * boxes in the page, lays the badges out here (pure), then draws them with an
 * in-page overlay (Lambda carries no image library).
 */

export interface Mark {
  n: number;
  label: string;
}

/** A `data-mark` element's box, relative to the `[data-screen]` element. */
export interface MarkBox {
  /** The raw `data-mark` attribute. */
  mark: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MarkLayout {
  /** Top-left of each badge, in mark number order. */
  badges: { n: number; x: number; y: number }[];
  /** Only the marks present, in number order. */
  legend: Mark[];
}

/** A badge is a BADGE_SIZE circle; the legend check refuses longer labels. */
export const BADGE_SIZE = 24;
export const MAX_MARK_LABEL = 80;

const checkMarks = (marks: readonly Mark[]): void => {
  marks.reduce<number[]>((seen, { n, label }) => {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `marks.json: ${JSON.stringify(n)} is not a mark number (1, 2, 3…).`
      );
    }

    if (seen.includes(n)) {
      throw new Error(`marks.json: mark ${n} is listed twice.`);
    }

    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error(`marks.json: mark ${n} has an empty label.`);
    }

    if (label.length > MAX_MARK_LABEL) {
      throw new Error(
        `marks.json: mark ${n}'s label is ${label.length} characters, over ${MAX_MARK_LABEL}.`
      );
    }

    return [...seen, n];
  }, []);
};

/** Read `marks.json`: a list of `{n, label}`, each number once, labels 1–80 characters. */
export const parseMarks = (text: string): Mark[] => {
  const parsed: unknown = JSON.parse(text);

  if (!Array.isArray(parsed)) {
    throw new Error('marks.json must be a list of {"n": 1, "label": "…"}.');
  }

  const marks = parsed.map((entry: unknown): Mark => {
    const n =
      typeof entry === 'object' && entry !== null && 'n' in entry
        ? entry.n
        : undefined;
    const label =
      typeof entry === 'object' && entry !== null && 'label' in entry
        ? entry.label
        : undefined;

    if (typeof n !== 'number') {
      throw new Error(
        `marks.json: ${JSON.stringify(entry)} has no numeric "n".`
      );
    }

    return { n, label: typeof label === 'string' ? label : '' };
  });
  checkMarks(marks);

  return marks;
};

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(value, 0), Math.max(max, 0));

/**
 * Badges at each marked box's top-left corner (clamped inside `page`) and the
 * legend for the marks present. Throws naming the mark on a mark marks.json
 * does not label, a label that is empty or over 80 characters, a number on two
 * elements, or a zero-size box. Marks a state does not use are fine.
 */
export const layoutMarks = (
  boxes: readonly MarkBox[],
  marks: readonly Mark[],
  page: { width: number; height: number }
): MarkLayout => {
  checkMarks(marks);

  const placed = boxes
    .reduce<{ n: number; x: number; y: number }[]>((done, box) => {
      const n = /^[1-9]\d*$/.test(box.mark) ? Number(box.mark) : Number.NaN;

      if (Number.isNaN(n)) {
        throw new Error(
          `data-mark ${JSON.stringify(
            box.mark
          )}: a mark must be a number from marks.json.`
        );
      }

      if (!marks.some((mark) => mark.n === n)) {
        throw new Error(
          `data-mark ${n}: mark ${n} has no label in marks.json.`
        );
      }

      if (done.some((badge) => badge.n === n)) {
        throw new Error(`data-mark ${n}: mark ${n} marks two elements.`);
      }

      if (!(box.width > 0 && box.height > 0)) {
        throw new Error(
          `data-mark ${n}: mark ${n}'s element has a zero-size box (${box.width}×${box.height}).`
        );
      }

      return [
        ...done,
        {
          n,
          x: clamp(box.x, page.width - BADGE_SIZE),
          y: clamp(box.y, page.height - BADGE_SIZE),
        },
      ];
    }, [])
    .sort((a, b) => a.n - b.n);

  return {
    badges: placed,
    legend: placed.map(({ n }) => {
      const mark = marks.find((one) => one.n === n);

      if (mark === undefined) {
        throw new Error(`mark ${n} vanished from marks.json.`);
      }

      return { n, label: mark.label };
    }),
  };
};
