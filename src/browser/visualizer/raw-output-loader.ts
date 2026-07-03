import type {
  RawSimulationCheckpointRecord,
  RawSimulationDataRecord,
  RawSimulationMetadata,
} from "../../domain/types.js";
import { recordTime } from "./operations.js";
import type { RawOutputLine, VisualizerDataSet } from "./types.js";

export class JsonlVisualizerRawOutputLoader {
  async load(file: File): Promise<VisualizerDataSet> {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new Error("The selected file is empty.");

    let metadata: RawSimulationMetadata | null = null;
    const records: RawSimulationDataRecord[] = [];
    const checkpoints: RawSimulationCheckpointRecord[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let parsed: RawOutputLine;
      try {
        parsed = JSON.parse(line) as RawOutputLine;
      } catch (error) {
        throw new Error(`Line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed.kind === "metadata") {
        metadata = parsed;
        continue;
      }
      records.push(parsed);
      if (parsed.kind === "checkpoint") checkpoints.push(parsed);
    }

    if (!metadata) throw new Error("The raw output does not contain a metadata record.");
    const loadedMetadata = metadata;
    if (checkpoints.length === 0) throw new Error("The raw output does not contain checkpoints, so it cannot be replayed.");

    records.sort((a, b) => recordTime(a) - recordTime(b));
    checkpoints.sort((a, b) => a.t - b.t);

    return {
      metadata: loadedMetadata,
      records,
      checkpoints,
      durationSeconds: loadedMetadata.config.simulation.durationSeconds,
    };
  }
}
