import type {
  DemandGenerationConfig,
  DemandGenerator,
  EventAcceptanceResult,
  GarageStateSnapshot,
  RandomSource,
  SimTime,
  SimulationEvent,
  SimulationRuntimeConfig,
  VehicleId,
} from "../domain/types.js";
import { SeededRandomSource } from "./random.js";

interface ScheduledOutbound {
  inboundEventId: string;
  time: SimTime;
  vehicleId: VehicleId;
}

export class SeededDemandGenerator implements DemandGenerator {
  private config!: DemandGenerationConfig;
  private runtime!: SimulationRuntimeConfig;
  private rng!: RandomSource;
  private nextVehicleNumber = 1;
  private readonly futureOutbounds: ScheduledOutbound[] = [];
  private readonly dueOutbounds = new Map<VehicleId, ScheduledOutbound>();
  private readonly canceledInboundEventIds = new Set<string>();
  private startLocalSecondOfDay = 0;
  private readonly weekendByDayOffset = new Map<number, boolean>();

  initialize(params: DemandGenerationConfig, runtime: SimulationRuntimeConfig, seed: number): void {
    this.config = params;
    this.runtime = runtime;
    this.rng = new SeededRandomSource(seed);
    this.startLocalSecondOfDay = this.getStartLocalSecondOfDay();
    this.futureOutbounds.length = 0;
    this.dueOutbounds.clear();
    this.canceledInboundEventIds.clear();
    this.weekendByDayOffset.clear();
    this.nextVehicleNumber = 1;
  }

  generateEventsAt(time: SimTime, garageState: GarageStateSnapshot): SimulationEvent[] {
    const events: SimulationEvent[] = [];

    const inboundCount = this.samplePoisson(this.inboundLambdaPerSecond(time));
    for (let index = 0; index < inboundCount; index += 1) {
      const vehicleId = `V${this.nextVehicleNumber.toString().padStart(6, "0")}`;
      this.nextVehicleNumber += 1;
      const inboundEventId = `evt-${time}-in-${vehicleId}`;
      events.push({ id: inboundEventId, time, type: "InboundArrival", vehicleId });
      this.insertFutureOutbound({
        inboundEventId,
        time: time + this.sampleParkingDurationSeconds(),
        vehicleId,
      });
    }

    const parkedVehicles = new Set(garageState.occupancy.occupied.map((vehicle) => vehicle.vehicleId));
    while (this.futureOutbounds[0]?.time !== undefined && this.futureOutbounds[0].time <= time) {
      const scheduled = this.futureOutbounds.shift();
      if (!scheduled) break;
      if (this.canceledInboundEventIds.delete(scheduled.inboundEventId)) {
        continue;
      }
      this.dueOutbounds.set(scheduled.vehicleId, scheduled);
    }

    for (const [vehicleId] of this.dueOutbounds) {
      if (parkedVehicles.has(vehicleId)) {
        events.push({
          id: `evt-${time}-out-${vehicleId}`,
          time,
          type: "OutboundRequest",
          vehicleId,
        });
        this.dueOutbounds.delete(vehicleId);
      }
    }

    return events;
  }

  recordIntakeResults(results: EventAcceptanceResult[]): void {
    const rejectedInboundEventIds = new Set(
      results
        .filter(
          (result) =>
            !result.accepted &&
            (result.outcome === "Balked" || result.outcome === "RejectedGarageFull"),
        )
        .map((result) => result.eventId),
    );

    for (const result of results) {
      if (!rejectedInboundEventIds.has(result.eventId)) continue;
      const removedFromDueQueue = this.dueOutbounds.delete(result.vehicleId);
      if (!removedFromDueQueue) {
        this.canceledInboundEventIds.add(result.eventId);
      }
    }
  }

  private insertFutureOutbound(outbound: ScheduledOutbound): void {
    let low = 0;
    let high = this.futureOutbounds.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const middleTime = this.futureOutbounds[middle]?.time ?? Number.POSITIVE_INFINITY;
      if (middleTime <= outbound.time) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    this.futureOutbounds.splice(low, 0, outbound);
  }

  private inboundLambdaPerSecond(time: SimTime): number {
    const secondsInDay = 24 * 60 * 60;
    const localElapsedSeconds = this.startLocalSecondOfDay + time;
    const dayOffset = Math.floor(localElapsedSeconds / secondsInDay);
    const secondOfDay = ((localElapsedSeconds % secondsInDay) + secondsInDay) % secondsInDay;
    const hour = secondOfDay / 3600;
    const dailyMultiplier = this.isWeekend(dayOffset) ? this.config.weekendMultiplier : 1;
    const baseDaily = this.config.averageInboundPerDay * dailyMultiplier;
    const peakStart = this.config.peakHour - this.config.peakWindowHours / 2;
    const peakEnd = this.config.peakHour + this.config.peakWindowHours / 2;
    const inPeak = hour >= peakStart && hour < peakEnd;

    if (inPeak) {
      return (baseDaily * this.config.peakShare) / (this.config.peakWindowHours * 3600);
    }

    const offPeakSeconds = secondsInDay - this.config.peakWindowHours * 3600;
    return (baseDaily * (1 - this.config.peakShare)) / offPeakSeconds;
  }

  private isWeekend(dayOffset: number): boolean {
    const cached = this.weekendByDayOffset.get(dayOffset);
    if (cached !== undefined) return cached;

    const start = new Date(this.runtime.startTime);
    const localMiddayMilliseconds =
      start.getTime() +
      (dayOffset * 24 * 60 * 60 - this.startLocalSecondOfDay + 12 * 60 * 60) * 1000;
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: this.runtime.timezone,
      weekday: "short",
    }).format(new Date(localMiddayMilliseconds));
    const weekend = weekday === "Sat" || weekday === "Sun";
    this.weekendByDayOffset.set(dayOffset, weekend);
    return weekend;
  }

  private getStartLocalSecondOfDay(): number {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.runtime.timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(this.runtime.startTime));
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return value("hour") * 3600 + value("minute") * 60 + value("second");
  }

  private samplePoisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const threshold = Math.exp(-lambda);
    let count = 0;
    let product = 1;
    do {
      count += 1;
      product *= this.rng.nextFloat();
    } while (product > threshold);
    return count - 1;
  }

  private sampleParkingDurationSeconds(): number {
    const { minHours, maxHours, modeHours } = this.config.parkingDuration;
    const left = this.rng.nextFloat();
    const right = this.rng.nextFloat();
    const triangularHours = minHours + (modeHours - minHours) * left + (maxHours - modeHours) * right;
    const bounded = Math.max(minHours, Math.min(maxHours, triangularHours));
    return Math.round(bounded * 3600);
  }
}
