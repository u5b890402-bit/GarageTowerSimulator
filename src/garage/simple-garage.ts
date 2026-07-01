import type {
  CapacityInfo,
  CellId,
  CellOccupancy,
  CellReservation,
  ElevatorTripAction,
  ElevatorTripActionGroup,
  ElevatorDeckState,
  ElevatorTripState,
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
  OccupancyState,
  PreparationPositionState,
  QueuedVehicle,
  SimTime,
  VehicleId,
  VmrPath,
  VmrState,
} from "../domain/types.js";
import { GridGarageLayout } from "./grid-layout.js";
import { GridVmrPathPlanner } from "./vmr-path-planner.js";

interface ParkedVehicleRecord {
  vehicleId: VehicleId;
  cellId: CellId;
  parkedAt: SimTime;
}

interface ActiveActionGroup {
  group: ElevatorTripActionGroup;
  operations: GarageOperation[];
  completesAt: SimTime;
}

interface PhysicalTrip {
  state: ElevatorTripState;
  groups: ElevatorTripActionGroup[];
  groupIndex: number;
  activeGroup: ActiveActionGroup | null;
}

interface PlanningDiagnosticWindow {
  startedAt: SimTime;
  attempts: number;
  planCount: number;
  noPlanCount: number;
  idleAllowedAttempts: number;
  idleNoPlanAttempts: number;
  failedIdleUnblockCacheHits: number;
  fullOccupancyAttempts: number;
  totalElapsedMs: number;
  maxElapsedMs: number;
  maxOccupancy: number;
  maxInboundQueueLength: number;
  maxOutboundQueueLength: number;
}

interface FailedIdleUnblockingCacheEntry {
  expiresAt: SimTime;
}

const failedIdleUnblockingCacheMaxEntries = 512;
const failedIdleUnblockingCacheTtlSeconds = 600;

export class SimpleGarageTowerSystem implements GarageTowerSystem {
  private layout!: GridGarageLayout;
  private pathPlanner!: GridVmrPathPlanner;
  private config!: GarageConfig;
  private inboundQueue: QueuedVehicle[] = [];
  private outboundQueue: QueuedVehicle[] = [];
  private parked = new Map<VehicleId, ParkedVehicleRecord>();
  private cellReservations = new Map<CellId, CellReservation>();
  private requestedOutbound = new Set<VehicleId>();
  private preparationPositions: PreparationPositionState[] = [];
  private decks: ElevatorDeckState[] = [];
  private vmrs: VmrState[] = [];
  private trip: PhysicalTrip | null = null;
  private elevatorFloor = 1;
  private elevatorDirection: "up" | "down" | "stopped" = "stopped";
  private lastExternalActivityAt = 0;
  private planningDiagnostics: PlanningDiagnosticWindow | null = null;
  private readonly failedIdleUnblockingCache = new Map<
    string,
    FailedIdleUnblockingCacheEntry
  >();
  private counters: GarageCumulativeCounters = this.newCounters();

  constructor(private readonly strategies: GarageStrategySet) {}

  initialize(config: GarageConfig): void {
    this.config = config;
    this.layout = new GridGarageLayout(config.layout);
    this.pathPlanner = new GridVmrPathPlanner(config, this.layout);
    this.inboundQueue = [];
    this.outboundQueue = [];
    this.parked.clear();
    this.cellReservations.clear();
    this.requestedOutbound.clear();
    this.trip = null;
    this.elevatorFloor = 1;
    this.elevatorDirection = "stopped";
    this.lastExternalActivityAt = 0;
    this.planningDiagnostics = null;
    this.failedIdleUnblockingCache.clear();
    this.counters = this.newCounters();
    this.preparationPositions = [
      ...Array.from({ length: config.preparationPositions.inboundCount }, (_, index) => ({
        id: `IPP${index + 1}`,
        direction: "inbound" as const,
        doorState: "open" as const,
      })),
      ...Array.from({ length: config.preparationPositions.outboundCount }, (_, index) => ({
        id: `OPP${index + 1}`,
        direction: "outbound" as const,
        doorState: "closed" as const,
      })),
    ];
    this.decks = Array.from({ length: config.elevator.deckCount }, (_, index) => ({
      id: `D${index + 1}`,
      index,
      alignedFloor: 1 - index,
      orientation: "garage",
      vmrId: `VMR${index + 1}`,
    }));
    this.vmrs = this.decks.map((deck) => ({
      id: deck.vmrId,
      deckId: deck.id,
      homeDeckId: deck.id,
      status: "Idle",
      distanceMovedMeters: 0,
    }));
  }

