import type {
  DemandGenerationConfig,
  DemandGenerator,
  GarageStateSnapshot,
  RandomSource,
  SimTime,
  SimulationEvent,
  VehicleId,
} from "../domain/types.js";
import { SeededRandomSource } from "./random.js";

interface ScheduledOutbound {
  time: SimTime;
  vehicleId: VehicleId;
}

export class SeededDemandGenerator implements DemandGenerator {
  private config!: DemandGenerationConfig;
  private rng!: RandomSource;
  private nextVehicleNumber = 1;
  private readonly scheduledOutbounds: ScheduledOutbound[] = [];

  initialize(params: DemandGenerationConfig, seed: number): void {
    this.config = params;
    this.rng = new SeededRandomSource(seed);
  }

  generateEventsAt(time: SimTime, garageState: GarageStateSnapshot): SimulationEvent[] {
    const events: SimulationEvent[] = [];

    const inboundCount = this.samplePoisson(this.inboundLambdaPerSecond(time));
    for (let index = 0; index < inboundCount; index += 1) {
      const vehicleId = `V${this.nextVehicleNumber.toString().padStart(6, "0")}`;
      this.nextVehicleNumber += 1;
      events.push({ id: `evt-${time}-in-${vehicleId}`, time, type: "InboundArrival", vehicleId });
      this.scheduledOutbounds.push({
        time: time + this.sampleParkingDurationSeconds(),
        vehicleId,
      });
    }

    const parkedVehicles = new Set(garageState.occupancy.occupied.map((vehicle) => vehicle.vehicleId));
    for (let index = this.scheduledOutbounds.length - 1; index >= 0; index -= 1) {
      const scheduled = this.scheduledOutbounds[index];
      if (scheduled && scheduled.time <= time) {
        if (parkedVehicles.has(scheduled.vehicleId)) {
          events.push({
            id: `evt-${time}-out-${scheduled.vehicleId}`,
            time,
            type: "OutboundRequest",
            vehicleId: scheduled.vehicleId,
          });
        }
        this.scheduledOutbounds.splice(index, 1);
      }
    }

    return events;
  }

  private inboundLambdaPerSecond(time: SimTime): number {
    const secondsInDay = 24 * 60 * 60;
    const secondOfDay = time % secondsInDay;
    const hour = secondOfDay / 3600;
    const baseDaily = this.config.averageInboundPerDay;
    const peakStart = this.config.peakHour - this.config.peakWindowHours / 2;
    const peakEnd = this.config.peakHour + this.config.peakWindowHours / 2;
    const inPeak = hour >= peakStart && hour < peakEnd;

    if (inPeak) {
      return (baseDaily * this.config.peakShare) / (this.config.peakWindowHours * 3600);
    }

    const offPeakSeconds = secondsInDay - this.config.peakWindowHours * 3600;
    return (baseDaily * (1 - this.config.peakShare)) / offPeakSeconds;
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
