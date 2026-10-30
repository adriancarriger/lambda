import type { LambdaInfo } from '../shared/types';

/** The project menu Analytics and Settings → Process share with the new-idea box. */
export const ProjectPicker = ({
  lambda,
  value,
  onChange,
}: {
  lambda: LambdaInfo | undefined;
  value: string;
  onChange: (projectId: string) => void;
}) =>
  (lambda?.projects.length ?? 0) < 2 ? null : (
    <label className="project-picker">
      <span className="muted">Codebase</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {(lambda?.projects ?? []).map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
