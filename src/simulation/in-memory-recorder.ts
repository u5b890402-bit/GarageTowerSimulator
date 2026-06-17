import type {
  RawSimulationDataRecord,
  RawSimulationMetadata,
  RawSimulationOutputRef,
  SimulationSecondRecord,
  SimulationSession,
  SimulationStateRecorder,
} from "../domain/types.js";
import { buildCompactRecords, defaultCheckpointIntervalSeconds } from "./compact-records.js";

export class InMemorySimulationStateRecorder implements SimulationStateRecorder {
  private metadata: RawSimulationMetadata | null = null;
  private readonly records: RawSimulationDataRecord[] = [];
  private lastStateKey = "";

  async open(session: SimulationSession): Promise<void> {
    this.metadata = {
      kind: "metadata",
      sessionId: session.id,
      config: session.config,
      recording: {
        schema: "compact-jsonl-v1",
        checkpointIntervalSeconds: defaultCheckpointIntervalSeconds,
      },
    };
    this.records.length = 0;
    this.lastStateKey = "";
  }

  async recordSecond(record: SimulationSecondRecord): Promise<void> {
    const result = buildCompactRecords(record, this.lastStateKey, defaultCheckpointIntervalSeconds);
    this.records.push(...result.records);
    this.lastStateKey = result.stateKey;
  }

  async close(): Promise<void> {
    return;
  }

  getOutputRef(): RawSimulationOutputRef {
    return { path: "memory://simulation-output.jsonl" };
  }

  getMetadata(): RawSimulationMetadata {
    if (!this.metadata) {
      throw new Error("Recorder has not been opened.");
    }
    return this.metadata;
  }

  getRecords(): RawSimulationDataRecord[] {
    return [...this.records];
  }

  toJsonl(): string {
    return [JSON.stringify(this.getMetadata()), ...this.records.map((record) => JSON.stringify(record))].join("\n") + "\n";
  }
}
