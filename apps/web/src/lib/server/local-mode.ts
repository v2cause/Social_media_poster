/** Whether the web app runs in the single-user mode (ADR 0046). Read on the server only. */
export const isLocalMode = (env: NodeJS.ProcessEnv = process.env): boolean => env['LOCAL_MODE'] === 'true';
