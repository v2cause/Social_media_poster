import { uuidv7 } from 'uuidv7';

import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';

/** The real clock for API and worker. Tests pass a fixed one. */
export const systemClock: Clock = { now: () => new Date() };

export const uuidV7Ids: IdGenerator = { newId: () => uuidv7() };
