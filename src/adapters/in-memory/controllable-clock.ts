import { Clock } from '../../core/ports/clock.js';

export class ControllableClock implements Clock {
  private currentMs: number;

  constructor(initialMs: number = Date.now()) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  epochSeconds(): number {
    return Math.floor(this.currentMs / 1000);
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('Cannot move clock backward');
    }
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
}
