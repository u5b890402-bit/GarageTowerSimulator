import type {
  DailyReportMetrics,
  EventAcceptanceResult,
  GarageCumulativeCounters,
  GarageCompletedOperation,
  RawSimulationDataRecord,
  MetricsAggregator,
  RevenuePolicyConfig,
  SimulationConfig,
  SimulationEvent,
  SimulationSecondRecord,
  SimTime,
  VehicleId,
} from "../domain/types.js";

interface DailyAccumulator {
  dayIndex: number;
  date: string;
  dateOfMonth: number;
  dayOfWeek: string;
  successfulActivities: number;
  vehiclesStayingUntilMidnight: number;
  inboundWaitSeconds: number[];
  outboundWaitSeconds: number[];
  morningPeakInboundWaitSeconds: number[];
  eveningPeakOutboundWaitSeconds: number[];
  biggestInboundQueueLength: number;
  biggestOutboundQueueLength: number;
  inboundBalkingVehicles: number;
  maximumOccupancyPercent: number;
  elevatorTripsCarryingInducedInboundVehicles: number;
  totalInducedInboundVehicles: number;
  idleUnblockingActions: number;
  idleUnblockedVehicles: number;
  downwardTripPlacements: number;
  totalParkingHours: number;
  totalCollectableParkingHours: number;
  totalElevatorFloorsPassed: number;
  totalVmrDistanceMeters: number;
  totalRevenue: number;
}

export class DailyMetricsAggregator implements MetricsAggregator {
  private readonly byDay = new Map<number, DailyAccumulator>();
  private readonly inboundEventTimeByVehicle = new Map<VehicleId, SimTime>();
  private readonly outboundRequestTimeByVehicle = new Map<VehicleId, SimTime>();
  private readonly parkedAtByVehicle = new Map<VehicleId, SimTime>();
  private lastCounterSnapshot: GarageCumulativeCounters | null = null;

  constructor(private readonly config: SimulationConfig) {}

  consumeRecord(record: RawSimulationDataRecord): void {
    if (record.kind === "second") {
      this.consumeSecond(record.record);
      return;
    }

    const day = this.getDay(record.t);

    if (record.kind === "events") {
      this.captureGeneratedEvents(record.generated);
      this.captureIntakeResults(record.intake, day);
      return;
    }

    if (record.kind === "operations") {
      this.captureCompletedOperations(record.t, record.completed ?? [], day);
      return;
    }

    if (record.kind === "state") {
      this.captureStateRecord(record, day);
      return;
    }

    this.captureCheckpoint(record, day);
  }

  private consumeSecond(record: SimulationSecondRecord): void {
    const day = this.getDay(record.time);
    this.captureGeneratedEvents(record.generatedEvents);
    this.captureIntakeResults(record.intakeResults, day);
    this.captureCompletedOperations(record.time, record.tickResult.completedOperations, day);
    this.captureSnapshot(record.afterSnapshot.occupancy.occupiedCount, record.afterSnapshot.queues.inboundLength, record.afterSnapshot.queues.outboundLength, record.afterSnapshot.occupancy.occupancyPercent, record.afterSnapshot.counters, day);
  }

  finalize(): DailyReportMetrics[] {
    return [...this.byDay.values()]
      .sort((a, b) => a.dayIndex - b.dayIndex)
      .map((day) => ({
        dayIndex: day.dayIndex,
        dateOfMonth: day.dateOfMonth,
        date: day.date,
        dayOfWeek: day.dayOfWeek,
        successfulActivities: day.successfulActivities,
        vehiclesStayingUntilMidnight: day.vehiclesStayingUntilMidnight,
        averageInboundWaitSeconds: average(day.inboundWaitSeconds),
        averageOutboundWaitSeconds: average(day.outboundWaitSeconds),
        averageInboundWaitSecondsDuringMorningPeak: average(day.morningPeakInboundWaitSeconds),
        averageOutboundWaitSecondsDuringEveningPeak: average(day.eveningPeakOutboundWaitSeconds),
        longestInboundWaitSeconds: max(day.inboundWaitSeconds),
        longestOutboundWaitSeconds: max(day.outboundWaitSeconds),
        biggestInboundQueueLength: day.biggestInboundQueueLength,
        biggestOutboundQueueLength: day.biggestOutboundQueueLength,
        inboundBalkingVehicles: day.inboundBalkingVehicles,
        balkingOverSuccessfulInboundPercent:
          day.successfulActivities === 0 ? 0 : (day.inboundBalkingVehicles / Math.max(1, this.countSuccessfulInbound(day))) * 100,
        maximumOccupancyPercent: day.maximumOccupancyPercent,
        elevatorTripsCarryingInducedInboundVehicles: day.elevatorTripsCarryingInducedInboundVehicles,
        totalInducedInboundVehicles: day.totalInducedInboundVehicles,
        idleUnblockingActions: day.idleUnblockingActions,
        idleUnblockedVehicles: day.idleUnblockedVehicles,
        downwardTripPlacements: day.downwardTripPlacements,
        totalParkingHours: round(day.totalParkingHours, 4),
        totalCollectableParkingHours: round(day.totalCollectableParkingHours, 4),
        totalElevatorFloorsPassed: day.totalElevatorFloorsPassed,
        totalVmrDistanceMeters: round(day.totalVmrDistanceMeters, 4),
        totalRevenue: round(day.totalRevenue, 2),
      }));
  }

