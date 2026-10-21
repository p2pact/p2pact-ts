// Trains a dictionary off the event loop (learn.ts): sending never waits for training.
import { parentPort, workerData } from "node:worker_threads";
import { trainDict } from "./cover.js";

const { train, test, size, id } = workerData as { train: Uint8Array[]; test: Uint8Array[]; size: number; id: number };
try {
  parentPort!.postMessage({ raw: trainDict(train, test, size, id) });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message });
}
