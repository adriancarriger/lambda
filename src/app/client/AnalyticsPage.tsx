import { useEffect, useMemo, useState } from 'react';

import type { LambdaInfo } from '../shared/types';
import { ProjectPicker } from './ProjectPicker';
import { type Analytics, api } from './api';
import { latestLoader } from './loading';
import { chosenProjectId } from './projects';
import { withKeys } from './uniqueKeys';

/** A time in whole minutes: "<1 min" under one, "—" when there's none. */
export const minutes = (ms: number | null): string => {
  if (ms === null) {
    return '—';
  }

  return ms < 60_000 ? '<1 min' : `${Math.round(ms / 60_000)} min`;
};

/**
 * Analytics, one project at a time: average time per planning step and per
 * ship stage, and per ship its total, runs until green and Fixing (from a
 * failed attempt's end to the next attempt's start). Warnings never hide.
 */
export const AnalyticsPage = ({
  lambda,
  tick,
}: {
  lambda: LambdaInfo | undefined;
  tick: number;
}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = chosenProjectId(picked, lambda);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useMemo(
    () => latestLoader<Analytics>({ value: setAnalytics, error: setError }),
    []
  );

  useEffect(() => {
    if (projectId === null) {
      return;
    }

    void load(api.analytics(projectId));
  }, [load, projectId, tick]);

  if (projectId === null) {
    return <p className="muted">Add a codebase first.</p>;
  }

  return (
    <section className="account-page">
      <ProjectPicker lambda={lambda} value={projectId} onChange={setPicked} />
      {error !== null && <p className="error">{error}</p>}
      {analytics !== null && analytics.notice !== null && (
        <p className="muted">{analytics.notice}</p>
      )}
      {analytics !== null && !analytics.empty && (
        <>
          {withKeys(analytics.warnings, (warning) => warning).map(
            ({ key, item: warning }) => (
              <p key={key} className="analytics__warning" role="alert">
                ⚠ {warning}
              </p>
            )
          )}
          <table className="analytics__table">
            <thead>
              <tr>
                <th>Planning steps</th>
                <th>average</th>
              </tr>
            </thead>
            <tbody>
              {analytics.steps.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{minutes(row.averageMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="analytics__table">
            <thead>
              <tr>
                <th>Ship stages</th>
                <th>average</th>
              </tr>
            </thead>
            <tbody>
              {analytics.stages.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{minutes(row.averageMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="analytics__table">
            <thead>
              <tr>
                <th>Per ship</th>
                <th>total</th>
                <th>runs until green</th>
                <th>Fixing</th>
              </tr>
            </thead>
            <tbody>
              {withKeys(analytics.ships, (row) => row.name).map(
                ({ key, item: row }) => (
                  <tr key={key}>
                    <td>{row.name}</td>
                    <td>{minutes(row.totalMs)}</td>
                    <td>{row.runsUntilGreen}</td>
                    <td>{minutes(row.fixingMs)}</td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
};
