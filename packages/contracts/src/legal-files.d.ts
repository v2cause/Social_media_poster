// The legal texts are bundled as text (tsup loader, vitest plugin).
declare module '*.md' {
  const content: string;
  export default content;
}
