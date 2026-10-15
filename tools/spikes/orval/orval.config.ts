import { defineConfig } from 'orval';

// Spike for guide step 0.14(c): an OpenAPI document from the Nest API (zod DTOs through
// nestjs-zod) becomes a typed TanStack Query client. The generated code must compile under strict TypeScript.
export default defineConfig({
  smp: {
    input: { target: './openapi.json' },
    output: {
      mode: 'tags-split',
      target: './generated/api.ts',
      schemas: './generated/model',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
    },
  },
});
