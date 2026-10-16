import { defineConfig } from 'orval';

// Generates the typed TanStack Query client from the OpenAPI document of the API (ADR 0013,
// spike 0.14c). The document is committed and kept current by the API integration tests; the
// generated code is not committed. The build task creates it, and turbo runs that build before
// lint, typecheck and test of this package.
export default defineConfig({
  smp: {
    input: { target: './openapi.json' },
    output: {
      mode: 'split',
      target: './src/generated/api.ts',
      schemas: './src/generated/model',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
      override: {
        mutator: { path: './src/fetcher.ts', name: 'apiFetch' },
        fetch: { includeHttpResponseReturnType: false },
        query: { signal: true },
      },
    },
  },
});
