import { DiagramRejectedError } from '@smp/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { checkDiagramSvg, SvgDiagramRenderer } from './svg-diagram-renderer';

// ADR 0048: the SVG of the model passes an allowlist before librsvg renders it into a JPEG.

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, root = `<svg ${NS} width="400" height="300" viewBox="0 0 400 300">`) =>
  `${root}${body}</svg>`;

const DIAGRAM = svg(
  [
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#4338ca"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>',
    '<marker id="arrow" markerWidth="10" markerHeight="10" refX="5" refY="5"><path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>',
    '<rect x="0" y="0" width="400" height="300" fill="#ffffff"/>',
    '<rect x="40" y="40" width="320" height="80" rx="12" fill="url(#g)"/>',
    '<line x1="200" y1="120" x2="200" y2="200" stroke="#111" stroke-width="4" marker-end="url(#arrow)"/>',
    '<text x="200" y="250" font-family="Arial, Helvetica, sans-serif" font-size="28" text-anchor="middle">',
    '<tspan x="200" dy="0">Kunden &amp; Partner</tspan></text>',
  ].join(''),
);

describe('checkDiagramSvg', () => {
  it('accepts shapes, text, gradients and markers with references inside the document', () => {
    expect(checkDiagramSvg(DIAGRAM)).toEqual({ ok: true, svg: DIAGRAM });
  });

  it('drops the XML declaration and comments', () => {
    const checked = checkDiagramSvg(`<?xml version="1.0" encoding="UTF-8"?>\n${svg('<!-- note --><rect/>')}`);

    expect(checked).toEqual({ ok: true, svg: svg('<rect/>') });
  });

  it.each([
    ['a script', svg('<script>alert(1)</script>')],
    ['foreign HTML', svg('<foreignObject><div>x</div></foreignObject>')],
    ['an embedded image', svg('<image width="10" height="10"/>')],
    ['a use element', svg('<use/>')],
    ['a style element', svg('<style>rect{fill:red}</style>')],
    ['an event attribute', svg('<rect onload="alert(1)"/>')],
    ['an event attribute in capitals', svg('<rect ONCLICK="x"/>')],
    ['an href', svg('<linearGradient href="#g"/>')],
    ['an xlink:href', svg('<linearGradient xlink:href="#g"/>')],
    ['an external url()', svg('<rect fill="url(https://example.test/x)"/>')],
    ['an external url() in a style attribute', svg('<rect style="fill:url( \'http://x\' )"/>')],
    ['a data URL', svg('<rect fill="data:image/png;base64,AAAA"/>')],
    ['a doctype with entities', `<!DOCTYPE svg [<!ENTITY a "aaaa">]>${svg('<text>&a;</text>')}`],
    ['an unknown entity', svg('<text>&nbsp;</text>')],
    ['CDATA', svg('<text><![CDATA[x]]></text>')],
    ['a processing instruction', svg('<?xml-stylesheet href="x.css"?><rect/>')],
    ['another namespace', svg('<rect/>', '<svg xmlns="http://www.w3.org/1999/xhtml">')],
    ['a foreign namespaced attribute', svg('<rect xlink:title="x"/>')],
    ['another root element', '<g><svg/></g>'],
    ['markup outside of tags', svg('<rect/> < 3')],
    ['malformed attributes', svg('<rect x=1/>')],
  ])('refuses %s', (_name, markup) => {
    expect(checkDiagramSvg(markup)).toMatchObject({ ok: false });
  });

  it('refuses documents above 512 KB', () => {
    expect(checkDiagramSvg(svg(`<text>${'x'.repeat(600_000)}</text>`))).toMatchObject({ ok: false });
  });
});

describe('SvgDiagramRenderer', () => {
  const renderer = new SvgDiagramRenderer();

  it('renders a JPEG of exactly the requested size without metadata', async () => {
    const jpeg = await renderer.render(DIAGRAM, { width: 1080, height: 1350 });
    const metadata = await sharp(jpeg).metadata();

    expect(metadata).toMatchObject({ format: 'jpeg', width: 1080, height: 1350, hasAlpha: false });
    expect(metadata.exif).toBeUndefined();
    // The white background of the letterbox: the format is taller than the drawing.
    const { data } = await sharp(jpeg).extract({ left: 540, top: 5, width: 1, height: 1 }).raw().toBuffer({
      resolveWithObject: true,
    });
    expect([...data].every((channel) => channel > 245)).toBe(true);
  });

  it('throws DiagramRejectedError for refused markup and for SVG librsvg cannot read', async () => {
    await expect(renderer.render(svg('<script/>'), { width: 100, height: 100 })).rejects.toBeInstanceOf(
      DiagramRejectedError,
    );
    await expect(
      renderer.render(svg('<rect/>', `<svg ${NS} width="0" height="-5">`), { width: 100, height: 100 }),
    ).rejects.toBeInstanceOf(DiagramRejectedError);
  });
});
