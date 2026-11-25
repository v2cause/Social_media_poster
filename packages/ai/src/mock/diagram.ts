import { DIAGRAM_SIZES, type GeneratedDiagram, type GenerateDiagramInput } from '@smp/core';

import { stripMarkers } from './text';

// The diagram of the mock provider: the description split into up to four steps, drawn as boxes
// joined by arrows. Deterministic, and only elements the renderer of @smp/media accepts.

const MAX_STEPS = 4;
const MAX_LABEL = 40;

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;

function stepsOf(description: string): string[] {
  const steps = stripMarkers(description)
    .split(/[\n,;.]+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0)
    .slice(0, MAX_STEPS)
    .map((part) => clip(part, MAX_LABEL));
  return steps.length > 0 ? steps : ['1', '2', '3'];
}

export function composeDiagram(input: GenerateDiagramInput): GeneratedDiagram {
  const { width, height } = DIAGRAM_SIZES[input.format];
  const steps = stepsOf(input.description);
  const title = input.language === 'de' ? 'Ablauf in Schritten' : 'Process in steps';
  const margin = 60;
  const top = 200;
  const gap = 40;
  const boxHeight = Math.min(140, (height - top - margin - gap * (steps.length - 1)) / steps.length);
  const boxes = steps.map((step, index) => {
    const y = top + index * (boxHeight + gap);
    const arrow =
      index < steps.length - 1
        ? `<line x1="${String(width / 2)}" y1="${String(y + boxHeight)}" x2="${String(width / 2)}" y2="${String(y + boxHeight + gap)}" stroke="#1f2937" stroke-width="4"/>`
        : '';
    return [
      `<rect x="${String(margin)}" y="${String(y)}" width="${String(width - 2 * margin)}" height="${String(boxHeight)}" rx="16" fill="#e0e7ff" stroke="#4338ca" stroke-width="3"/>`,
      `<text x="${String(width / 2)}" y="${String(y + boxHeight / 2 + 12)}" font-family="Arial, Helvetica, sans-serif" font-size="32" text-anchor="middle" fill="#111827">${escapeXml(step)}</text>`,
      arrow,
    ].join('');
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">`,
    `<rect x="0" y="0" width="${String(width)}" height="${String(height)}" fill="#ffffff"/>`,
    `<text x="${String(width / 2)}" y="120" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="bold" text-anchor="middle" fill="#111827">${escapeXml(title)}</text>`,
    ...boxes,
    '</svg>',
  ].join('');
  const altText =
    input.language === 'de'
      ? `Ein Ablauf in ${String(steps.length)} Schritten: ${steps.join(', ')}.`
      : `A process in ${String(steps.length)} steps: ${steps.join(', ')}.`;
  return { title, altText, svg };
}
