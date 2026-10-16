import { z } from 'zod';

// The fetch function of the generated client. Requests go to the same origin, so the session
// cookie travels along and no CORS is involved (architecture 10). Error responses are RFC 9457
// problem documents; they become an ApiError with the stable code the UI translates.

const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]));
export type ApiErrorParams = z.infer<typeof paramsSchema>;

const problemSchema = z.object({
  status: z.number(),
  code: z.string(),
  detail: z.string().optional(),
  traceId: z.string().optional(),
  /** Values for the translated message, for example the suggested time of SCHEDULE_TIME_IN_GAP. */
  params: paramsSchema.optional(),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly traceId?: string,
    readonly params: ApiErrorParams = {},
  ) {
    super(`API request failed with ${String(status)} ${code}`);
    this.name = 'ApiError';
  }
}

/** The ApiError of a failed response, from its problem document when it has one. */
export async function apiErrorOf(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const problem = problemSchema.safeParse(body);
  return problem.success
    ? new ApiError(problem.data.status, problem.data.code, problem.data.traceId, problem.data.params)
    : new ApiError(response.status, `HTTP_${String(response.status)}`);
}

export async function apiFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' });
  if (!response.ok) {
    throw await apiErrorOf(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
