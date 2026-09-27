/**
 * Clock port for time operations and deterministic testing
 */
export interface Clock {
  now(): number; // epoch ms
  epochSeconds(): number;
  sleep(ms: number): Promise<void>;
}
