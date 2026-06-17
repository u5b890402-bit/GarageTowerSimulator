import type { RandomSource } from "../domain/types.js";

export class SeededRandomSource implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextFloat(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  nextInt(minInclusive: number, maxInclusive: number): number {
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + Math.floor(this.nextFloat() * span);
  }

  choose<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot choose from an empty collection.");
    }
    return items[this.nextInt(0, items.length - 1)] as T;
  }
}
