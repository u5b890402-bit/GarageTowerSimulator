import type {
  GarageCumulativeCounters,
  RawSimulationCheckpointRecord,
  RawSimulationDataRecord,
  RawSimulationEventsRecord,
  RawSimulationOperationsRecord,
  RawSimulationStateRecord,
  SimulationSecondRecord,
} from "../domain/types.js";

export const defaultCheckpointIntervalSeconds = 300;

export function buildCompactRecords(
  record: SimulationSecondRecord,
  previousStateKey: string,
  checkpointIntervalSeconds = defaultCheckpointIntervalSeconds,
): {
  records: RawSimulationDataRecord[];
  stateKey: string;
} {
  const records: RawSimulationDataRecord[] = [];

  if (record.generatedEvents.length > 0 || record.intakeResults.length > 0) {
    const events: RawSimulationEventsRecord = {
      kind: "events",
      t: record.time,
      generated: record.generatedEvents,
      intake: record.intakeResults,
    };
    records.push(events);
  }

  if (
    record.tickResult.startedOperations.length > 0 ||
    record.tickResult.completedOperations.length > 0 ||
    record.telemetry.length > 0
  ) {
    const operations: RawSimulationOperationsRecord = {
      kind: "operations",
      t: record.time,
      ...(record.tickResult.startedOperations.length > 0 ? { started: record.tickResult.startedOperations } : {}),
      ...(record.tickResult.completedOperations.length > 0 ? { completed: record.tickResult.completedOperations } : {}),
      ...(record.telemetry.length > 0 ? { telemetry: record.telemetry } : {}),
    };
    records.push(operations);
  }

  const state = toStateRecord(record);
  const stateKey = buildStateKey(state);
  const isCheckpoint = record.time % checkpointIntervalSeconds === 0;

  if (stateKey !== previousStateKey || isCheckpoint) {
    records.push(state);
  }

  if (isCheckpoint) {
    const checkpoint: RawSimulationCheckpointRecord = {
      kind: "checkpoint",
      t: record.time,
      snapshot: record.afterSnapshot,
    };
    records.push(checkpoint);
  }

  return { records, stateKey };
}

function toStateRecord(record: SimulationSecondRecord): RawSimulationStateRecord {
  return {
    kind: "state",
    t: record.time,
    occupancy: {
      occupiedCount: record.afterSnapshot.occupancy.occupiedCount,
      reservedCount: record.afterSnapshot.occupancy.reservedCount ?? 0,
      effectiveOccupiedCount:
        record.afterSnapshot.occupancy.effectiveOccupiedCount ??
        record.afterSnapshot.occupancy.occupiedCount,
      totalParkingCells: record.afterSnapshot.occupancy.totalParkingCells,
      occupancyPercent: record.afterSnapshot.occupancy.occupancyPercent,
      effectiveOccupancyPercent:
        record.afterSnapshot.occupancy.effectiveOccupancyPercent ??
        record.afterSnapshot.occupancy.occupancyPercent,
    },
    queues: {
      inboundLength: record.afterSnapshot.queues.inboundLength,
      outboundLength: record.afterSnapshot.queues.outboundLength,
    },
    counters: compactCounters(record.afterSnapshot.counters),
  };
}

function buildStateKey(state: RawSimulationStateRecord): string {
  return JSON.stringify({
    o: state.occupancy,
    q: state.queues,
    c: state.counters,
  });
}

function compactCounters(counters: GarageCumulativeCounters): GarageCumulativeCounters {
  return { ...counters };
}
