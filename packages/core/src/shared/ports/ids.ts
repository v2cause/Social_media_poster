/** New UUID v7 identifiers. A port, so that tests get predictable ids. */
export interface IdGenerator {
  newId(): string;
}
