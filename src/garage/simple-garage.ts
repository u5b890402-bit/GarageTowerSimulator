import type {
  CapacityInfo,
  CellOccupancy,
  EventAcceptanceResult,
  GarageCompletedOperation,
  GarageConfig,
  GarageCumulativeCounters,
  GarageEventIntakeContext,
  GarageOperation,
  GarageStateSnapshot,
  GarageStrategySet,
  GarageTickContext,
  GarageTickResult,
  GarageTowerSystem,
  PreparationPositionState,
  QueuedVehicle,
  SimTime,
  VehicleId,
  VmrState,
} from "../domain/types.js";
import { GridGarageLayout } from "./grid-layout.js";

interface ParkedVehicleRecord {
  vehicleId: VehicleId;
  cellId: string;
  parkedAt: SimTime;
}

export class SimpleGarageTowerSystem implements GarageTowerSystem {
  private layout!: GridGarageLayout;
  private config!: GarageConfig;
  private inboundQueue: QueuedVehicle[] = [];
  private outboundQueue: QueuedVehicle[] = [];
  private parked = new Map<VehicleId, ParkedVehicleRecord>();
  private requestedOutbound = new Set<VehicleId>();
  private preparationPositions: PreparationPositionState[] = [];
  private activeOperation: GarageOperation | null = null;
  private operationDuration = 0;
  private vmrs: VmrState[] = [];
  private counters: GarageCumulativeCounters = {
    inboundAccepted: 0,
    outboundAccepted: 0,
    inboundBalked: 0,
    inboundCompleted: 0,
    outboundCompleted: 0,
    rejectedEvents: 0,
    maxInboundQueueLength: 0,
    maxOutboundQueueLength: 0,
    elevatorFloorsPassed: 0,
    vmrDistanceMeters: 0,
    inducedInboundTrips: 0,
    inducedInboundVehicles: 0,
    idleUnblockingActions: 0,
    idleUnblockedVehicles: 0,
    downwardTripPlacements: 0,
  };

  constructor(private readonly strategies: GarageStrategySet) {}

  initialize(config: GarageConfig): void {
    this.config = config;
    this.layout = new GridGarageLayout(config.layout);
    this.preparationPositions = [
      ...Array.from({ length: config.preparationPositions.inboundCount }, (_, index) => ({
        id: `IPP${index + 1}`,
        direction: "inbound" as const,
      })),
      ...Array.from({ length: config.preparationPositions.outboundCount }, (_, index) => ({
        id: `OPP${index + 1}`,
        direction: "outbound" as const,
      })),
    ];
    this.vmrs = Array.from({ length: config.elevator.deckCount }, (_, index) => ({
      id: `VMR${index + 1}`,
      deckId: `D${index + 1}`,
      status: "Idle",
      distanceMovedMeters: 0,
    }));
  }

  submitEvents(context: GarageEventIntakeContext): EventAcceptanceResult[] {
    const results: EventAcceptanceResult[] = [];

    for (const event of context.events) {
      if (event.type === "InboundArrival") {
        results.push(this.submitInbound(event.id, event.vehicleId, context));
      } else {
        results.push(this.submitOutbound(event.id, event.vehicleId, context.time));
      }
    }

    this.updateMaxQueues();
    return results;
  }

  updateOneSecond(context: GarageTickContext): GarageTickResult {
    this.clearReadyOutboundPreparationPositions(context.time);
    this.fillInboundPreparationPositions(context.time);

    const completedOperations: GarageCompletedOperation[] = [];
    if (this.activeOperation && context.time >= this.activeOperation.completesAt) {
      completedOperations.push(this.completeActiveOperation(context.time));
    }

    const startedOperations: GarageOperation[] = [];
    if (!this.activeOperation) {
      const nextOperation = this.startNextOperation(context);
      if (nextOperation) {
        startedOperations.push(nextOperation);
      }
    }

    this.updateMaxQueues();
    return { completedOperations, startedOperations };
  }

