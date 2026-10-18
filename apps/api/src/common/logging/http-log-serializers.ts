import { privatePath } from '@smp/observability';

// What the request log keeps of each request and response. Headers carry cookies and tokens,
// query strings carry OAuth codes and state, the reset link of Better Auth carries its token in
// the path, and the client address is personal data. None of it is needed to trace a request;
// the request ID links the log lines instead.

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
}

interface SerializedResponse {
  statusCode?: number;
}

export const httpLogSerializers = {
  // The path without query and fragment, with the token of a link masked (as in the spans).
  req: (req: SerializedRequest) => ({ id: req.id, method: req.method, path: privatePath(req.url) }),
  res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
};
