import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RawSimulationOutputRef,
  SimulationSecondRecord,
  SimulationSession,
  SimulationStateRecorder,
} from "../domain/types.js";
import { buildCompactRecords, defaultCheckpointIntervalSeconds } from "./compact-records.js";

export class JsonlSimulationStateRecorder implements SimulationStateRecorder {
  private outputPath = "";
  private lastStateKey = "";

  async open(session: SimulationSession): Promise<void> {
    await mkdir(session.config.simulation.outputDir, { recursive: true });
    this.outputPath = join(session.config.simulation.outputDir, session.config.simulation.rawOutputFile);
    await writeFile(
      this.outputPath,
      `${JSON.stringify({
        kind: "metadata",
        sessionId: session.id,
        config: session.config,
        recording: {
          schema: "compact-jsonl-v1",
          checkpointIntervalSeconds: defaultCheckpointIntervalSeconds,
        },
      })}\n`,
      "utf8",
    );
  }

  async recordSecond(record: SimulationSecondRecord): Promise<void> {
    const result = buildCompactRecords(record, this.lastStateKey, defaultCheckpointIntervalSeconds);
    this.lastStateKey = result.stateKey;
    const lines = result.records.map((compactRecord) => JSON.stringify(compactRecord));

    if (lines.length > 0) {
      await appendFile(this.outputPath, `${lines.join("\n")}\n`, "utf8");
    }
  }

  async close(): Promise<void> {
    return;
  }

  getOutputRef(): RawSimulationOutputRef {
    return { path: this.outputPath };
  }
}
