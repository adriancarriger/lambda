/**
 * The relative globs `design.systemBuild` takes: `*` matches within one path
 * segment, `**` across segments, anything else literally. A plain path
 * matches only itself.
 */
export const globToRegExp = (glob: string): RegExp => {
  const body = glob
    .split(/(\*\*\/?|\*)/)
    .map((part) => {
      if (part === '**/' || part === '**') {
        return '(?:.*/)?' + (part === '**' ? '.*' : '');
      }

      if (part === '*') {
        return '[^/]*';
      }

      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');

  return new RegExp(`^${body}$`);
};

export const matchesAny = (globs: string[], file: string): boolean =>
  globs.some((glob) => globToRegExp(glob).test(file));

/** The files (relative, `/`-separated) any of `globs` names, in their order. */
export const expandGlobs = (globs: string[], files: string[]): string[] =>
  files.filter((file) => matchesAny(globs, file));
