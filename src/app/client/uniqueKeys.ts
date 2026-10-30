/**
 * React keys for a list whose rows can read the same (two bad lines carry
 * one warning; one ticket ships twice). The first of a kind keeps its plain
 * key, so it holds steady as later duplicates arrive; each later one gets
 * `#2`, `#3`….
 */
export const withKeys = <T>(
  items: T[],
  keyOf: (item: T) => string
): { key: string; item: T }[] => {
  const seen = new Map<string, number>();

  return items.map((item) => {
    const base = keyOf(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    return { key: count === 1 ? base : `${base}#${count}`, item };
  });
};
