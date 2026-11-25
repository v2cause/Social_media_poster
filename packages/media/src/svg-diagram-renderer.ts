import { DIAGRAM_ELEMENTS, DiagramRejectedError, type DiagramRenderer } from '@smp/core';
import sharp from 'sharp';

// The DiagramRenderer on sharp (ADR 0048). The SVG comes from the model, so it is checked before
// librsvg sees it: elements and attributes against an allowlist, no entities beyond the five of
// XML, no doctype, no processing instruction, no CDATA, no reference that leaves the document.
// Comments are removed. What passes is rendered at the size of the format, flattened onto white
// and written as JPEG without metadata.

/** Larger answers are no diagram worth rendering. */
export const MAX_SVG_BYTES = 512 * 1024;
const MAX_ELEMENTS = 5_000;
const MAX_INPUT_PIXELS = 50_000_000;

const ELEMENTS: ReadonlySet<string> = new Set(DIAGRAM_ELEMENTS);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const NAMESPACED_ATTRIBUTES: ReadonlySet<string> = new Set(['xml:space', 'xml:lang']);
const WHITE = '#ffffff';

const TAG = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)([^<>]*)>/g;
const ATTRIBUTE = /([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ATTRIBUTE_NAME = /^[A-Za-z_][\w:.-]*$/;
/** An ampersand that does not start one of the five entities of XML or a character reference. */
const UNKNOWN_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/;
/** url(...) to anything but a fragment of the document itself. */
const EXTERNAL_URL = /url\(\s*(?!['"]?#)/i;
const FORBIDDEN_VALUE = /javascript:|vbscript:|data:|@import|expression\s*\(/i;

class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason);
}

function checkAttributes(element: string, source: string): void {
  const rest = source.replace(ATTRIBUTE, (_match, name: string, double?: string, single?: string) => {
    const value = double ?? single ?? '';
    const lower = name.toLowerCase();
    if (!ATTRIBUTE_NAME.test(name)) {
      refuse(`attribute name ${JSON.stringify(name.slice(0, 40))} is not allowed`);
    }
    if (lower.startsWith('on')) {
      refuse(`event attribute ${lower} is not allowed`);
    }
    if (lower === 'href' || lower.endsWith(':href')) {
      refuse('href attributes are not allowed');
    }
    if (lower === 'xmlns') {
      if (element !== 'svg' || value !== SVG_NAMESPACE) {
        refuse('only the SVG namespace is allowed');
      }
    } else if (name.includes(':') && !NAMESPACED_ATTRIBUTES.has(lower)) {
      refuse(`attribute ${lower} is not allowed`);
    }
    if (EXTERNAL_URL.test(value) || FORBIDDEN_VALUE.test(value)) {
      refuse(`attribute ${lower} refers outside the document`);
    }
    return ' ';
  });
  if (rest.replace(/\s+/g, '').replace(/\/$/, '') !== '') {
    refuse(`element ${element} has malformed attributes`);
  }
}

/**
 * The SVG as it will be rendered, without comments, or the reason it is refused. Pure, so the
 * rules are tested without librsvg.
 */
export function checkDiagramSvg(svg: string): { ok: true; svg: string } | { ok: false; reason: string } {
  try {
    if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
      refuse('the SVG is larger than 512 KB');
    }
    const cleaned = svg
      .trim()
      .replace(/^<\?xml\s[^<>?]*\?>/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (/<[!?]/.test(cleaned)) {
      refuse('doctype, entities, CDATA and processing instructions are not allowed');
    }
    if (UNKNOWN_ENTITY.test(cleaned)) {
      refuse('only the entities of XML are allowed');
    }
    let tags = 0;
    let first: string | null = null;
    for (const match of cleaned.matchAll(TAG)) {
      const [, closing, name = '', attributes = ''] = match;
      tags += 1;
      if (tags > MAX_ELEMENTS * 2) {
        refuse('the SVG has too many elements');
      }
      if (!ELEMENTS.has(name)) {
        refuse(`element ${JSON.stringify(name.slice(0, 40))} is not allowed`);
      }
      if (closing) {
        if (attributes.trim() !== '') {
          refuse(`closing tag of ${name} has attributes`);
        }
        continue;
      }
      first ??= name;
      checkAttributes(name, attributes);
    }
    // Every "<" opens one of the tags above; text holds them only as &lt;.
    if ((cleaned.match(/</g) ?? []).length !== tags || (cleaned.match(/>/g) ?? []).length !== tags) {
      refuse('the SVG has markup outside of tags');
    }
    if (first !== 'svg' || !cleaned.startsWith('<svg')) {
      refuse('the root element is not svg');
    }
    return { ok: true, svg: cleaned };
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

export class SvgDiagramRenderer implements DiagramRenderer {
  async render(svg: string, size: { width: number; height: number }): Promise<Uint8Array> {
    const checked = checkDiagramSvg(svg);
    if (!checked.ok) {
      throw new DiagramRejectedError(checked.reason);
    }
    try {
      const jpeg = await sharp(Buffer.from(checked.svg, 'utf8'), {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
      })
        .resize(size.width, size.height, { fit: 'contain', background: WHITE })
        .flatten({ background: WHITE })
        // Full color resolution keeps thin lines and small labels sharp.
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
    } catch {
      throw new DiagramRejectedError('librsvg could not render the SVG');
    }
  }
}
