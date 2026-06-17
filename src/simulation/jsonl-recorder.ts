import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GarageCumulativeCounters,
  RawSimulationOutputRef,
  RawSimulationStateRecord,
  SimulationSecondRecord,
  SimulationSession,
  SimulationStateRecorder,
} from "../domain/types.js";

export class JsonlSimulationStateRecorder implements SimulationStateRecorder {
  private readonly checkpointIntervalSeconds = 300;
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
          checkpointIntervalSeconds: this.checkpointIntervalSeconds,
        },
      })}\n`,
      "utf8",
    );
  }

  async recordSecond(record: SimulationSecondRecord): Promise<void> {
    const lines: string[] = [];

    if (record.generatedEvents.length > 0 || record.intakeResults.length > 0) {
      lines.push(
        JSON.stringify({
          kind: "events",
          t: record.time,
          generated: record.generatedEvents,
          intake: record.intakeResults,
        }),
      );
    }

    if (
      record.tickResult.startedOperations.length > 0 ||
      record.tickResult.completedOperations.length > 0 ||
      record.telemetry.length > 0
    ) {
      lines.push(
        JSON.stringify({
          kind: "operations",
          t: record.time,
          ...(record.tickResult.startedOperations.length > 0 ? { started: record.tickResult.startedOperations } : {}),
          ...(record.tickResult.completedOperations.length > 0 ? { completed: record.tickResult.completedOperations } : {}),
          ...(record.telemetry.length > 0 ? { telemetry: record.telemetry } : {}),
        }),
      );
    }

    const state = this.toStateRecord(record);
    const stateKey = JSON.stringify({
      o: state.occupancy,
      q: state.queues,
      c: state.counters,
    });
    const isCheckpoint = record.time % this.checkpointIntervalSeconds === 0;

    if (stateKey !== this.lastStateKey || isCheckpoint) {
      lines.push(JSON.stringify(state));
      this.lastStateKey = stateKey;
    }

    if (isCheckpoint) {
      lines.push(
        JSON.stringify({
          kind: "checkpoint",
          t: record.time,
          snapshot: record.afterSnapshot,
        }),
      );
    }

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

  private toStateRecord(record: SimulationSecondRecord): RawSimulationStateRecord {
    return {
      kind: "state",
      t: record.time,
      occupancy: {
        occupiedCount: record.afterSnapshot.occupancy.occupiedCount,
        totalParkingCells: record.afterSnapshot.occupancy.totalParkingCells,
        occupancyPercent: record.afterSnapshot.occupancy.occupancyPercent,
      },
      queues: {
        inboundLength: record.afterSnapshot.queues.inboundLength,
        outboundLength: record.afterSnapshot.queues.outboundLength,
      },
      counters: compactCounters(record.afterSnapshot.counters),
    };
  }
}

function compactCounters(counters: GarageCumulativeCounters): GarageCumulativeCounters {
  return { ...counters };
}
