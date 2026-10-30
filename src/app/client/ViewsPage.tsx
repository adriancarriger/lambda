import { useState } from 'react';

import { NO_SETTINGS } from '../shared/savedViews';
import { StarButton, ViewIcon } from './ProjectIcon';
import { LineIcon } from './TicketIcons';
import { ViewDialog } from './ViewPanels';
import { api } from './api';
import { errorText } from './loading';
import type { Workspace } from './useWorkspace';

/**
 * Views, as Linear lists them: every saved view you can see (the
 * workspace's, and your personal ones), New view, and Import from Linear —
 * which brings a tracker's views and your favorites over, saying what didn't
 * translate.
 */

interface Imported {
  added: number;
  updated: number;
  favorites: number;
  notes: Array<{ view: string; dropped: string[] }>;
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

export const ViewsPage = ({
  workspace,
  ownerName,
  onOpenView,
}: {
  workspace: Workspace;
  ownerName: string;
  onOpenView: (viewId: string) => void;
}) => {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<Imported | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { views } = workspace;

  const importNow = (): void => {
    setImporting(true);
    setProblem(null);
    api
      .importViews()
      .then(async (result) => {
        setImported(result);
        await workspace.reloadViews();
      })
      .catch((caught: unknown) => setProblem(errorText(caught)))
      .finally(() => setImporting(false));
  };

  return (
    <section className="tickets views-page">
      <header className="tickets__head">
        <h1 className="tickets__title">
          Views <span className="tickets__count">{views?.length ?? ''}</span>
        </h1>
        <button
          type="button"
          className="tk-button"
          disabled={importing}
          onClick={importNow}
        >
          {importing ? 'Importing…' : 'Import from Linear'}
        </button>
        <button
          type="button"
          className="tk-button tk-button--primary"
          onClick={() => setCreating(true)}
        >
          <LineIcon name="plus" />
          New view
        </button>
      </header>

      {problem !== null && <p className="error">{problem}</p>}
      {imported !== null && (
        <div className="views-page__imported" role="status">
          <p>
            {imported.added + imported.updated === 0
              ? 'No views to import.'
              : `Imported ${plural(imported.added + imported.updated, 'view')}${
                  imported.updated > 0
                    ? ` (${imported.added} new, ${imported.updated} updated)`
                    : ''
                }`}
            {imported.favorites > 0 &&
              ` and ${plural(imported.favorites, 'favorite')}`}
            .
          </p>
          {imported.notes.length > 0 && (
            <>
              <p className="muted">
                Some filters don&apos;t have a match in Lambda, so they were
                left out:
              </p>
              <ul>
                {imported.notes.map((note) => (
                  <li key={note.view}>
                    <strong>{note.view}</strong>: {note.dropped.join(', ')}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="tk-icon-button tk-icon-button--bare views-page__dismiss"
            aria-label="Dismiss"
            onClick={() => setImported(null)}
          >
            <LineIcon name="close" size={12} />
          </button>
        </div>
      )}

      {views === null ? (
        <p className="muted tickets__loading">Loading…</p>
      ) : views.length === 0 ? (
        <p className="tickets__empty muted">
          No views yet. Filter a list and choose Save as new view, or import
          your views from Linear.
        </p>
      ) : (
        <div className="views-list">
          {views.map((view) => {
            const starred = workspace.isFavorite('view', view.id);

            return (
              <div key={view.id} className="views-list__row">
                <button
                  type="button"
                  className="views-list__open"
                  onClick={() => onOpenView(view.id)}
                >
                  <ViewIcon icon={view.icon} />
                  <span className="views-list__name">{view.name}</span>
                  {view.description !== '' && (
                    <span className="views-list__description muted">
                      {view.description}
                    </span>
                  )}
                </button>
                <span
                  className="views-list__visibility muted"
                  title={
                    view.visibility === 'personal'
                      ? 'Personal: only you see it'
                      : 'Workspace: everyone sees it'
                  }
                >
                  {view.visibility === 'personal' ? 'Personal' : 'Workspace'}
                </span>
                <span
                  className="view-panel__avatar"
                  title={view.mine === false ? view.owner : ownerName}
                >
                  {(view.mine === false ? view.owner : ownerName)
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <StarButton
                  what="view"
                  on={starred}
                  onToggle={() =>
                    workspace.setFavorite('view', view.id, !starred)
                  }
                />
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <ViewDialog
          onClose={() => setCreating(false)}
          onSave={async (fields) => {
            const made = await api.newView({
              ...fields,
              settings: NO_SETTINGS,
            });
            await workspace.reloadViews();
            setCreating(false);
            onOpenView(made.id);
          }}
        />
      )}
    </section>
  );
};
