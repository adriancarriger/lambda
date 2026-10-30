import { ACCOUNT_PAGES, type AccountPage, type Route } from '../shared/route';

/**
 * The one page up instead of the inbox or a Lambda: a new pod, Time, Tickets
 * or an account-menu page. One value, so two can never be up at once.
 */
export type Page =
  | 'new'
  | 'time'
  | 'tickets'
  | 'projects'
  | 'views'
  | AccountPage;

/** The page a URL names, or null for the inbox and a Lambda. */
export const pageOfRoute = (route: Route): Page | null => {
  if (route.page === 'account') {
    return route.which;
  }

  // A project's or a view's page is the Tickets list, scoped to it.
  if (route.page === 'project' || route.page === 'view') {
    return 'tickets';
  }

  return route.page === 'new' ||
    route.page === 'time' ||
    route.page === 'tickets' ||
    route.page === 'projects' ||
    route.page === 'views'
    ? route.page
    : null;
};

/** The account-menu page that's up, if it's one of those. */
export const accountPageOf = (page: Page | null): AccountPage | null =>
  ACCOUNT_PAGES.find((known) => known === page) ?? null;

/** Settings' tabs, one per settings page. */
export type SettingsTab = 'devices' | 'process' | 'design-system';

/** The Settings tab an account page shows: Devices for anything not a tab. */
export const settingsTabOf = (page: AccountPage | null): SettingsTab => {
  if (page === 'settings/process') {
    return 'process';
  }

  return page === 'settings/design-system' ? 'design-system' : 'devices';
};
