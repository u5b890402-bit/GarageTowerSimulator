import type {
  CellOccupancy,
  ElevatorDeckState,
  GarageCompletedOperation,
  GarageOperation,
  GarageStateSnapshot,
  QueuedVehicle,
  RawSimulationCheckpointRecord,
  RawSimulationDataRecord,
  RawSimulationEventsRecord,
  RawSimulationOperationsRecord,
  RawSimulationStateRecord,
  SimTime,
  VmrState,
} from "../../domain/types.js";
import {
  clamp,
  cloneValue,
  deckByLocation,
  elevatorPosition,
  inferDeckFromRotateGroup,
  interpolateOperation,
  operationDeckIndex,
  parseDeckIndex,
  recordTime,
  releaseReservationForCompletedOperation,
  reserveDestinationForOperation,
  stringDetail,
} from "./operations.js";
import { frameCacheMaxEntries } from "./types.js";
import type { VisualizerDataSet, VisualizerFrame } from "./types.js";

export class CheckpointReplayEngine {
  private readonly cache = new Map<number, VisualizerFrame>();

  constructor(private readonly dataSet: VisualizerDataSet) {}

  getFrameAt(time: SimTime): VisualizerFrame {
    const key = Math.round(clamp(time, 0, this.dataSet.durationSeconds));
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const checkpoint = this.closestCheckpointAtOrBefore(key);
    const cachedBase = this.closestCachedFrameAtOrBefore(key, checkpoint.t);
    const baseTime = cachedBase ? cachedBase.time : checkpoint.t;
    const snapshot = cachedBase
      ? cloneValue(cachedBase.snapshot)
      : cloneValue(checkpoint.snapshot);
    for (const record of this.dataSet.records) {
      const t = recordTime(record);
      if (t <= baseTime) continue;
      if (t > key) break;
      this.applyRecord(snapshot, record);
    }

    snapshot.time = key;
    this.cleanupActiveOperations(snapshot, key);
    this.recalculateDerivedState(snapshot);

    const elevatorDestination = this.currentElevatorDestination(snapshot.activeOperations);
    const frame: VisualizerFrame = {
      time: key,
      snapshot,
      interpolatedOperations: snapshot.activeOperations.map((operation) =>
        interpolateOperation(operation, key),
      ),
      ...(elevatorDestination !== undefined ? { elevatorDestination } : {}),
    };

    this.rememberFrame(key, frame);
    return frame;
  }

