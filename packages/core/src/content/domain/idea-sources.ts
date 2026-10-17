// The sources of an idea (guide step 5.6): free text such as "content pillar", or a published
// post the idea builds on. A post is stored as variant:<id>, so the read model can name it and
// link to its analytics; the model itself only knows the refs of the prompt (top-1 to top-5).

const POST_SOURCE = 'variant:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOP_POST_REF = /^top-\d+$/;

/** The source of an idea that builds on a published variant. */
export const postSourceOf = (variantId: string): string => `${POST_SOURCE}${variantId}`;

/** The variant a source names, or null for a source in free text. */
export function variantIdOfSource(source: string): string | null {
  if (!source.startsWith(POST_SOURCE)) {
    return null;
  }
  const id = source.slice(POST_SOURCE.length);
  return UUID.test(id) ? id : null;
}

/** The ref of a top post as the model may write it: Top-1, "top 1" and top_1 all become top-1. */
export const topPostRefOf = (source: string): string =>
  source
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

/**
 * The sources of a suggested idea: refs of top posts become their variants, a ref without a post
 * goes, everything else stays as written; each source once.
 */
export function resolveIdeaSources(
  basedOn: readonly string[],
  postsByRef: ReadonlyMap<string, string>,
): string[] {
  const sources = basedOn.flatMap((source) => {
    const ref = topPostRefOf(source);
    const variantId = postsByRef.get(ref);
    if (variantId !== undefined) {
      return [postSourceOf(variantId)];
    }
    return TOP_POST_REF.test(ref) ? [] : [source.trim()];
  });
  return [...new Set(sources.filter((source) => source.length > 0))];
}
