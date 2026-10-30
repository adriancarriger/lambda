import type { Pod } from '../../pod-store';
import { podName } from '../shared/podName';
import {
  STRUCTURE_BETWEEN,
  type StructureProposal,
  structureCheckpoints,
  structureWhat,
} from '../shared/structurePitch';

/**
 * A freeform pod's dev proposes structured planning: the Plan rail shows the
 * pitch — what it would plan, why now, and (short, like an ad) how it works.
 * Start planning is the footer's black button (⌘⏎); keep chatting to wait.
 */
export const StructureCard = ({
  pod,
  proposal,
}: {
  pod: Pod;
  proposal: StructureProposal;
}) => {
  const checkpoints = structureCheckpoints(proposal);

  return (
    <article className="card structure-pitch">
      <div className="card__meta">
        <span className="kind">Structured planning</span>
        <span>{podName(pod)}</span>
      </div>
      <section className="section">
        <p className="structure-pitch__eyebrow">Ready to plan</p>
        <h3 className="structure-pitch__what">
          {structureWhat(proposal, podName(pod))}
        </h3>
        <p className="structure-pitch__why">{proposal.why}</p>
      </section>
      <section className="section">
        <p className="lead">
          Lambda does the work. You step in at {checkpoints.length} checkpoints
          to approve or steer:
        </p>
        <ol className="structure-pitch__steps">
          {checkpoints.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="muted structure-pitch__between">{STRUCTURE_BETWEEN}</p>
        <p className="muted structure-pitch__wait">
          Not ready? Keep chatting — this stays here until you start it.
        </p>
      </section>
    </article>
  );
};
