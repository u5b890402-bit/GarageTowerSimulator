import type {
  CellId,
  ElevatorTripPlan,
  ElevatorTripPlanner,
  PlacementContext,
  PlacementStrategy,
  PreparationPositionAssignment,
  PreparationPositionContext,
  PreparationPositionPolicy,
  RankedCell,
  RandomSource,
  RetrievalClass,
  RetrievalContext,
  RetrievalPlan,
  RetrievalStrategy,
  UnblockingContext,
  UnblockingPlan,
  UnblockingStrategy,
  VehicleId,
} from "../domain/types.js";

export class LowestCostPlacementStrategy implements PlacementStrategy {
  rankCandidateCells(context: PlacementContext): RankedCell[] {
    const occupied = new Set(context.occupancy.occupied.map((cell) => cell.cellId));
    return context.layout
      .getParkingCells()
      .filter((cellId) => !occupied.has(cellId))
      .map((cellId) => ({
        cellId,
        score: context.layout.estimateAccessCost(cellId, context.occupancy),
        reason: "Lowest estimated access cost in simple baseline strategy.",
      }))
      .sort((a, b) => a.score - b.score || a.cellId.localeCompare(b.cellId));
  }

  chooseCell(_vehicleId: VehicleId, context: PlacementContext, _rng: RandomSource): CellId | null {
    return this.rankCandidateCells(context)[0]?.cellId ?? null;
  }
}

export class SimpleRetrievalStrategy implements RetrievalStrategy {
  classifyRequest(vehicleId: VehicleId, context: RetrievalContext): RetrievalClass {
    const location = context.occupancy.occupied.find((cell) => cell.vehicleId === vehicleId);
    if (!location) {
      return { blockage: "none", estimatedSeconds: 0 };
    }
    const blockage = context.layout.classifyBlockage(location.cellId, context.occupancy);
    return {
      blockage,
      estimatedSeconds: context.layout.estimateAccessCost(location.cellId, context.occupancy),
    };
  }

  buildRetrievalPlan(vehicleId: VehicleId, context: RetrievalContext): RetrievalPlan {
    const classification = this.classifyRequest(vehicleId, context);
    return {
      vehicleId,
      blockers: [],
      estimatedSeconds: classification.estimatedSeconds,
    };
  }
}

export class NoopElevatorTripPlanner implements ElevatorTripPlanner {
  planNextTrip(): ElevatorTripPlan | null {
    return null;
  }
}

export class FixedPreparationPositionPolicy implements PreparationPositionPolicy {
  chooseAssignments(context: PreparationPositionContext): PreparationPositionAssignment {
    const inboundPositionIds = context.snapshot.preparationPositions
      .filter((position) => position.direction === "inbound")
      .map((position) => position.id);
    const outboundPositionIds = context.snapshot.preparationPositions
      .filter((position) => position.direction === "outbound")
      .map((position) => position.id);
    return { inboundPositionIds, outboundPositionIds };
  }
}

export class NoopUnblockingStrategy implements UnblockingStrategy {
  shouldStartIdleUnblocking(_context: UnblockingContext): boolean {
    return false;
  }

  planUnblocking(_context: UnblockingContext): UnblockingPlan | null {
    return null;
  }
}

export function createBaselineStrategies() {
  return {
    placementStrategy: new LowestCostPlacementStrategy(),
    retrievalStrategy: new SimpleRetrievalStrategy(),
    tripPlanner: new NoopElevatorTripPlanner(),
    ppAssignmentPolicy: new FixedPreparationPositionPolicy(),
    unblockingStrategy: new NoopUnblockingStrategy(),
  };
}
