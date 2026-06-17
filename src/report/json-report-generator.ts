import { writeFile } from "node:fs/promises";
import type {
  DailyReportMetrics,
  RawSimulationOutputRef,
  ReportConfig,
  ReportGenerator,
  SimulationReport,
  ThirtyDayReportSummary,
} from "../domain/types.js";
import { JsonlRawSimulationReader } from "./jsonl-raw-simulation-reader.js";
import { DailyMetricsAggregator } from "./metrics-aggregator.js";

type NumericReportField = keyof Omit<DailyReportMetrics, "dayIndex" | "dateOfMonth" | "date" | "dayOfWeek">;

const numericFields: NumericReportField[] = [
  "successfulActivities",
  "vehiclesStayingUntilMidnight",
  "averageInboundWaitSeconds",
  "averageOutboundWaitSeconds",
  "averageInboundWaitSecondsDuringMorningPeak",
  "averageOutboundWaitSecondsDuringEveningPeak",
  "longestInboundWaitSeconds",
  "longestOutboundWaitSeconds",
  "biggestInboundQueueLength",
  "biggestOutboundQueueLength",
  "inboundBalkingVehicles",
  "balkingOverSuccessfulInboundPercent",
  "maximumOccupancyPercent",
  "elevatorTripsCarryingInducedInboundVehicles",
  "totalInducedInboundVehicles",
  "idleUnblockingActions",
  "idleUnblockedVehicles",
  "downwardTripPlacements",
  "totalParkingHours",
  "totalCollectableParkingHours",
  "totalElevatorFloorsPassed",
  "totalVmrDistanceMeters",
  "totalRevenue",
];

export class JsonReportGenerator implements ReportGenerator {
  async generate(rawOutput: RawSimulationOutputRef, _config: ReportConfig): Promise<SimulationReport> {
    const reader = new JsonlRawSimulationReader(rawOutput);
    const metadata = await reader.readMetadata();
    const records = await reader.readRecords();
    const aggregator = new DailyMetricsAggregator(metadata.config);

    for (const record of records) {
      aggregator.consumeRecord(record);
    }

    const daily = aggregator.finalize();
    return {
      sessionId: metadata.sessionId,
      generatedAt: new Date().toISOString(),
      source: rawOutput,
      simulationStartTime: metadata.config.simulation.startTime,
      timezone: metadata.config.simulation.timezone,
      daily,
      thirtyDaySummary: summarizeDailyMetrics(daily),
    };
  }

  async write(report: SimulationReport, destination: string): Promise<void> {
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

function summarizeDailyMetrics(daily: DailyReportMetrics[]): ThirtyDayReportSummary {
  const sum = zeroSummary();
  const average = zeroSummary();

  for (const day of daily) {
    for (const field of numericFields) {
      sum[field] += day[field];
    }
  }

  const denominator = Math.max(1, daily.length);
  for (const field of numericFields) {
    average[field] = round(sum[field] / denominator, 4);
    sum[field] = round(sum[field], 4);
  }

  return { sum, average };
}

function zeroSummary(): ThirtyDayReportSummary["sum"] {
  return {
    successfulActivities: 0,
    vehiclesStayingUntilMidnight: 0,
    averageInboundWaitSeconds: 0,
    averageOutboundWaitSeconds: 0,
    averageInboundWaitSecondsDuringMorningPeak: 0,
    averageOutboundWaitSecondsDuringEveningPeak: 0,
    longestInboundWaitSeconds: 0,
    longestOutboundWaitSeconds: 0,
    biggestInboundQueueLength: 0,
    biggestOutboundQueueLength: 0,
    inboundBalkingVehicles: 0,
    balkingOverSuccessfulInboundPercent: 0,
    maximumOccupancyPercent: 0,
    elevatorTripsCarryingInducedInboundVehicles: 0,
    totalInducedInboundVehicles: 0,
    idleUnblockingActions: 0,
    idleUnblockedVehicles: 0,
    downwardTripPlacements: 0,
    totalParkingHours: 0,
    totalCollectableParkingHours: 0,
    totalElevatorFloorsPassed: 0,
    totalVmrDistanceMeters: 0,
    totalRevenue: 0,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
