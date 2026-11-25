// Turns the SVG of a diagram into a JPEG (ADR 0048). Implemented with sharp in @smp/media. The SVG
// comes from the model, so the implementation checks it against an allowlist before it renders
// anything and throws DiagramRejectedError for markup it refuses: scripts, external references,
// embedded images, entities and every element outside the list.

export interface DiagramRenderer {
  /** A JPEG of exactly this size, without metadata, on a white background. */
  render(svg: string, size: { width: number; height: number }): Promise<Uint8Array>;
}
