import type { Reporter } from '../tickets/source';

/**
 * Whose tickets a computer builds. A computer is like an engineer, and a
 * ticket's reporter is who it works for: it takes only tickets its owner
 * reported. Aliases let the owner have several ticket logins (the Linear
 * logins of their own build computers); a teammate filing in the same
 * tracker never has their ticket built.
 */

export interface OwnerIdentity {
  name: string;
  email: string | null;
  aliases: { kind: string; value: string }[];
}

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const aliasesOf = (owner: OwnerIdentity, kind: 'email' | 'name'): string[] =>
  owner.aliases
    .filter((alias) => alias.kind === kind)
    .map((alias) => alias.value);

/**
 * The owner's ticket? No reporter: yes, so a project used alone needs no
 * reporter lines. An email is matched first, against `owner.email` then the
 * `email` aliases; a reporter with no email, or one that matches neither,
 * still counts when its name is `owner.name` or a `name` alias. All exact,
 * ignoring case.
 */
export const isOwnersReporter = (
  reporter: Reporter | null,
  owner: OwnerIdentity
): boolean => {
  if (reporter === null) {
    return true;
  }

  const emails = [
    ...(owner.email === null ? [] : [owner.email]),
    ...aliasesOf(owner, 'email'),
  ];
  const { email } = reporter;

  if (email !== undefined && emails.some((known) => same(known, email))) {
    return true;
  }

  return [owner.name, ...aliasesOf(owner, 'name')]
    .filter((name) => name.trim() !== '')
    .some((name) => same(name, reporter.name));
};
