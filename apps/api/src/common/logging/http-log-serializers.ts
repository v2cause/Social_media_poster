// What the request log keeps of each request and response. Headers carry cookies and tokens,
// query strings will carry OAuth codes and state, and the client address is personal data.
// None of it is needed to trace a request; the request ID links the log lines instead.

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
}

interface SerializedResponse {
  statusCode?: number;
}

/** The path without query string or fragment. */
export function pathOnly(url: string | undefined): string | undefined {
  return url?.split(/[?#]/, 1)[0];
}

export const httpLogSerializers = {
  req: (req: SerializedRequest) => ({ id: req.id, method: req.method, path: pathOnly(req.url) }),
  res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
};