  private captureGeneratedEvents(events: SimulationEvent[]): void {
    for (const event of events) {
      if (event.type === "InboundArrival") {
        this.inboundEventTimeByVehicle.set(event.vehicleId, event.time);
      } else {
        this.outboundRequestTimeByVehicle.set(event.vehicleId, event.time);
      }
    }
  }

  private captureIntakeResults(results: EventAcceptanceResult[], day: DailyAccumulator): void {
    for (const result of results) {
      if (result.outcome === "Balked") {
        day.inboundBalkingVehicles += 1;
      }
    }
  }

  private captureCompletedOperations(time: SimTime, operations: GarageCompletedOperation[], day: DailyAccumulator): void {
    for (const operation of operations) {
      if (!operation.vehicleId) continue;

      if (operation.type === "ParkInbound") {
        day.successfulActivities += 1;
        const arrivalTime = this.inboundEventTimeByVehicle.get(operation.vehicleId);
        if (arrivalTime !== undefined) {
          const waitSeconds = time - arrivalTime;
          day.inboundWaitSeconds.push(waitSeconds);
          if (this.isHourWindow(arrivalTime, 8, 10)) {
            day.morningPeakInboundWaitSeconds.push(waitSeconds);
          }
        }
        this.parkedAtByVehicle.set(operation.vehicleId, time);
      }

      if (operation.type === "RetrieveOutbound") {
        day.successfulActivities += 1;
        const requestTime = this.outboundRequestTimeByVehicle.get(operation.vehicleId);
        if (requestTime !== undefined) {
          const waitSeconds = time - requestTime;
          day.outboundWaitSeconds.push(waitSeconds);
          if (this.isHourWindow(requestTime, 16, 18)) {
            day.eveningPeakOutboundWaitSeconds.push(waitSeconds);
          }
        }

        const parkedAt = this.parkedAtByVehicle.get(operation.vehicleId);
        if (parkedAt !== undefined) {
          const parkingSeconds = Math.max(0, time - parkedAt);
          const collectableHours = this.collectableParkingHours(parkingSeconds, this.config.simulation.revenuePolicy);
          day.totalParkingHours += parkingSeconds / 3600;
          day.totalCollectableParkingHours += collectableHours;
          day.totalRevenue += collectableHours * (60 / this.config.simulation.revenuePolicy.billingBlockMinutes) * this.config.simulation.revenuePolicy.chargePerBillingBlock;
          this.parkedAtByVehicle.delete(operation.vehicleId);
        }
      }
    }
  }

  private captureStateRecord(record: Extract<RawSimulationDataRecord, { kind: "state" }>, day: DailyAccumulator): void {
    this.captureSnapshot(
      record.occupancy.occupiedCount,
      record.queues.inboundLength,
      record.queues.outboundLength,
      record.occupancy.occupancyPercent,
      record.counters,
      day,
    );
  }

  private captureCheckpoint(record: Extract<RawSimulationDataRecord, { kind: "checkpoint" }>, day: DailyAccumulator): void {
    this.captureSnapshot(
      record.snapshot.occupancy.occupiedCount,
      record.snapshot.queues.inboundLength,
      record.snapshot.queues.outboundLength,
      record.snapshot.occupancy.occupancyPercent,
      record.snapshot.counters,
      day,
    );
  }

