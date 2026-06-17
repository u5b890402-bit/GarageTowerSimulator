import type {
  RawSimulationDataRecord,
  RawSimulationMetadata,
  RawSimulationOutputRef,
  SimulationReport,
} from "../domain/types.js";
import { DailyMetricsAggregator } from "./metrics-aggregator.js";
import { summarizeDailyMetrics } from "./summary.js";

export function buildReportFromRecords(
  metadata: RawSimulationMetadata,
  records: RawSimulationDataRecord[],
  source: RawSimulationOutputRef,
): SimulationReport {
  const aggregator = new DailyMetricsAggregator(metadata.config);

  for (const record of records) {
    aggregator.consumeRecord(record);
  }

  const daily = aggregator.finalize();
  return {
    sessionId: metadata.sessionId,
    generatedAt: new Date().toISOString(),
    source,
    simulationStartTime: metadata.config.simulation.startTime,
    timezone: metadata.config.simulation.timezone,
    daily,
    thirtyDaySummary: summarizeDailyMetrics(daily),
  };
}
