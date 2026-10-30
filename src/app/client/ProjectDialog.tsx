import { type FormEvent, useState } from 'react';

import { folderSlug } from '../shared/folderSlug';
import { api } from './api';

/**
 * Add a project (a folder on the computer running Lambda) or New project (a
 * name; a folder with a starter app and one passing test is made for it).
 * A folder that isn't a git repository is set up quietly. Refusals show here
 * and create nothing.
 */
export interface ProjectMade {
  projectId: string;
  podId?: string | null;
}

export const ProjectDialog = ({
  kind,
  idea,
  onClose,
  onDone,
}: {
  kind: 'add' | 'new';
  /** New project: the idea in the box becomes its first plan. */
  idea: string;
  onClose: () => void;
  /** New project answers the pod it started with the idea, if any. */
  onDone: (result: ProjectMade) => void;
}) => {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = value.trim() === '';

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    if (empty || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    (kind === 'add'
      ? api.addProject(value.trim())
      : api.newProject(value.trim(), idea)
    )
      .then(onDone)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        setBusy(false);
      });
  };

  return (
    <form
      className="dialog"
      role="dialog"
      aria-label={kind === 'add' ? 'Add a codebase' : 'New codebase'}
      onSubmit={submit}
    >
      <h2>{kind === 'add' ? 'Add a codebase' : 'New codebase'}</h2>
      {kind === 'add' ? (
        <label className="dialog__field">
          <span>Folder</span>
          <input
            autoFocus
            value={value}
            placeholder="~/Lambda/pawnee-parks"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      ) : (
        <>
          <label className="dialog__field">
            <span>Name</span>
            <input
              autoFocus
              value={value}
              placeholder="Sweetums recipe app"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <p className="dialog__field">
            <span>Folder</span>
            <span className="muted">~/Lambda/{folderSlug(value) || '…'}</span>
          </p>
          <p className="muted">
            Starts with a small web app and one passing test.
            {idea === '' ? '' : ' Your idea becomes its first plan.'}
          </p>
        </>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog__actions">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={empty || busy}>
          {kind === 'add' ? 'Add' : 'Create'}
        </button>
      </div>
    </form>
  );
};
