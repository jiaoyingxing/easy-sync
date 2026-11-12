/**
 * A throughput drop below this fraction counts as a significant regression
 * and lowers the adaptive concurrency.
 *
 * The two policies compare against different references: the download policy
 * against the run's peak (and locks serial on the drop), the upload policy
 * against the recent median and only steps down after three consecutive low
 * windows. The ratio is shared so the two directions cannot drift apart; the
 * floors, ceilings and consequences around it remain direction-specific.
 */
export const SIGNIFICANT_THROUGHPUT_DROP_RATIO = 0.5;
