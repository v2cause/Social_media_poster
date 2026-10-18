// k6 offers a console like the one of a browser; @types/k6 does not declare it.
declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