  getSnapshot(): GarageStateSnapshot {
    const occupancy = this.getOccupancy();
    const elevator = {
      status: this.activeOperation ? "Busy" as const : "IdleAtHome" as const,
      currentFloor: this.activeOperation ? this.estimateOperationFloor(this.activeOperation) : 1,
      deckCount: this.config.elevator.deckCount,
      ...(this.activeOperation ? { activeOperationId: this.activeOperation.id } : {}),
    };

    return {
      time: 0,
      occupancy,
      queues: {
        inbound: [...this.inboundQueue],
        outbound: [...this.outboundQueue],
        inboundLength: this.inboundQueue.length,
        outboundLength: this.outboundQueue.length,
      },
      elevator,
      preparationPositions: this.preparationPositions.map((position) => ({ ...position })),
      vmrs: this.vmrs.map((vmr) => ({ ...vmr })),
      counters: { ...this.counters },
      activeOperations: this.activeOperation ? [{ ...this.activeOperation }] : [],
    };
  }

  isIdle(): boolean {
    return !this.activeOperation && this.inboundQueue.length === 0 && this.outboundQueue.length === 0;
  }

  getCapacity(): CapacityInfo {
    const totalParkingCells = this.layout.getParkingCells().length;
    return {
      totalParkingCells,
      occupiedParkingCells: this.parked.size,
      availableParkingCells: totalParkingCells - this.parked.size,
    };
  }

  private submitInbound(
    eventId: string,
    vehicleId: VehicleId,
    context: GarageEventIntakeContext,
  ): EventAcceptanceResult {
    const capacity = this.getCapacity();
    const inboundInSystem = this.inboundQueue.length + this.occupiedInboundPreparationPositions().length;
    if (capacity.availableParkingCells <= inboundInSystem) {
      this.counters.rejectedEvents += 1;
      return {
        eventId,
        vehicleId,
        accepted: false,
        outcome: "RejectedGarageFull",
        reason: "No parking cell is available for another inbound vehicle.",
      };
    }

    const queueLengthExcludingPps = this.inboundQueue.length;
    if (this.shouldBalk(queueLengthExcludingPps, context)) {
      this.counters.inboundBalked += 1;
      return {
        eventId,
        vehicleId,
        accepted: false,
        outcome: "Balked",
        reason: "Inbound queue exceeded balking threshold.",
      };
    }

    this.inboundQueue.push({ vehicleId, queuedAt: context.time });
    this.counters.inboundAccepted += 1;
    return {
      eventId,
      vehicleId,
      accepted: true,
      outcome: "QueuedInbound",
      queuePosition: this.inboundQueue.length,
    };
  }

  private submitOutbound(eventId: string, vehicleId: VehicleId, time: SimTime): EventAcceptanceResult {
    if (!this.parked.has(vehicleId)) {
      this.counters.rejectedEvents += 1;
      return {
        eventId,
        vehicleId,
        accepted: false,
        outcome: "RejectedUnknownVehicle",
        reason: "Vehicle is not currently parked.",
      };
    }

    if (this.requestedOutbound.has(vehicleId)) {
      this.counters.rejectedEvents += 1;
      return {
        eventId,
        vehicleId,
        accepted: false,
        outcome: "RejectedDuplicateOutboundRequest",
        reason: "Vehicle already has an outbound request.",
      };
    }

    this.requestedOutbound.add(vehicleId);
    this.outboundQueue.push({ vehicleId, queuedAt: time });
    this.counters.outboundAccepted += 1;
    return {
      eventId,
      vehicleId,
      accepted: true,
      outcome: "QueuedOutbound",
      queuePosition: this.outboundQueue.length,
    };
  }

  private startNextOperation(context: GarageTickContext): GarageOperation | null {
    const readyInbound = this.preparationPositions.find(
      (position) => position.direction === "inbound" && position.occupiedBy && (position.readyAt ?? 0) <= context.time,
    );
    if (readyInbound?.occupiedBy) {
      return this.startParkingOperation(readyInbound, context);
    }

    if (this.outboundQueue.length > 0) {
      return this.startRetrievalOperation(context);
    }

    return null;
  }

