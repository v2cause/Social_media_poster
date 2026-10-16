import { generationEventSchema, type GenerationEvent } from '@smp/contracts';

/** The events of a finished server-sent event stream, validated against the contract. */
export function parseSse(text: string): GenerationEvent[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n');
      const name = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
      const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? '';
      const event = generationEventSchema.parse(JSON.parse(data));
      if (event.type !== name) {
        throw new Error(`event name ${String(name)} does not match the type ${event.type}`);
      }
      return event;
    });
}

/** Collects the body of a text/event-stream response as text, for supertest's parse(). */
export function sseParser(res: unknown, callback: (error: Error | null, body: string) => void): void {
  const stream = res as NodeJS.ReadableStream & { setEncoding: (encoding: BufferEncoding) => void };
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    body += chunk;
  });
  stream.on('end', () => {
    callback(null, body);
  });
}
