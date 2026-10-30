/**
 * A design system's namespace: the global its bundle assigns
 * (`window.<namespace>`). A new system takes the PascalCase of the project's
 * name with everything but letters and digits removed, prefixed `App` when
 * that doesn't start with a letter or is a browser global it would replace.
 * Once in the manifest it never changes, so
 * existing designs keep working.
 */

/** The manifest's rule: an upper-case letter, then letters and digits. */
export const MANIFEST_NAMESPACE = /^[A-Z][A-Za-z0-9]*$/;

/** Globals a bundle's `window.<namespace> = …` must never overwrite. */
const RESERVED = new Set([
  'React',
  'ReactDOM',
  'Window',
  'Object',
  'Document',
  'JSON',
  'Math',
  'Promise',
  'Array',
  'String',
  'Number',
  'Symbol',
  'Error',
  'Map',
  'Set',
  'Date',
]);

const pascal = (name: string): string =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('');

export const systemNamespace = (
  projectName: string,
  manifestNamespace?: string
): string => {
  if (manifestNamespace !== undefined) {
    return manifestNamespace;
  }

  const joined = pascal(projectName);

  return /^[A-Za-z]/.test(joined) && !RESERVED.has(joined)
    ? joined
    : `App${joined}`;
};
