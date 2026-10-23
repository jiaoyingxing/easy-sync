/**
 * A batch whose throughput falls below this fraction of the run's peak is
 * treated as a significant drop and lowers the adaptive concurrency.
 *
 * Shared by the download and upload policies so the two directions cannot
 * drift apart; the floors and ceilings around it remain direction-specific.
 */
export const SIGNIFICANT_THROUGHPUT_DROP_RATIO = 0.5;
