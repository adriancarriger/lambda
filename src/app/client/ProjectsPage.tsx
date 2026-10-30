import { favoriteRef } from '../shared/savedViews';
import { ProjectIcon, StarButton } from './ProjectIcon';
import type { Workspace } from './useWorkspace';

/**
 * Projects, as Linear lists them: every codebase's tracker projects in one
 * table — name, lead, target date, status and progress. A row opens the
 * project's own page (its tickets, and its details on the right).
 */

const shortDay = (iso: string): string => {
  const day = new Date(`${iso.slice(0, 10)}T12:00:00`);

  return Number.isNaN(day.getTime())
    ? iso
    : day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Linear's status ring: how far along, in the status's colour. */
const StatusRing = ({
  progress,
  type,
}: {
  progress: number | null;
  type: string | null;
}) => {
  const done = Math.max(0, Math.min(1, progress ?? 0));
  const colour =
    type === 'completed'
      ? 'var(--success)'
      : type === 'started'
      ? 'var(--amber)'
      : 'var(--grey-500)';
  const radius = 5;
  const around = 2 * Math.PI * radius;

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke={colour}
        strokeWidth="1.5"
        strokeDasharray={type === 'backlog' || type === 'planned' ? '2 2' : ''}
      />
      <circle
        cx="7"
        cy="7"
        r={radius / 2}
        fill="none"
        stroke={colour}
        strokeWidth={radius}
        strokeDasharray={`${(done * around) / 2} ${around}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
};

export const ProjectsPage = ({
  workspace,
  onOpenProject,
}: {
  workspace: Workspace;
  onOpenProject: (codebaseId: string, name: string) => void;
}) => {
  const codebases = workspace.trackerProjects?.codebases ?? null;
  const rows = (codebases ?? []).flatMap((codebase) =>
    'projects' in codebase
      ? codebase.projects.map((project) => ({ codebase, project }))
      : []
  );
  const several = (codebases ?? []).length > 1;

  return (
    <section className="tickets projects-page">
      <header className="tickets__head">
        <h1 className="tickets__title">
          Projects <span className="tickets__count">{rows.length}</span>
        </h1>
      </header>
      {(codebases ?? []).flatMap((codebase) =>
        'offline' in codebase
          ? [
              <p key={codebase.projectId} className="tickets__offline muted">
                {codebase.name}: {codebase.offline}
              </p>,
            ]
          : []
      )}
      {codebases === null ? (
        <p className="muted tickets__loading">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="tickets__empty muted">
          No projects. They come from each codebase&apos;s tracker:
          Linear&apos;s projects, or a markdown ticket&apos;s{' '}
          <code>project:</code> line.
        </p>
      ) : (
        <div className="projects-table" role="table" aria-label="Projects">
          <div className="projects-table__head" role="row">
            <span role="columnheader">Name</span>
            {several && <span role="columnheader">Codebase</span>}
            <span role="columnheader">Lead</span>
            <span role="columnheader">Target date</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" aria-label="Favorite" />
          </div>
          {rows.map(({ codebase, project }) => {
            const ref = favoriteRef(codebase.projectId, project.name);
            const starred = workspace.isFavorite('project', ref);

            return (
              <div
                key={`${codebase.projectId}/${project.id}`}
                className={`projects-table__row${
                  several ? ' projects-table__row--several' : ''
                }`}
                role="row"
              >
                <button
                  type="button"
                  className="projects-table__name"
                  onClick={() =>
                    onOpenProject(codebase.projectId, project.name)
                  }
                >
                  <ProjectIcon icon={project.icon} color={project.color} />
                  <span>{project.name}</span>
                </button>
                {several && (
                  <span className="projects-table__cell muted">
                    {codebase.name}
                  </span>
                )}
                <span className="projects-table__cell">
                  {project.lead ?? <span className="muted">—</span>}
                </span>
                <span className="projects-table__cell">
                  {project.targetDate === null ? (
                    <span className="muted">—</span>
                  ) : (
                    shortDay(project.targetDate)
                  )}
                </span>
                <span className="projects-table__cell projects-table__status">
                  <StatusRing
                    progress={project.progress}
                    type={project.status?.type ?? null}
                  />
                  {project.progress === null
                    ? project.status?.name ?? ''
                    : `${Math.round(project.progress * 100)}%`}
                </span>
                <span className="projects-table__star">
                  <StarButton
                    what="project"
                    on={starred}
                    onToggle={() =>
                      workspace.setFavorite('project', ref, !starred)
                    }
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