  private captureSnapshot(
    occupiedCount: number,
    inboundQueueLength: number,
    outboundQueueLength: number,
    occupancyPercent: number,
    counters: GarageCumulativeCounters,
    day: DailyAccumulator,
  ): void {
    day.vehiclesStayingUntilMidnight = occupiedCount;
    day.biggestInboundQueueLength = Math.max(day.biggestInboundQueueLength, inboundQueueLength);
    day.biggestOutboundQueueLength = Math.max(day.biggestOutboundQueueLength, outboundQueueLength);
    day.maximumOccupancyPercent = Math.max(day.maximumOccupancyPercent, occupancyPercent * 100);

    if (this.lastCounterSnapshot) {
      day.totalElevatorFloorsPassed += positiveDelta(counters.elevatorFloorsPassed, this.lastCounterSnapshot.elevatorFloorsPassed);
      day.totalVmrDistanceMeters += positiveDelta(counters.vmrDistanceMeters, this.lastCounterSnapshot.vmrDistanceMeters);
      day.elevatorTripsCarryingInducedInboundVehicles += positiveDelta(
        counters.inducedInboundTrips,
        this.lastCounterSnapshot.inducedInboundTrips,
      );
      day.totalInducedInboundVehicles += positiveDelta(counters.inducedInboundVehicles, this.lastCounterSnapshot.inducedInboundVehicles);
      day.idleUnblockingActions += positiveDelta(counters.idleUnblockingActions, this.lastCounterSnapshot.idleUnblockingActions);
      day.idleUnblockedVehicles += positiveDelta(counters.idleUnblockedVehicles, this.lastCounterSnapshot.idleUnblockedVehicles);
      day.downwardTripPlacements += positiveDelta(counters.downwardTripPlacements, this.lastCounterSnapshot.downwardTripPlacements);
    } else {
      day.totalElevatorFloorsPassed += counters.elevatorFloorsPassed;
      day.totalVmrDistanceMeters += counters.vmrDistanceMeters;
      day.elevatorTripsCarryingInducedInboundVehicles += counters.inducedInboundTrips;
      day.totalInducedInboundVehicles += counters.inducedInboundVehicles;
      day.idleUnblockingActions += counters.idleUnblockingActions;
      day.idleUnblockedVehicles += counters.idleUnblockedVehicles;
      day.downwardTripPlacements += counters.downwardTripPlacements;
    }

    this.lastCounterSnapshot = { ...counters };
  }

  private getDay(time: SimTime): DailyAccumulator {
    const dayIndex = Math.floor(time / 86400) + 1;
    const existing = this.byDay.get(dayIndex);
    if (existing) return existing;

    const date = this.dateForTime(time);
    const day: DailyAccumulator = {
      dayIndex,
      date,
      dateOfMonth: Number(this.formatDatePart(time, "day")),
      dayOfWeek: this.formatDatePart(time, "weekday"),
      successfulActivities: 0,
      vehiclesStayingUntilMidnight: 0,
      inboundWaitSeconds: [],
      outboundWaitSeconds: [],
      morningPeakInboundWaitSeconds: [],
      eveningPeakOutboundWaitSeconds: [],
      biggestInboundQueueLength: 0,
      biggestOutboundQueueLength: 0,
      inboundBalkingVehicles: 0,
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
    this.byDay.set(dayIndex, day);
    return day;
  }

  private countSuccessfulInbound(day: DailyAccumulator): number {
    return day.inboundWaitSeconds.length;
  }

  private collectableParkingHours(parkingSeconds: number, policy: RevenuePolicyConfig): number {
    const blocks = Math.ceil(parkingSeconds / (policy.billingBlockMinutes * 60));
    return (blocks * policy.billingBlockMinutes) / 60;
  }

  private isHourWindow(time: SimTime, startHour: number, endHour: number): boolean {
    const hour = Number(this.formatDatePart(time, "hour"));
    return hour >= startHour && hour < endHour;
  }

  private dateForTime(time: SimTime): string {
    const date = this.absoluteDate(time);
    const year = this.formatDatePart(time, "year");
    const month = this.formatDatePart(time, "month").padStart(2, "0");
    const day = this.formatDatePart(time, "day").padStart(2, "0");
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid simulation start time: ${this.config.simulation.startTime}`);
    }
    return `${year}-${month}-${day}`;
  }

  private formatDatePart(time: SimTime, part: "year" | "month" | "day" | "weekday" | "hour"): string {
    const date = this.absoluteDate(time);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.simulation.timezone,
      year: part === "year" ? "numeric" : undefined,
      month: part === "month" ? "2-digit" : undefined,
      day: part === "day" ? "2-digit" : undefined,
      weekday: part === "weekday" ? "long" : undefined,
      hour: part === "hour" ? "2-digit" : undefined,
      hour12: false,
    });
    return formatter.format(date);
  }

  private absoluteDate(time: SimTime): Date {
    return new Date(new Date(this.config.simulation.startTime).getTime() + time * 1000);
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
}

function max(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function positiveDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