  submitEvents(context: GarageEventIntakeContext): EventAcceptanceResult[] {
    if (context.events.length > 0) {
      this.lastExternalActivityAt = context.time;
    }
    const results = context.events.map((event) =>
      event.type === "InboundArrival"
        ? this.submitInbound(event.id, event.vehicleId, context)
        : this.submitOutbound(event.id, event.vehicleId, context.time),
    );
    this.updateMaxQueues();
    return results;
  }

  updateOneSecond(context: GarageTickContext): GarageTickResult {
    this.updatePreparationPositions(context.time);

    const completedOperations = this.fillInboundPreparationPositions(context.time);
    const startedOperations: GarageOperation[] = [];

    if (this.trip?.activeGroup && context.time >= this.trip.activeGroup.completesAt) {
      completedOperations.push(...this.completeActiveGroup(context.time));
    }

    if (this.trip && !this.trip.activeGroup && this.trip.groupIndex >= this.trip.groups.length) {
      this.finishTrip(context.time);
    }

    if (!this.trip) {
      this.trip = this.planTrip(context);
    }

    if (this.trip && !this.trip.activeGroup) {
      startedOperations.push(...this.startNextGroup(context));
    }

    this.updateMaxQueues();
    return { completedOperations, startedOperations };
  }

  getSnapshot(): GarageStateSnapshot {
    const occupancy = this.getOccupancy();
    const activeOperations = this.trip?.activeGroup?.operations.map((operation) => ({ ...operation })) ?? [];
    const activeTrip = this.trip
      ? {
          ...this.trip.state,
          phase: this.trip.activeGroup?.group.name ?? "planning",
          routeIndex: this.trip.groupIndex,
        }
      : undefined;

    return {
      time: 0,
      occupancy,
      queues: {
        inbound: [...this.inboundQueue],
        outbound: [...this.outboundQueue],
        inboundLength: this.inboundQueue.length,
        outboundLength: this.outboundQueue.length,
      },
      elevator: {
        status: this.trip ? "Busy" : "IdleAtHome",
        currentFloor: this.elevatorFloor,
        deckCount: this.decks.length,
        direction: this.elevatorDirection,
        decks: this.decks.map((deck) => ({
          ...deck,
          alignedFloor: this.elevatorFloor - deck.index,
        })),
        ...(activeTrip ? { activeTrip } : {}),
        ...(activeOperations[0] ? { activeOperationId: activeOperations[0].id } : {}),
      },
      preparationPositions: this.preparationPositions.map((position) => ({ ...position })),
      vmrs: this.vmrs.map((vmr) => ({
        ...vmr,
        ...(vmr.currentTask ? { currentTask: { ...vmr.currentTask } } : {}),
      })),
      counters: { ...this.counters },
      activeOperations,
    };
  }