  private startParkingOperation(position: PreparationPositionState, context: GarageTickContext): GarageOperation | null {
    const vehicleId = position.occupiedBy;
    if (!vehicleId) return null;

    const cellId = this.strategies.placementStrategy.chooseCell(
      vehicleId,
      { time: context.time, layout: this.layout, occupancy: this.getOccupancy() },
      context.rng,
    );
    if (!cellId) return null;

    delete position.occupiedBy;
    delete position.readyAt;

    const duration = this.estimateParkingSeconds(cellId);
    const operation: GarageOperation = {
      id: `op-${context.time}-${vehicleId}`,
      type: "ParkInbound",
      vehicleId,
      startedAt: context.time,
      completesAt: context.time + duration,
      from: position.id,
      to: cellId,
    };
    this.activateOperation(operation, duration, cellId);
    context.telemetry.recordOperation({
      time: context.time,
      type: "ParkInboundStarted",
      vehicleId,
      detail: { cellId, duration },
    });
    return operation;
  }

  private startRetrievalOperation(context: GarageTickContext): GarageOperation | null {
    const next = this.outboundQueue.shift();
    if (!next) return null;

    const parked = this.parked.get(next.vehicleId);
    if (!parked) {
      this.requestedOutbound.delete(next.vehicleId);
      return null;
    }

    const duration = this.estimateRetrievalSeconds(parked.cellId);
    const operation: GarageOperation = {
      id: `op-${context.time}-${next.vehicleId}`,
      type: "RetrieveOutbound",
      vehicleId: next.vehicleId,
      startedAt: context.time,
      completesAt: context.time + duration,
      from: parked.cellId,
      to: "outbound-preparation-position",
    };
    this.activateOperation(operation, duration, parked.cellId);
    context.telemetry.recordOperation({
      time: context.time,
      type: "RetrieveOutboundStarted",
      vehicleId: next.vehicleId,
      detail: { cellId: parked.cellId, duration },
    });
    return operation;
  }

  private completeActiveOperation(time: SimTime): GarageCompletedOperation {
    const operation = this.activeOperation;
    if (!operation) {
      throw new Error("No active operation to complete.");
    }

    this.activeOperation = null;
    this.vmrs = this.vmrs.map((vmr) => ({ ...vmr, status: "Idle" }));

    if (operation.type === "ParkInbound" && operation.vehicleId && operation.to) {
      this.parked.set(operation.vehicleId, {
        vehicleId: operation.vehicleId,
        cellId: operation.to,
        parkedAt: time,
      });
      this.counters.inboundCompleted += 1;
    }

    if (operation.type === "RetrieveOutbound" && operation.vehicleId) {
      this.parked.delete(operation.vehicleId);
      this.requestedOutbound.delete(operation.vehicleId);
      this.placeVehicleOnOutboundPreparationPosition(operation.vehicleId, time);
      this.counters.outboundCompleted += 1;
    }

    return {
      type: operation.type,
      durationSeconds: this.operationDuration,
      detail: { from: operation.from, to: operation.to },
      ...(operation.vehicleId ? { vehicleId: operation.vehicleId } : {}),
    };
  }

  private activateOperation(operation: GarageOperation, duration: number, cellId: string): void {
    this.activeOperation = operation;
    this.operationDuration = duration;
    this.vmrs = this.vmrs.map((vmr, index) => ({
      ...vmr,
      status: index === 0 ? "Busy" : vmr.status,
    }));

    const floor = this.layout.getCellFloor(cellId);
    const floorsPassed = Math.max(0, (floor - 1) * 2);
    const vmrDistance = this.layout.estimateAccessCost(cellId, this.getOccupancy()) / 2;
    this.counters.elevatorFloorsPassed += floorsPassed;
    this.counters.vmrDistanceMeters += vmrDistance;
    this.vmrs[0] = {
      ...(this.vmrs[0] as VmrState),
      distanceMovedMeters: (this.vmrs[0]?.distanceMovedMeters ?? 0) + vmrDistance,
    };
  }

