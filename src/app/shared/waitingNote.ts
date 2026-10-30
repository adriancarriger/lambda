/**
 * The line under a waiting pod whose last start failed: the runner's reason,
 * and when Lambda tries again (it waits first, in case the start that timed
 * out made the pod after all).
 */
export const waitingFailureNote = (
  failure: { error: string; retryAt: string },
  now: number
): string => {
  const error = failure.error.trim();
  const start =
    error === ''
      ? "Didn't start, for no reason given."
      : `Didn't start: ${/[.!?]$/.test(error) ? error : `${error}.`}`;
  const minutes = Math.ceil((Date.parse(failure.retryAt) - now) / 60_000);

  if (!Number.isFinite(minutes)) {
    return `${start} Lambda tries again shortly.`;
  }

  return minutes <= 0
    ? `${start} Trying again now.`
    : `${start} Lambda tries again in ${minutes} min.`;
};
