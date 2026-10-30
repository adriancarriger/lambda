import { isWaitingPodId, waitingPodId } from '../shared/waitingPod';

describe('a waiting pod’s id', () => {
  it('is told from a pod’s by the one prefix both sides share', () => {
    expect(waitingPodId('wait_ab12')).toBe('waiting:wait_ab12');
    expect(isWaitingPodId(waitingPodId('wait_ab12'))).toBe(true);
    expect(isWaitingPodId('dog-park-map')).toBe(false);
    expect(isWaitingPodId('waitingroom')).toBe(false);
  });
});