  private fillInboundPreparationPositions(time: SimTime): void {
    for (const position of this.preparationPositions) {
      if (this.inboundQueue.length === 0) return;
      if (position.direction !== "inbound" || position.occupiedBy) continue;

      const next = this.inboundQueue.shift();
      if (!next) return;
      position.occupiedBy = next.vehicleId;
      position.readyAt = time + this.preparationClearSeconds();
    }
  }

  private placeVehicleOnOutboundPreparationPosition(vehicleId: VehicleId, time: SimTime): void {
    const openPosition = this.preparationPositions.find(
      (position) => position.direction === "outbound" && !position.occupiedBy,
    );
    if (!openPosition) {
      return;
    }
    openPosition.occupiedBy = vehicleId;
    openPosition.readyAt = time + this.preparationClearSeconds();
  }

  private clearReadyOutboundPreparationPositions(time: SimTime): void {
    for (const position of this.preparationPositions) {
      if (position.direction === "outbound" && position.occupiedBy && (position.readyAt ?? 0) <= time) {
        delete position.occupiedBy;
        delete position.readyAt;
      }
    }
  }

  private shouldBalk(queueLengthExcludingPps: number, context: GarageEventIntakeContext): boolean {
    const policy = context.rng ? context : undefined;
    if (!policy) return false;
    const balking = {
      startsAtQueueLength: 13,
      initialProbability: 0.5,
      probabilityStep: 0.1,
      certainAtQueueLength: 18,
    };
    const queuePosition = queueLengthExcludingPps + 1;
    if (queuePosition < balking.startsAtQueueLength) return false;
    if (queuePosition >= balking.certainAtQueueLength) return true;
    const probability =
      balking.initialProbability +
      (queuePosition - balking.startsAtQueueLength) * balking.probabilityStep;
    return context.rng.nextFloat() < probability;
  }

  private preparationClearSeconds(): number {
    return this.config.preparationPositions.kind === "sequential"
      ? this.config.preparationPositions.sequentialClearSeconds
      : this.config.preparationPositions.parallelClearSeconds;
  }

  private estimateParkingSeconds(cellId: string): number {
    const floor = this.layout.getCellFloor(cellId);
    const verticalMeters = Math.max(0, floor - 1) * this.config.elevator.floorHeightMeters;
    const verticalSeconds = verticalMeters / this.config.elevator.verticalSpeedMetersPerSecond;
    const accessSeconds = this.layout.estimateAccessCost(cellId, this.getOccupancy());
    return Math.ceil(verticalSeconds * 2 + accessSeconds + this.config.vmr.gripReleaseSeconds * 2);
  }

  private estimateRetrievalSeconds(cellId: string): number {
    return this.estimateParkingSeconds(cellId);
  }

  private getOccupancy() {
    const occupied: CellOccupancy[] = [...this.parked.values()].map((record) => ({
      cellId: record.cellId,
      vehicleId: record.vehicleId,
      parkedAt: record.parkedAt,
    }));
    const totalParkingCells = this.layout.getParkingCells().length;
    return {
      occupied,
      occupiedCount: occupied.length,
      totalParkingCells,
      occupancyPercent: totalParkingCells === 0 ? 0 : occupied.length / totalParkingCells,
    };
  }

  private occupiedInboundPreparationPositions(): PreparationPositionState[] {
    return this.preparationPositions.filter((position) => position.direction === "inbound" && position.occupiedBy);
  }

  private updateMaxQueues(): void {
    this.counters.maxInboundQueueLength = Math.max(this.counters.maxInboundQueueLength, this.inboundQueue.length);
    this.counters.maxOutboundQueueLength = Math.max(this.counters.maxOutboundQueueLength, this.outboundQueue.length);
  }

  private estimateOperationFloor(operation: GarageOperation): number {
    const cell = operation.type === "ParkInbound" ? operation.to : operation.from;
    if (!cell || !cell.startsWith("f")) return 1;
    return this.layout.getCellFloor(cell);
  }
}