  private closestCheckpointAtOrBefore(time: SimTime): RawSimulationCheckpointRecord {
    let low = 0;
    let high = this.dataSet.checkpoints.length - 1;
    let result = this.dataSet.checkpoints[0];
    if (!result) throw new Error("No checkpoints are available.");

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = this.dataSet.checkpoints[mid];
      if (!candidate) break;
      if (candidate.t <= time) {
        result = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  private closestCachedFrameAtOrBefore(
    time: SimTime,
    checkpointTime: SimTime,
  ): VisualizerFrame | null {
    let result: VisualizerFrame | null = null;
    for (const [cachedTime, frame] of this.cache) {
      if (cachedTime <= checkpointTime || cachedTime >= time) continue;
      if (!result || cachedTime > result.time) result = frame;
    }
    if (result) {
      this.cache.delete(result.time);
      this.cache.set(result.time, result);
    }
    return result;
  }

  private applyRecord(snapshot: GarageStateSnapshot, record: RawSimulationDataRecord): void {
    switch (record.kind) {
      case "events":
        this.applyEvents(snapshot, record);
        break;
      case "operations":
        this.applyOperations(snapshot, record);
        break;
      case "state":
        this.applyState(snapshot, record);
        break;
      case "checkpoint":
      case "second":
        break;
    }
  }

  private applyEvents(snapshot: GarageStateSnapshot, record: RawSimulationEventsRecord): void {
    for (const result of record.intake) {
      if (!result.accepted) continue;
      const event = record.generated.find((candidate) => candidate.id === result.eventId);
      const queued: QueuedVehicle = {
        vehicleId: result.vehicleId,
        queuedAt: event?.time ?? record.t,
      };
      if (result.outcome === "QueuedInbound") {
        if (!snapshot.queues.inbound.some((item) => item.vehicleId === result.vehicleId)) {
          snapshot.queues.inbound.push(queued);
        }
      }
      if (result.outcome === "QueuedOutbound") {
        if (!snapshot.queues.outbound.some((item) => item.vehicleId === result.vehicleId)) {
          snapshot.queues.outbound.push(queued);
        }
      }
    }
  }

  private applyOperations(snapshot: GarageStateSnapshot, record: RawSimulationOperationsRecord): void {
    for (const operation of record.started ?? []) {
      if (!snapshot.activeOperations.some((active) => active.id === operation.id)) {
        snapshot.activeOperations.push(cloneValue(operation));
      }
      this.applyOperationStart(snapshot, operation);
    }

    for (const operation of record.completed ?? []) {
      this.applyOperationComplete(snapshot, operation, record.t);
    }
  }

  private applyState(snapshot: GarageStateSnapshot, record: RawSimulationStateRecord): void {
    snapshot.counters = cloneValue(record.counters);
    snapshot.occupancy.reservedCount =
      record.occupancy.reservedCount ?? snapshot.occupancy.reservedCount ?? 0;
    snapshot.occupancy.effectiveOccupiedCount =
      record.occupancy.effectiveOccupiedCount ??
      snapshot.occupancy.effectiveOccupiedCount ??
      snapshot.occupancy.occupiedCount;
    snapshot.occupancy.effectiveOccupancyPercent =
      record.occupancy.effectiveOccupancyPercent ??
      snapshot.occupancy.effectiveOccupancyPercent ??
      snapshot.occupancy.occupancyPercent;
  }

  private applyOperationStart(snapshot: GarageStateSnapshot, operation: GarageOperation): void {
    if (operation.type === "MoveElevator") {
      const destination = elevatorPosition(operation.to);
      snapshot.elevator.status = "Busy";
      if (destination !== null) {
        snapshot.elevator.direction =
          destination > snapshot.elevator.currentFloor
            ? "up"
            : destination < snapshot.elevator.currentFloor
              ? "down"
              : "stopped";
      }
      return;
    }

    reserveDestinationForOperation(snapshot, operation);

    const deckIndex = operationDeckIndex(operation);
    if (deckIndex === null) return;
    const vmr = snapshot.vmrs[deckIndex];
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

  private applyOperationComplete(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    time: SimTime,
  ): void {
    snapshot.activeOperations = snapshot.activeOperations.filter((active) => {
      if (active.completesAt > time) return true;
      if (active.type !== operation.type) return true;
      if (operation.vehicleId && active.vehicleId !== operation.vehicleId) return true;
      return false;
    });

    switch (operation.type) {
      case "EnterInboundPreparationPosition":
        this.enterInboundPreparationPosition(snapshot, operation, time);
        break;
      case "LoadInbound":
        this.loadDeckFromPreparationPosition(snapshot, operation, "inbound");
        break;
      case "ParkInbound":
        this.parkFromDeck(snapshot, operation, time);
        break;
      case "MoveBlocker":
      case "LoadOutbound":
        this.loadDeckFromCell(snapshot, operation, operation.type === "LoadOutbound" ? "outbound" : "blocker");
        break;
      case "RelocateBlocker":
      case "IdleUnblock":
        this.parkFromDeck(snapshot, operation, time);
        break;
      case "RetrieveOutbound":
        this.retrieveOutbound(snapshot, operation, time);
        break;
      case "MoveElevator":
        this.moveElevator(snapshot, operation);
        break;
      case "RotateDeck":
        this.rotateDeck(snapshot, operation);
        break;
      case "OperateDoor":
        this.operateDoor(snapshot, operation, time);
        break;
      case "UnloadOutbound":
        break;
    }

    this.finishVmrForOperation(snapshot, operation);
    releaseReservationForCompletedOperation(snapshot, operation);
  }

  private enterInboundPreparationPosition(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    time: SimTime,
  ): void {
    if (!operation.vehicleId) return;
    const positionId = stringDetail(operation.detail, "preparationPositionId");
    const position = positionId
      ? snapshot.preparationPositions.find((candidate) => candidate.id === positionId)
      : undefined;
    if (position) {
      position.occupiedBy = operation.vehicleId;
      position.readyAt = time;
      position.doorState = "open";
    }
    snapshot.queues.inbound = snapshot.queues.inbound.filter((item) => item.vehicleId !== operation.vehicleId);
  }

  private loadDeckFromPreparationPosition(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    role: "inbound" | "outbound" | "blocker",
  ): void {
    if (!operation.vehicleId) return;
    const from = stringDetail(operation.detail, "from");
    const to = stringDetail(operation.detail, "to");
    const positionId = stringDetail(operation.detail, "preparationPositionId") ?? from;
    const position = positionId
      ? snapshot.preparationPositions.find((candidate) => candidate.id === positionId)
      : undefined;
    if (position) {
      delete position.occupiedBy;
      delete position.readyAt;
    }
    const deck = deckByLocation(snapshot.elevator.decks ?? [], to);
    if (deck) {
      deck.vehicleId = operation.vehicleId;
      deck.vehicleRole = role;
    }
  }

  private loadDeckFromCell(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    role: "inbound" | "outbound" | "blocker",
  ): void {
    if (!operation.vehicleId) return;
    const to = stringDetail(operation.detail, "to");
    removeOccupiedVehicle(snapshot, operation.vehicleId);
    const deck = deckByLocation(snapshot.elevator.decks ?? [], to);
    if (deck) {
      deck.vehicleId = operation.vehicleId;
      deck.vehicleRole = role;
    }
  }

  private parkFromDeck(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    time: SimTime,
  ): void {
    if (!operation.vehicleId) return;
    const to = stringDetail(operation.detail, "to");
    const from = stringDetail(operation.detail, "from");
    if (to?.startsWith("f")) {
      upsertOccupied(snapshot, {
        cellId: to,
        vehicleId: operation.vehicleId,
        parkedAt: time,
      });
    }
    const deck = deckByLocation(snapshot.elevator.decks ?? [], from);
    if (deck) clearDeck(deck);
  }

  private retrieveOutbound(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    time: SimTime,
  ): void {
    if (!operation.vehicleId) return;
    const from = stringDetail(operation.detail, "from");
    const to = stringDetail(operation.detail, "to");
    const position = to
      ? snapshot.preparationPositions.find((candidate) => candidate.id === to)
      : undefined;
    if (position) {
      position.occupiedBy = operation.vehicleId;
      position.readyAt = time;
      position.doorState = "closed";
    }
    const deck = deckByLocation(snapshot.elevator.decks ?? [], from);
    if (deck) clearDeck(deck);
    snapshot.queues.outbound = snapshot.queues.outbound.filter((item) => item.vehicleId !== operation.vehicleId);
  }

  private moveElevator(snapshot: GarageStateSnapshot, operation: GarageCompletedOperation): void {
    const to = elevatorPosition(stringDetail(operation.detail, "to"));
    if (to === null) return;
    snapshot.elevator.currentFloor = to;
    snapshot.elevator.status = "Busy";
    snapshot.elevator.direction = "stopped";
    for (const deck of snapshot.elevator.decks ?? []) {
      deck.alignedFloor = to - deck.index;
    }
  }

  private rotateDeck(snapshot: GarageStateSnapshot, operation: GarageCompletedOperation): void {
    const to = stringDetail(operation.detail, "to");
    if (to !== "garage" && to !== "street") return;
    const group = stringDetail(operation.detail, "group");
    const affectedDeck = inferDeckFromRotateGroup(snapshot.elevator.decks ?? [], group);
    if (affectedDeck) {
      affectedDeck.orientation = to;
      return;
    }
    for (const deck of snapshot.elevator.decks ?? []) {
      deck.orientation = to;
    }
  }

  private operateDoor(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
    time: SimTime,
  ): void {
    const to = stringDetail(operation.detail, "to");
    if (to !== "open" && to !== "closed") return;
    const group = stringDetail(operation.detail, "group") ?? "";
    const direction = group.includes("outbound") ? "outbound" : group.includes("inbound") ? "inbound" : null;
    for (const position of snapshot.preparationPositions) {
      if (direction && position.direction !== direction) continue;
      position.doorState = to;
      delete position.doorTransitionCompleteAt;
      if (to === "open" && position.direction === "outbound" && position.occupiedBy) {
        position.readyAt = time;
      }
    }
  }

  private finishVmrForOperation(
    snapshot: GarageStateSnapshot,
    operation: GarageCompletedOperation,
  ): void {
    const from = stringDetail(operation.detail, "from");
    const to = stringDetail(operation.detail, "to");
    const index = parseDeckIndex(from) ?? parseDeckIndex(to);
    if (index === null) return;
    const vmr = snapshot.vmrs[index];
    if (!vmr) return;
    vmr.status = "Idle";
    delete vmr.currentTask;
  }

  private cleanupActiveOperations(snapshot: GarageStateSnapshot, time: SimTime): void {
    snapshot.activeOperations = snapshot.activeOperations.filter((operation) => operation.completesAt > time);
    const busyDeckIndexes = new Set<number>();
    for (const operation of snapshot.activeOperations) {
      const deckIndex = operationDeckIndex(operation);
      if (deckIndex !== null && operation.type !== "RotateDeck") {
        busyDeckIndexes.add(deckIndex);
      }
    }
    snapshot.vmrs = snapshot.vmrs.map((vmr, index) => {
      if (!busyDeckIndexes.has(index)) {
        const idle: VmrState = { ...vmr, status: "Idle" };
        delete idle.currentTask;
        return idle;
      }
      return vmr;
    });
    snapshot.elevator.status = snapshot.activeOperations.length > 0 ? "Busy" : "IdleAtHome";
  }

  private recalculateDerivedState(snapshot: GarageStateSnapshot): void {
    snapshot.queues.inboundLength = snapshot.queues.inbound.length;
    snapshot.queues.outboundLength = snapshot.queues.outbound.length;
    snapshot.occupancy.occupied.sort((a, b) => a.cellId.localeCompare(b.cellId));
    snapshot.occupancy.occupiedCount = snapshot.occupancy.occupied.length;
    const occupiedCellIds = new Set(snapshot.occupancy.occupied.map((cell) => cell.cellId));
    const reservedCount = (snapshot.occupancy.reservations ?? []).filter(
      (reservation) => !occupiedCellIds.has(reservation.cellId),
    ).length;
    snapshot.occupancy.reservedCount = reservedCount;
    snapshot.occupancy.effectiveOccupiedCount =
      snapshot.occupancy.occupiedCount + reservedCount;
    snapshot.occupancy.occupancyPercent =
      snapshot.occupancy.totalParkingCells === 0
        ? 0
        : snapshot.occupancy.occupiedCount / snapshot.occupancy.totalParkingCells;
    snapshot.occupancy.effectiveOccupancyPercent =
      snapshot.occupancy.totalParkingCells === 0
        ? 0
        : snapshot.occupancy.effectiveOccupiedCount / snapshot.occupancy.totalParkingCells;
  }

  private currentElevatorDestination(operations: GarageOperation[]): number | undefined {
    const move = operations.find((operation) => operation.type === "MoveElevator");
    const destination = move ? elevatorPosition(move.to) : null;
    return destination ?? undefined;
  }

  private rememberFrame(time: SimTime, frame: VisualizerFrame): void {
    this.cache.set(time, frame);
    while (this.cache.size > frameCacheMaxEntries) {
      const firstKey = this.cache.keys().next().value as number | undefined;
      if (firstKey === undefined) return;
      this.cache.delete(firstKey);
    }
  }
}

function removeOccupiedVehicle(snapshot: GarageStateSnapshot, vehicleId: string): void {
  snapshot.occupancy.occupied = snapshot.occupancy.occupied.filter((cell) => cell.vehicleId !== vehicleId);
}

function upsertOccupied(snapshot: GarageStateSnapshot, cell: CellOccupancy): void {
  snapshot.occupancy.occupied = snapshot.occupancy.occupied.filter(
    (candidate) => candidate.vehicleId !== cell.vehicleId && candidate.cellId !== cell.cellId,
  );
  snapshot.occupancy.reservations = (snapshot.occupancy.reservations ?? []).filter(
    (reservation) => reservation.vehicleId !== cell.vehicleId && reservation.cellId !== cell.cellId,
  );
  snapshot.occupancy.occupied.push(cell);
}

function clearDeck(deck: ElevatorDeckState): void {
  delete deck.vehicleId;
  delete deck.vehicleRole;
}
