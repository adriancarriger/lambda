import type { Pod } from '../../pod-store';

/** What the owner sees: the title they gave it (right-click → Rename), else the slug. */
export const podName = (pod: Pod): string => pod.title ?? pod.slug;
