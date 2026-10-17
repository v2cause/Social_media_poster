// The derived numbers of architecture 8. A metric the platform does not report stays null, so
// "n. v." and 0 remain apart.

/** The interactions of a post; null where the platform does not report one. */
export interface Interactions {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
}

const INTERACTIONS = ['likes', 'comments', 'shares', 'saves', 'clicks'] as const;

/** The sum of the interactions a platform reports; null when it reports none of them. */
export function engagementsOf(metrics: Interactions): number | null {
  const values = INTERACTIONS.map((key) => metrics[key]).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}
