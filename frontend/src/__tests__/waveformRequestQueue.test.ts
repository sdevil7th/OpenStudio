import { expect, it } from "vitest";
import { WaveformRequestQueue } from "../utils/waveformRequestQueue";

it("bounds running work, promotes visible tiles and discards an obsolete viewport", async () => {
  const queue = new WaveformRequestQueue(1), order: string[] = [];
  let release!: () => void, current = true;
  queue.enqueue("first", 0, async () => { order.push("first"); await new Promise<void>(resolve => { release = resolve; }); }, () => true);
  await new Promise(resolve => setTimeout(resolve, 0));
  queue.enqueue("ahead", 1, async () => { order.push("ahead"); }, () => true);
  queue.enqueue("old", 0, async () => { order.push("old"); }, () => current);
  queue.enqueue("visible", 1, async () => { order.push("wrong"); }, () => true);
  queue.enqueue("visible", 0, async () => { order.push("visible"); }, () => true);
  expect(queue.activeCount).toBe(1); current = false; release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toEqual(["first", "visible", "ahead"]);
  expect(queue.queuedCount).toBe(0);
});

it("bounds queued lookahead and runs a new source generation after an old in-flight request", async () => {
  const queue = new WaveformRequestQueue(1, 3), order: number[] = [];
  let release!: () => void;
  queue.enqueue("same", 0, async () => { order.push(1); await new Promise<void>(resolve => { release = resolve; }); }, () => true);
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i++) queue.enqueue(`ahead-${i}`, 1, async () => {}, () => true);
  expect(queue.queuedCount).toBe(3);
  queue.enqueue("same", 0, async () => { order.push(2); }, () => true);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toEqual([1, 2]); expect(queue.activeCount).toBe(0);
});
