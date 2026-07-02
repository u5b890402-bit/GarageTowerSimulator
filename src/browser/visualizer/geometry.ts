import type { Point, PolylineSample, Rect } from "./types.js";
import { clamp } from "./operations.js";

export function samplePolyline(points: Point[], progress: number): PolylineSample {
  if (points.length === 0) {
    const origin = { x: 0, y: 0 };
    return { point: origin, previous: origin, next: origin };
  }
  if (points.length === 1) {
    const only = points[0] ?? { x: 0, y: 0 };
    return { point: only, previous: only, next: only };
  }

  const segmentLengths: number[] = [];
  let totalLength = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) continue;
    const length = distance(from, to);
    segmentLengths.push(length);
    totalLength += length;
  }

  if (totalLength === 0) {
    const first = points[0] ?? { x: 0, y: 0 };
    return { point: first, previous: first, next: first };
  }

  let remaining = clamp(progress, 0, 1) * totalLength;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const length = segmentLengths[index] ?? 0;
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) continue;
    if (remaining <= length || index === segmentLengths.length - 1) {
      const localProgress = length === 0 ? 0 : remaining / length;
      return {
        point: {
          x: from.x + (to.x - from.x) * localProgress,
          y: from.y + (to.y - from.y) * localProgress,
        },
        previous: from,
        next: to,
      };
    }
    remaining -= length;
  }

  const last = points[points.length - 1] ?? { x: 0, y: 0 };
  const previous = points[points.length - 2] ?? last;
  return { point: last, previous, next: last };
}

export function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function rectCenter(rect: Rect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function rectFromCenter(center: Point, width: number, height: number): Rect {
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

export function insetRectByPixels(rect: Rect, xInset: number, yInset: number): Rect {
  return {
    x: rect.x + xInset,
    y: rect.y + yInset,
    width: Math.max(8, rect.width - xInset * 2),
    height: Math.max(8, rect.height - yInset * 2),
  };
}

export function unionRects(a: Rect | undefined, b: Rect | undefined): Rect | null {
  if (!a || !b) return null;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export function leftHalf(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width / 2,
    height: rect.height,
  };
}

export function rightHalf(rect: Rect): Rect {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y,
    width: rect.width / 2,
    height: rect.height,
  };
}
