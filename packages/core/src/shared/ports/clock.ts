/** The current time in UTC. Use cases never call new Date() themselves (guide B.1). */
export interface Clock {
  now(): Date;
}
