import type { DailyReportMetrics, ThirtyDayReportSummary } from "../domain/types.js";

type NumericReportField = keyof Omit<DailyReportMetrics, "dayIndex" | "dateOfMonth" | "date" | "dayOfWeek">;

const numericFields: NumericReportField[] = [
  "successfulActivities",
  "vehiclesStayingUntilMidnight",
  "averageInboundDriverWaitingSeconds",
  "averageInboundWaitSeconds",
  "averageOutboundWaitSeconds",
  "averageInboundDriverWaitingSecondsDuringMorningPeak",
  "averageInboundWaitSecondsDuringMorningPeak",
  "averageOutboundWaitSecondsDuringEveningPeak",
  "longestInboundDriverWaitingSeconds",
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

export function summarizeDailyMetrics(daily: DailyReportMetrics[]): ThirtyDayReportSummary {
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
    averageInboundDriverWaitingSeconds: 0,
    averageInboundWaitSeconds: 0,
    averageOutboundWaitSeconds: 0,
    averageInboundDriverWaitingSecondsDuringMorningPeak: 0,
    averageInboundWaitSecondsDuringMorningPeak: 0,
    averageOutboundWaitSecondsDuringEveningPeak: 0,
    longestInboundDriverWaitingSeconds: 0,
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