  isIdle(): boolean {
    return (
      !this.trip &&
      this.inboundQueue.length === 0 &&
      this.outboundQueue.length === 0 &&
      !this.preparationPositions.some((position) => position.occupiedBy)
    );
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
    const available = this.getCapacity().availableParkingCells;
    const reservedInbound = this.inboundQueue.length + this.inboundVehiclesInPhysicalSystem();
    if (available <= reservedInbound) {
      this.counters.rejectedEvents += 1;
      return {
        eventId,
        vehicleId,
        accepted: false,
        outcome: "RejectedGarageFull",
        reason: "No unreserved parking cell is available for another inbound vehicle.",
      };
    }

    if (this.shouldBalk(this.inboundQueue.length, context)) {
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

  private submitOutbound(
    eventId: string,
    vehicleId: VehicleId,
    time: SimTime,
  ): EventAcceptanceResult {
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

  private planTrip(context: GarageTickContext): PhysicalTrip | null {
    const snapshot = this.getSnapshot();
    snapshot.time = context.time;
    const idleSeconds = context.time - this.lastExternalActivityAt;
    const garageIsFull =
      snapshot.occupancy.occupiedCount >= snapshot.occupancy.totalParkingCells;
    const idleUnblockingAllowed =
      !garageIsFull &&
      this.strategies.unblockingStrategy.shouldStartIdleUnblocking({
        time: context.time,
        snapshot,
        idleSeconds,
      });
    const diagnosticsEnabled = context.simulation.diagnostics?.enabled === true;
    const planningStartedAtMs = diagnosticsEnabled ? nowMs() : 0;
    const idleUnblockingCandidate =
      idleUnblockingAllowed && this.isIdleUnblockingPlanningCandidate(snapshot);
    const idleUnblockingCacheKey = idleUnblockingCandidate
      ? this.failedIdleUnblockingCacheKey(snapshot)
      : null;

    if (
      idleUnblockingCacheKey &&
      this.hasFailedIdleUnblockingCacheHit(idleUnblockingCacheKey, context.time)
    ) {
      if (diagnosticsEnabled) {
        this.recordPlanningDiagnostics({
          context,
          snapshot,
          idleUnblockingAllowed,
          elapsedMs: nowMs() - planningStartedAtMs,
          planned: false,
          failedIdleUnblockCacheHit: true,
        });
      }
      return null;
    }

    const plan = this.strategies.tripPlanner.planNextTrip({
      time: context.time,
      snapshot,
      config: this.config,
      layout: this.layout,
      pathPlanner: this.pathPlanner,
      placementStrategy: this.strategies.placementStrategy,
      idleSeconds,
      idleUnblockingAllowed,
    });
    if (diagnosticsEnabled) {
      this.recordPlanningDiagnostics({
        context,
        snapshot,
        idleUnblockingAllowed,
        elapsedMs: nowMs() - planningStartedAtMs,
        planned: Boolean(plan),
        failedIdleUnblockCacheHit: false,
      });
    }
    if (idleUnblockingCacheKey) {
      if (plan) {
        this.failedIdleUnblockingCache.delete(idleUnblockingCacheKey);
      } else {
        this.rememberFailedIdleUnblockingPlan(
          idleUnblockingCacheKey,
          context.time,
        );
      }
    }
    if (!plan) return null;

    const selectedOutboundIds = new Set(plan.selectedOutboundVehicleIds);
    this.outboundQueue = this.outboundQueue.filter(
      (queued) => !selectedOutboundIds.has(queued.vehicleId),
    );
    if (plan.inducedInboundVehicles > 0) {
      this.counters.inducedInboundTrips += 1;
      this.counters.inducedInboundVehicles += plan.inducedInboundVehicles;
    }
    return {
      state: {
        id: plan.id,
        phase: plan.phase,
        startedAt: context.time,
        route: plan.stops,
        routeIndex: 0,
        inboundVehicleIds: plan.inboundVehicleIds,
        outboundVehicleIds: plan.outboundVehicleIds,
      },
      groups: plan.groups,
      groupIndex: 0,
      activeGroup: null,
    };
  }

  private recordPlanningDiagnostics(params: {
    context: GarageTickContext;
    snapshot: GarageStateSnapshot;
    idleUnblockingAllowed: boolean;
    elapsedMs: number;
    planned: boolean;
    failedIdleUnblockCacheHit: boolean;
  }): void {
    const {
      context,
      snapshot,
      idleUnblockingAllowed,
      elapsedMs,
      planned,
      failedIdleUnblockCacheHit,
    } = params;
    const interval = Math.max(
      1,
      context.simulation.diagnostics?.planningSampleIntervalSeconds ?? 60,
    );
    const occupancy = snapshot.occupancy.occupiedCount;
    const totalCells = snapshot.occupancy.totalParkingCells;

    if (!this.planningDiagnostics) {
      this.planningDiagnostics = this.newPlanningDiagnosticWindow(context.time);
    }

    const window = this.planningDiagnostics;
    window.attempts += 1;
    window.totalElapsedMs += elapsedMs;
    window.maxElapsedMs = Math.max(window.maxElapsedMs, elapsedMs);
    window.maxOccupancy = Math.max(window.maxOccupancy, occupancy);
    window.maxInboundQueueLength = Math.max(
      window.maxInboundQueueLength,
      snapshot.queues.inboundLength,
    );
    window.maxOutboundQueueLength = Math.max(
      window.maxOutboundQueueLength,
      snapshot.queues.outboundLength,
    );

    if (planned) {
      window.planCount += 1;
    } else {
      window.noPlanCount += 1;
    }
    if (idleUnblockingAllowed) {
      window.idleAllowedAttempts += 1;
      if (!planned) {
        window.idleNoPlanAttempts += 1;
      }
    }
    if (failedIdleUnblockCacheHit) {
      window.failedIdleUnblockCacheHits += 1;
    }
    if (occupancy >= totalCells) {
      window.fullOccupancyAttempts += 1;
    }

    if (context.time - window.startedAt < interval) return;

    context.telemetry.recordWarning({
      time: context.time,
      message: "PlanningDiagnostics",
      detail: {
        windowStart: window.startedAt,
        windowEnd: context.time,
        attempts: window.attempts,
        planCount: window.planCount,
        noPlanCount: window.noPlanCount,
        idleAllowedAttempts: window.idleAllowedAttempts,
        idleNoPlanAttempts: window.idleNoPlanAttempts,
        failedIdleUnblockCacheHits: window.failedIdleUnblockCacheHits,
        fullOccupancyAttempts: window.fullOccupancyAttempts,
        avgElapsedMs: roundMilliseconds(window.totalElapsedMs / window.attempts),
        maxElapsedMs: roundMilliseconds(window.maxElapsedMs),
        maxOccupancy: window.maxOccupancy,
        totalParkingCells: totalCells,
        maxInboundQueueLength: window.maxInboundQueueLength,
        maxOutboundQueueLength: window.maxOutboundQueueLength,
      },
    });
    this.planningDiagnostics = this.newPlanningDiagnosticWindow(context.time);
  }

  private newPlanningDiagnosticWindow(startedAt: SimTime): PlanningDiagnosticWindow {
    return {
      startedAt,
      attempts: 0,
      planCount: 0,
      noPlanCount: 0,
      idleAllowedAttempts: 0,
      idleNoPlanAttempts: 0,
      failedIdleUnblockCacheHits: 0,
      fullOccupancyAttempts: 0,
      totalElapsedMs: 0,
      maxElapsedMs: 0,
      maxOccupancy: 0,
      maxInboundQueueLength: 0,
      maxOutboundQueueLength: 0,
    };
  }

  private isIdleUnblockingPlanningCandidate(snapshot: GarageStateSnapshot): boolean {
    return (
      snapshot.queues.inboundLength === 0 &&
      snapshot.queues.outboundLength === 0 &&
      !snapshot.preparationPositions.some((position) => position.occupiedBy)
    );
  }

  private failedIdleUnblockingCacheKey(snapshot: GarageStateSnapshot): string {
    const occupiedCellIds = snapshot.occupancy.occupied
      .map((cell) => cell.cellId)
      .sort()
      .join(",");
    return `${snapshot.elevator.currentFloor}|${occupiedCellIds}`;
  }

  private hasFailedIdleUnblockingCacheHit(
    key: string,
    time: SimTime,
  ): boolean {
    const cached = this.failedIdleUnblockingCache.get(key);
    if (!cached) return false;
    if (cached.expiresAt <= time) {
      this.failedIdleUnblockingCache.delete(key);
      return false;
    }

    this.failedIdleUnblockingCache.delete(key);
    this.failedIdleUnblockingCache.set(key, cached);
    return true;
  }

  private rememberFailedIdleUnblockingPlan(key: string, time: SimTime): void {
    this.failedIdleUnblockingCache.set(key, {
      expiresAt: time + failedIdleUnblockingCacheTtlSeconds,
    });
    this.trimFailedIdleUnblockingCache();
  }

  private trimFailedIdleUnblockingCache(): void {
    while (
      this.failedIdleUnblockingCache.size > failedIdleUnblockingCacheMaxEntries
    ) {
      const oldestKey = this.failedIdleUnblockingCache.keys().next().value;
      if (!oldestKey) return;
      this.failedIdleUnblockingCache.delete(oldestKey);
    }
  }

  private startNextGroup(context: GarageTickContext): GarageOperation[] {
    if (!this.trip) return [];
    const group = this.trip.groups[this.trip.groupIndex];
    if (!group) return [];
    if (group.name.startsWith("move-elevator-") && !this.allVmrsHomeAndIdle()) {
      context.telemetry.recordWarning({
        time: context.time,
        message: "Elevator movement delayed until all VMRs return to their home decks.",
      });
      return [];
    }
    this.validateActionGroupPaths(group);

    if (group.elevatorDirection) {
      this.elevatorDirection = group.elevatorDirection;
    }
    const operations = group.actions.map((action, index) => {
      const operation: GarageOperation = {
        id: `${this.trip?.state.id}-${this.trip?.groupIndex}-${index}`,
        type: action.type,
        startedAt: context.time,
        completesAt: context.time + action.durationSeconds,
        ...(action.vehicleId ? { vehicleId: action.vehicleId } : {}),
        ...(action.from ? { from: action.from } : {}),
        ...(action.to ? { to: action.to } : {}),
        ...(action.path ? { path: action.path } : {}),
      };
      this.applyActionStart(action, context.time, operation);
      if (action.deckIndex !== undefined && action.type !== "RotateDeck") {
        this.startVmrTask(action.deckIndex, operation);
      }
      context.telemetry.recordOperation({
        time: context.time,
        type: `${action.type}Started`,
        ...(action.vehicleId ? { vehicleId: action.vehicleId } : {}),
        detail: {
          tripId: this.trip?.state.id,
          group: group.name,
          from: action.from,
          to: action.to,
          durationSeconds: action.durationSeconds,
          path: action.path?.locations,
        },
      });
      return operation;
    });
    const completesAt = Math.max(...operations.map((operation) => operation.completesAt));
    this.trip.activeGroup = { group, operations, completesAt };
    return operations;
  }

  private completeActiveGroup(time: SimTime): GarageCompletedOperation[] {
    if (!this.trip?.activeGroup) return [];
    const { group, operations } = this.trip.activeGroup;
    group.actions.forEach((action) => {
      this.applyActionComplete(action, time);
      if (action.deckIndex !== undefined && action.type !== "RotateDeck") {
        this.finishVmrTask(action.deckIndex);
      }
    });
    const completed = operations.map((operation) => ({
      type: operation.type,
      durationSeconds: operation.completesAt - operation.startedAt,
      detail: {
        from: operation.from,
        to: operation.to,
        group: group.name,
        path: operation.path?.locations,
      },
      ...(operation.vehicleId ? { vehicleId: operation.vehicleId } : {}),
    }));
    this.trip.activeGroup = null;
    this.trip.groupIndex += 1;
    return completed;
  }

  private finishTrip(time: SimTime): void {
    if (!this.trip) return;
    const wasNormalTrip =
      this.trip.state.inboundVehicleIds.length > 0 ||
      this.trip.state.outboundVehicleIds.length > 0;
    this.elevatorFloor = 1;
    this.elevatorDirection = "stopped";
    for (const deck of this.decks) {
      deck.alignedFloor = 1 - deck.index;
      deck.orientation = "garage";
    }
    for (const vmr of this.vmrs) {
      vmr.status = "Idle";
      delete vmr.currentTask;
    }
    if (wasNormalTrip) {
      this.lastExternalActivityAt = Math.max(this.lastExternalActivityAt, time);
    }
    this.trip = null;
  }

  private applyActionStart(
    action: ElevatorTripAction,
    time: SimTime,
    operation: GarageOperation,
  ): void {
    this.reserveDestinationCell(action, time, operation);

    if (action.type === "OperateDoor" && action.preparationPositionId && action.doorFinalState) {
      const position = this.findPp(action.preparationPositionId);
      if (!position) return;
      position.doorState =
        action.doorFinalState === "open" ? "opening" : "closing";
      position.doorTransitionCompleteAt = time + action.durationSeconds;
    }
  }

  private applyActionComplete(action: ElevatorTripAction, time: SimTime): void {
    const deck =
      action.deckIndex === undefined ? undefined : this.decks[action.deckIndex];

    switch (action.type) {
      case "MoveElevator": {
        const from = this.elevatorPosition(action.from);
        const to = this.elevatorPosition(action.to);
        this.counters.elevatorFloorsPassed += Math.abs(to - from);
        this.elevatorFloor = to;
        this.decks.forEach((candidate) => {
          candidate.alignedFloor = to - candidate.index;
        });
        break;
      }
      case "RotateDeck":
        if (deck && (action.to === "garage" || action.to === "street")) {
          deck.orientation = action.to;
        }
        break;
      case "OperateDoor": {
        const position = action.preparationPositionId
          ? this.findPp(action.preparationPositionId)
          : undefined;
        if (!position || !action.doorFinalState) break;
        position.doorState = action.doorFinalState;
        delete position.doorTransitionCompleteAt;
        if (action.setDriverReady && position.occupiedBy) {
          position.readyAt = time + this.preparationClearSeconds();
        }
        break;
      }
      case "LoadInbound": {
        const position = action.preparationPositionId
          ? this.findPp(action.preparationPositionId)
          : undefined;
        if (position) {
          delete position.occupiedBy;
          delete position.readyAt;
        }
        if (deck && action.vehicleId) {
          deck.vehicleId = action.vehicleId;
          deck.vehicleRole = "inbound";
        }
        break;
      }
      case "MoveBlocker":
        if (action.vehicleId) {
          this.parked.delete(action.vehicleId);
          if (deck) {
            deck.vehicleId = action.vehicleId;
            deck.vehicleRole = "blocker";
          }
        }
        break;
      case "LoadOutbound":
        if (action.vehicleId) {
          this.parked.delete(action.vehicleId);
          if (deck) {
            deck.vehicleId = action.vehicleId;
            deck.vehicleRole = "outbound";
          }
        }
        break;
      case "RelocateBlocker":
        if (action.vehicleId && action.to) {
          this.parked.set(action.vehicleId, {
            vehicleId: action.vehicleId,
            cellId: action.to as CellId,
            parkedAt: time,
          });
          this.releaseReservation(action.to as CellId);
        }
        if (action.deckIndex !== undefined) this.clearDeck(action.deckIndex);
        break;
      case "ParkInbound":
        if (action.vehicleId && action.to) {
          this.parked.set(action.vehicleId, {
            vehicleId: action.vehicleId,
            cellId: action.to as CellId,
            parkedAt: time,
          });
          this.releaseReservation(action.to as CellId);
          this.counters.inboundCompleted += 1;
          this.counters.downwardTripPlacements += 1;
        }
        if (action.deckIndex !== undefined) this.clearDeck(action.deckIndex);
        break;
      case "RetrieveOutbound": {
        const position = action.preparationPositionId
          ? this.findPp(action.preparationPositionId)
          : undefined;
        if (position && action.vehicleId) {
          position.occupiedBy = action.vehicleId;
          position.doorState = "closed";
        }
        if (action.deckIndex !== undefined) this.clearDeck(action.deckIndex);
        if (action.vehicleId) {
          this.requestedOutbound.delete(action.vehicleId);
          this.counters.outboundCompleted += 1;
        }
        break;
      }
      case "IdleUnblock":
        if (action.vehicleId && action.to) {
          this.parked.set(action.vehicleId, {
            vehicleId: action.vehicleId,
            cellId: action.to as CellId,
            parkedAt: time,
          });
          this.releaseReservation(action.to as CellId);
          this.counters.idleUnblockingActions += 1;
          this.counters.idleUnblockedVehicles += 1;
        }
        if (action.deckIndex !== undefined) this.clearDeck(action.deckIndex);
        break;
      case "UnloadOutbound":
      case "EnterInboundPreparationPosition":
        break;
    }
  }

  private elevatorPosition(location?: string): number {
    const value = Number(location?.slice("elevator-position-".length));
    return Number.isFinite(value) ? value : this.elevatorFloor;
  }

  private updatePreparationPositions(time: SimTime): void {
    for (const position of this.preparationPositions) {
      if (
        position.direction === "outbound" &&
        position.doorState === "open" &&
        position.occupiedBy &&
        (position.readyAt ?? Number.POSITIVE_INFINITY) <= time
      ) {
        delete position.occupiedBy;
        delete position.readyAt;
        position.doorState = "closing";
        position.doorTransitionCompleteAt =
          time + this.config.preparationPositions.doorSeconds;
      }
      if (
        position.doorTransitionCompleteAt !== undefined &&
        position.doorTransitionCompleteAt <= time
      ) {
        position.doorState =
          position.doorState === "closing" ? "closed" : "open";
        delete position.doorTransitionCompleteAt;
      }
    }
  }

  private fillInboundPreparationPositions(
    time: SimTime,
  ): GarageCompletedOperation[] {
    const completed: GarageCompletedOperation[] = [];
    const inboundPositions = this.preparationPositions.filter(
      (position) => position.direction === "inbound",
    );
    for (const position of inboundPositions) {
      if (this.inboundQueue.length === 0) return completed;
      if (position.doorState !== "open" || position.occupiedBy) continue;
      if (
        this.config.preparationPositions.kind === "sequential" &&
        inboundPositions.some(
          (candidate) =>
            Number(candidate.id.slice(3)) < Number(position.id.slice(3)) &&
            !candidate.occupiedBy,
        )
      ) {
        continue;
      }
      const next = this.inboundQueue.shift();
      if (!next) return completed;
      position.occupiedBy = next.vehicleId;
      position.readyAt = time + this.preparationClearSeconds();
      completed.push({
        type: "EnterInboundPreparationPosition",
        vehicleId: next.vehicleId,
        durationSeconds: 0,
        detail: {
          preparationPositionId: position.id,
          queuedAt: next.queuedAt,
        },
      });
    }
    return completed;
  }

  private startVmrTask(index: number, operation: GarageOperation): void {
    const vmr = this.vmrs[index];
    if (!vmr) return;
    vmr.status = "Busy";
    vmr.currentTask = {
      type: operation.type,
      startedAt: operation.startedAt,
      completesAt: operation.completesAt,
      ...(operation.from ? { from: operation.from } : {}),
      ...(operation.to ? { to: operation.to } : {}),
      ...(operation.vehicleId ? { vehicleId: operation.vehicleId } : {}),
      ...(operation.path ? { path: operation.path } : {}),
    };
  }

  private finishVmrTask(index: number): void {
    const vmr = this.vmrs[index];
    if (!vmr) return;
    const task = vmr.currentTask;
    if (task) {
      const distance = task.path?.distanceMeters ?? this.taskDistance(task.from, task.to);
      vmr.distanceMovedMeters += distance;
      this.counters.vmrDistanceMeters += distance;
    }
    vmr.status = "Idle";
    delete vmr.currentTask;
  }

  private allVmrsHomeAndIdle(): boolean {
    return this.vmrs.every(
      (vmr) => vmr.status === "Idle" && vmr.deckId === vmr.homeDeckId,
    );
  }

  private validateActionGroupPaths(group: ElevatorTripActionGroup): void {
    const pathActions = group.actions.filter(
      (action): action is ElevatorTripAction & { path: VmrPath } =>
        Boolean(action.path),
    );
    for (let index = 0; index < pathActions.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < pathActions.length; otherIndex += 1) {
        const first = pathActions[index];
        const second = pathActions[otherIndex];
        if (
          first &&
          second &&
          this.pathPlanner.pathsConflict(first.path, second.path)
        ) {
          throw new Error(
            `Concurrent VMR paths conflict in group '${group.name}': ` +
              `${first.vehicleId ?? first.type} and ${second.vehicleId ?? second.type}.`,
          );
        }
      }
    }

    const occupancy = this.getOccupancy();
    for (const action of pathActions) {
      const extraction =
        action.type === "MoveBlocker" || action.type === "LoadOutbound";
      const endpoint = extraction ? action.from : action.to;
      if (!endpoint?.startsWith("f")) continue;
      if (
        !this.pathPlanner.isClear(
          action.path,
          occupancy,
          endpoint,
          extraction,
        )
      ) {
        throw new Error(
          `VMR path is obstructed for ${action.type} ${action.vehicleId ?? ""}: ` +
            action.path.locations.join(" -> "),
        );
      }
    }
  }

  private clearDeck(index: number): void {
    const deck = this.decks[index];
    if (!deck) return;
    delete deck.vehicleId;
    delete deck.vehicleRole;
  }

  private findPp(id: string): PreparationPositionState | undefined {
    return this.preparationPositions.find((position) => position.id === id);
  }

  private reserveDestinationCell(
    action: ElevatorTripAction,
    time: SimTime,
    operation: GarageOperation,
  ): void {
    if (!this.isCellReservationPurpose(action.type) || !action.vehicleId || !action.to?.startsWith("f")) {
      return;
    }
    const cellId = action.to as CellId;
    this.cellReservations.set(cellId, {
      cellId,
      vehicleId: action.vehicleId,
      operationId: operation.id,
      reservedAt: time,
      expectedOccupiedAt: operation.completesAt,
      purpose: action.type,
    });
  }

  private releaseReservation(cellId: CellId): void {
    this.cellReservations.delete(cellId);
  }

  private isCellReservationPurpose(
    type: GarageOperation["type"],
  ): type is CellReservation["purpose"] {
    return (
      type === "ParkInbound" ||
      type === "RelocateBlocker" ||
      type === "IdleUnblock"
    );
  }

  private taskDistance(from?: string, to?: string): number {
    const cell = [from, to].find((value) => value?.startsWith("f"));
    if (cell) {
      const geometry = this.layout.getCellGeometry(cell);
      const centerRow = Math.ceil(this.config.layout.rows / 2);
      const centerColumn = Math.ceil(this.config.layout.columns / 2);
      return (
        (Math.abs(geometry.row - centerRow) +
          Math.abs(geometry.column - centerColumn)) *
        3 *
        2
      );
    }
    const pp = [from, to].find((value) => value?.includes("PP"));
    if (pp) {
      const positionNumber = Number(/\d+$/.exec(pp)?.[0] ?? 1);
      return Math.max(3, positionNumber * 3) * 2;
    }
    return 0;
  }

  private getOccupancy(): OccupancyState {
    const occupied: CellOccupancy[] = [...this.parked.values()].map((record) => ({
      cellId: record.cellId,
      vehicleId: record.vehicleId,
      parkedAt: record.parkedAt,
    }));
    const reservations = [...this.cellReservations.values()].map((reservation) => ({
      ...reservation,
    }));
    const reservedCellIds = new Set(
      reservations
        .filter((reservation) => !occupied.some((cell) => cell.cellId === reservation.cellId))
        .map((reservation) => reservation.cellId),
    );
    const totalParkingCells = this.layout.getParkingCells().length;
    const effectiveOccupiedCount = occupied.length + reservedCellIds.size;
    return {
      occupied,
      reservations,
      occupiedCount: occupied.length,
      reservedCount: reservedCellIds.size,
      effectiveOccupiedCount,
      totalParkingCells,
      occupancyPercent:
        totalParkingCells === 0 ? 0 : occupied.length / totalParkingCells,
      effectiveOccupancyPercent:
        totalParkingCells === 0 ? 0 : effectiveOccupiedCount / totalParkingCells,
    };
  }

  private inboundVehiclesInPhysicalSystem(): number {
    const onPps = this.preparationPositions.filter(
      (position) => position.direction === "inbound" && position.occupiedBy,
    ).length;
    const onDecks = this.decks.filter(
      (deck) => deck.vehicleRole === "inbound" && deck.vehicleId,
    ).length;
    return onPps + onDecks;
  }

  private updateMaxQueues(): void {
    this.counters.maxInboundQueueLength = Math.max(
      this.counters.maxInboundQueueLength,
      this.inboundQueue.length,
    );
    this.counters.maxOutboundQueueLength = Math.max(
      this.counters.maxOutboundQueueLength,
      this.outboundQueue.length,
    );
  }

  private shouldBalk(
    queueLengthExcludingPps: number,
    context: GarageEventIntakeContext,
  ): boolean {
    const policy = {
      startsAtQueueLength: 13,
      initialProbability: 0.5,
      probabilityStep: 0.1,
      certainAtQueueLength: 18,
    };
    const queuePosition = queueLengthExcludingPps + 1;
    if (queuePosition < policy.startsAtQueueLength) return false;
    if (queuePosition >= policy.certainAtQueueLength) return true;
    const probability =
      policy.initialProbability +
      (queuePosition - policy.startsAtQueueLength) * policy.probabilityStep;
    return context.rng.nextFloat() < probability;
  }

  private preparationClearSeconds(): number {
    return this.config.preparationPositions.kind === "sequential"
      ? this.config.preparationPositions.sequentialClearSeconds
      : this.config.preparationPositions.parallelClearSeconds;
  }

  private newCounters(): GarageCumulativeCounters {
    return {
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
  }
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
