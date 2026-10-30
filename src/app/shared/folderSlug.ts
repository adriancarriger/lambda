/**
 * New project's folder name: "Sweetums recipe app" → "sweetums-recipe-app"
 * (lowercase, spaces and other non-alphanumerics as hyphens). The dialog
 * shows it; the runner makes `~/Lambda/<it>`.
 */
export const folderSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
