import type {
  CellId,
  CellOccupancy,
  ElevatorTripAction,
  ElevatorTripActionGroup,
  ElevatorTripPlan,
  ElevatorTripPlanner,
  OccupancyState,
  PreparationPositionState,
  TripPlanningContext,
  VehicleId,
  VmrPath,
} from "../domain/types.js";

interface InboundAssignment {
  vehicleId: VehicleId;
  ppId: string;
  deckIndex: number;
  destination: CellId;
  path: VmrPath;
}

interface ProvisionalBlocker {
  vehicleId: VehicleId;
  cellId: CellId;
  deckIndex: number;
}

interface BlockerAssignment extends ProvisionalBlocker {
  destinationCell: CellId;
  extractionPath: VmrPath;
  relocationPath: VmrPath;
}

interface OutboundAssignment {
  vehicleId: VehicleId;
  cellId: CellId;
  deckIndex: number;
  outboundPpId: string;
  blockers: BlockerAssignment[];
  extractionPath: VmrPath;
}

export class BaselineElevatorTripPlanner implements ElevatorTripPlanner {
  private nextTripNumber = 1;

  planNextTrip(context: TripPlanningContext): ElevatorTripPlan | null {
    const readyInboundPositions = context.snapshot.preparationPositions.filter(
      (position) =>
        position.direction === "inbound" &&
        position.occupiedBy &&
        position.doorState === "open" &&
        (position.readyAt ?? Number.POSITIVE_INFINITY) <= context.time,
    );
    const outboundPps = context.snapshot.preparationPositions.filter(
      (position) =>
        position.direction === "outbound" &&
        !position.occupiedBy &&
        position.doorState === "closed",
    );
    let planningOccupancy = this.cloneOccupancy(context.snapshot.occupancy);
    const outboundAssignments: OutboundAssignment[] = [];
    let maxBlockerDecks = 0;

    for (const queued of context.snapshot.queues.outbound) {
      if (outboundAssignments.length >= outboundPps.length) break;
      const parked = planningOccupancy.occupied.find(
        (cell) => cell.vehicleId === queued.vehicleId,
      );
      if (!parked) continue;
      const accessPlan = context.pathPlanner.findAccessPlan(
        parked.cellId,
        planningOccupancy,
      );
      if (!accessPlan) continue;
      const blockers = accessPlan.blockerCells
        .map((cellId) =>
          planningOccupancy.occupied.find((cell) => cell.cellId === cellId),
        )
        .filter((cell): cell is CellOccupancy => Boolean(cell));
      const targetCount = outboundAssignments.length + 1;
      if (
        targetCount + Math.max(maxBlockerDecks, blockers.length) >
        context.snapshot.elevator.deckCount
      ) {
        continue;
      }

      const usedTargetDecks = new Set(
        outboundAssignments.map((assignment) => assignment.deckIndex),
      );
      const targetDeckIndex = this.firstFreeDeckIndex(
        usedTargetDecks,
        context.snapshot.elevator.deckCount,
      );
      if (targetDeckIndex === null) continue;
      const reserved = new Set([...usedTargetDecks, targetDeckIndex]);
      const provisionalBlockers: ProvisionalBlocker[] = [];
      for (const blocker of blockers) {
        const deckIndex = this.firstFreeDeckIndex(
          reserved,
          context.snapshot.elevator.deckCount,
        );
        if (deckIndex === null) break;
        reserved.add(deckIndex);
        provisionalBlockers.push({
          vehicleId: blocker.vehicleId,
          cellId: blocker.cellId,
          deckIndex,
        });
      }
      if (provisionalBlockers.length !== blockers.length) continue;
      const physicalPlan = this.planOutboundPhysicalPaths(
        parked.cellId,
        provisionalBlockers,
        planningOccupancy,
        context,
      );
      if (!physicalPlan) continue;

      outboundAssignments.push({
        vehicleId: queued.vehicleId,
        cellId: parked.cellId,
        deckIndex: targetDeckIndex,
        outboundPpId: outboundPps[outboundAssignments.length]?.id ?? "",
        blockers: physicalPlan.blockers,
        extractionPath: physicalPlan.extractionPath,
      });
      planningOccupancy = physicalPlan.occupancy;
      maxBlockerDecks = Math.max(maxBlockerDecks, physicalPlan.blockers.length);
    }

    const reservedForOutbound = outboundAssignments.length + maxBlockerDecks;
    const availableInboundDecks = Math.max(
      0,
      context.snapshot.elevator.deckCount - reservedForOutbound,
    );
    const inboundAssignments = this.assignInboundDestinations(
      readyInboundPositions.slice(0, availableInboundDecks),
      outboundAssignments,
      planningOccupancy,
      context,
    );

    if (outboundAssignments.length === 0 && inboundAssignments.length === 0) {
      return this.planIdleUnblockingTrip(context);
    }

    const tripId = `trip-${this.nextTripNumber++}`;
    const groups = this.buildTripGroups(
      inboundAssignments,
      outboundAssignments,
      context,
    );
    return {
      id: tripId,
      phase: "planned",
      stops: this.extractStops(groups),
      inboundVehicleIds: inboundAssignments.map((assignment) => assignment.vehicleId),
      outboundVehicleIds: outboundAssignments.map((assignment) => assignment.vehicleId),
      selectedOutboundVehicleIds: outboundAssignments.map(
        (assignment) => assignment.vehicleId,
      ),
      inducedInboundVehicles: outboundAssignments.reduce(
        (count, assignment) => count + assignment.blockers.length,
        0,
      ),
      groups,
    };
  }

  private assignInboundDestinations(
    positions: PreparationPositionState[],
    outbound: OutboundAssignment[],
    plannedOccupancy: OccupancyState,
    context: TripPlanningContext,
  ): InboundAssignment[] {
    const simulated = this.cloneOccupancy(plannedOccupancy);
    const reservedDecks = new Set(
      outbound.flatMap((assignment) => [
        assignment.deckIndex,
        ...assignment.blockers.map((blocker) => blocker.deckIndex),
      ]),
    );
    const assignments: InboundAssignment[] = [];

    for (const position of positions) {
      if (!position.occupiedBy) continue;
      const deckIndex = this.firstFreeDeckIndex(
        reservedDecks,
        context.snapshot.elevator.deckCount,
      );
      if (deckIndex === null) break;
      const destination = this.chooseAccessibleDestination(
        position.occupiedBy,
        simulated,
        context,
      );
      if (!destination) continue;
      const path = context.pathPlanner.findClearPathFromElevator(
        destination,
        simulated,
      );
      if (!path) continue;
      reservedDecks.add(deckIndex);
      assignments.push({
        vehicleId: position.occupiedBy,
        ppId: position.id,
        deckIndex,
        destination,
        path,
      });
      this.addOccupancy(simulated, destination, position.occupiedBy, context.time);
    }
    return assignments;
  }

  private planOutboundPhysicalPaths(
    outboundCell: CellId,
    blockers: ProvisionalBlocker[],
    occupancy: OccupancyState,
    context: TripPlanningContext,
  ): {
    blockers: BlockerAssignment[];
    extractionPath: VmrPath;
    occupancy: OccupancyState;
  } | null {
    const simulated = this.cloneOccupancy(occupancy);
    const extractions: Array<ProvisionalBlocker & { extractionPath: VmrPath }> = [];
    for (const blocker of blockers) {
      const extractionPath = context.pathPlanner.findClearPathToElevator(
        blocker.cellId,
        simulated,
      );
      if (!extractionPath) return null;
      extractions.push({ ...blocker, extractionPath });
      this.removeVehicleFromOccupancy(simulated, blocker.vehicleId);
    }

    const extractionPath = context.pathPlanner.findClearPathToElevator(
      outboundCell,
      simulated,
    );
    if (!extractionPath) return null;
    const outboundVehicle = simulated.occupied.find(
      (cell) => cell.cellId === outboundCell,
    );
    if (!outboundVehicle) return null;
    this.removeVehicleFromOccupancy(simulated, outboundVehicle.vehicleId);

    const assignments: BlockerAssignment[] = [];
    for (const blocker of extractions) {
      const destinationCell = this.chooseAccessibleDestination(
        blocker.vehicleId,
        simulated,
        context,
      );
      if (!destinationCell) return null;
      const relocationPath = context.pathPlanner.findClearPathFromElevator(
        destinationCell,
        simulated,
      );
      if (!relocationPath) return null;
      assignments.push({ ...blocker, destinationCell, relocationPath });
      this.addOccupancy(
        simulated,
        destinationCell,
        blocker.vehicleId,
        context.time,
      );
    }
    return { blockers: assignments, extractionPath, occupancy: simulated };
  }

  private buildTripGroups(
    inbound: InboundAssignment[],
    outbound: OutboundAssignment[],
    context: TripPlanningContext,
  ): ElevatorTripActionGroup[] {
    const groups: ElevatorTripActionGroup[] = [];
    let plannedElevatorPosition = context.snapshot.elevator.currentFloor;
    const inboundPps = inbound
      .map((assignment) =>
        context.snapshot.preparationPositions.find(
          (position) => position.id === assignment.ppId,
        ),
      )
      .filter((position): position is PreparationPositionState => Boolean(position));

    if (inboundPps.length > 0) {
      groups.push(this.doorGroup("close-inbound-doors", inboundPps, "closed", context));
      groups.push(
        this.rotateDeckGroup(
          "rotate-inbound-to-street",
          inbound.map((assignment) => assignment.deckIndex),
          "street",
          context,
        ),
      );
      groups.push({
        name: "load-inbound",
        actions: inbound.map((assignment) => ({
          type: "LoadInbound",
          vehicleId: assignment.vehicleId,
          from: assignment.ppId,
          to: this.deckId(assignment.deckIndex),
          deckIndex: assignment.deckIndex,
          preparationPositionId: assignment.ppId,
          durationSeconds: this.ppTransferSeconds(assignment.ppId, context),
        })),
      });
      groups.push(
        this.rotateDeckGroup(
          "rotate-inbound-to-garage",
          inbound.map((assignment) => assignment.deckIndex),
          "garage",
          context,
        ),
      );
      groups.push(this.doorGroup("open-inbound-doors", inboundPps, "open", context));
    }

    for (const assignment of outbound) {
      for (const blocker of assignment.blockers) {
        const position = this.alignmentPosition(
          context.layout.getCellFloor(blocker.cellId),
          blocker.deckIndex,
        );
        groups.push(this.moveElevatorGroup(position, plannedElevatorPosition, context));
        plannedElevatorPosition = position;
        groups.push({
          name: `buffer-blocker-${blocker.vehicleId}`,
          actions: [
            {
              type: "MoveBlocker",
              vehicleId: blocker.vehicleId,
              from: blocker.cellId,
              to: this.deckId(blocker.deckIndex),
              path: blocker.extractionPath,
              deckIndex: blocker.deckIndex,
              durationSeconds: this.pathTransferSeconds(blocker.extractionPath, context),
            },
          ],
        });
      }

      const targetPosition = this.alignmentPosition(
        context.layout.getCellFloor(assignment.cellId),
        assignment.deckIndex,
      );
      groups.push(
        this.moveElevatorGroup(targetPosition, plannedElevatorPosition, context),
      );
      plannedElevatorPosition = targetPosition;
      groups.push({
        name: `load-outbound-${assignment.vehicleId}`,
        actions: [
          {
            type: "LoadOutbound",
            vehicleId: assignment.vehicleId,
            from: assignment.cellId,
            to: this.deckId(assignment.deckIndex),
            path: assignment.extractionPath,
            deckIndex: assignment.deckIndex,
            durationSeconds: this.pathTransferSeconds(assignment.extractionPath, context),
          },
        ],
      });

      for (const blocker of assignment.blockers) {
        const position = this.alignmentPosition(
          context.layout.getCellFloor(blocker.destinationCell),
          blocker.deckIndex,
        );
        groups.push(this.moveElevatorGroup(position, plannedElevatorPosition, context));
        plannedElevatorPosition = position;
        groups.push({
          name: `relocate-blocker-${blocker.vehicleId}`,
          actions: [
            {
              type: "RelocateBlocker",
              vehicleId: blocker.vehicleId,
              from: this.deckId(blocker.deckIndex),
              to: blocker.destinationCell,
              path: blocker.relocationPath,
              deckIndex: blocker.deckIndex,
              durationSeconds: this.pathTransferSeconds(blocker.relocationPath, context),
            },
          ],
        });
      }
    }

    for (const assignment of inbound) {
      const position = this.alignmentPosition(
        context.layout.getCellFloor(assignment.destination),
        assignment.deckIndex,
      );
      groups.push(this.moveElevatorGroup(position, plannedElevatorPosition, context));
      plannedElevatorPosition = position;
      groups.push({
        name: `park-inbound-${assignment.vehicleId}`,
        elevatorDirection: "down",
        actions: [
          {
            type: "ParkInbound",
            vehicleId: assignment.vehicleId,
            from: this.deckId(assignment.deckIndex),
            to: assignment.destination,
            path: assignment.path,
            deckIndex: assignment.deckIndex,
            durationSeconds: this.pathTransferSeconds(assignment.path, context),
          },
        ],
      });
    }

    groups.push(this.moveElevatorGroup(1, plannedElevatorPosition, context));

    if (outbound.length > 0) {
      groups.push(
        this.rotateDeckGroup(
          "rotate-outbound-to-street",
          outbound.map((assignment) => assignment.deckIndex),
          "street",
          context,
        ),
      );
      groups.push({
        name: "unload-outbound",
        actions: outbound.map((assignment) => ({
          type: "RetrieveOutbound",
          vehicleId: assignment.vehicleId,
          from: this.deckId(assignment.deckIndex),
          to: assignment.outboundPpId,
          deckIndex: assignment.deckIndex,
          preparationPositionId: assignment.outboundPpId,
          durationSeconds: this.ppTransferSeconds(assignment.outboundPpId, context),
        })),
      });
      const outboundPps = outbound
        .map((assignment) =>
          context.snapshot.preparationPositions.find(
            (position) => position.id === assignment.outboundPpId,
          ),
        )
        .filter((position): position is PreparationPositionState => Boolean(position));
      groups.push(
        this.doorGroup("open-outbound-doors", outboundPps, "open", context, true),
      );
      groups.push(
        this.rotateDeckGroup(
          "rotate-outbound-to-garage",
          outbound.map((assignment) => assignment.deckIndex),
          "garage",
          context,
        ),
      );
    }

    return groups.filter((group) => group.actions.length > 0);
  }

  private planIdleUnblockingTrip(
    context: TripPlanningContext,
  ): ElevatorTripPlan | null {
    if (
      !context.idleUnblockingAllowed ||
      context.snapshot.queues.inbound.length > 0 ||
      context.snapshot.queues.outbound.length > 0 ||
      context.snapshot.preparationPositions.some((position) => position.occupiedBy)
    ) {
      return null;
    }

    const occupancy = context.snapshot.occupancy;
    for (const target of occupancy.occupied) {
      const blockerCell = context.pathPlanner.findAccessPlan(
        target.cellId,
        occupancy,
      )?.blockerCells[0];
      if (!blockerCell) continue;
      const blocker = occupancy.occupied.find((cell) => cell.cellId === blockerCell);
      if (!blocker) continue;
      const extractionPath = context.pathPlanner.findClearPathToElevator(
        blockerCell,
        occupancy,
      );
      if (!extractionPath) continue;

      const simulated = this.cloneOccupancy(occupancy);
      this.removeVehicleFromOccupancy(simulated, blocker.vehicleId);
      const destination = this.chooseAccessibleDestination(
        blocker.vehicleId,
        simulated,
        context,
      );
      if (!destination || destination === blockerCell) continue;
      const relocationPath = context.pathPlanner.findClearPathFromElevator(
        destination,
        simulated,
      );
      if (!relocationPath) continue;

      const sourcePosition = this.alignmentPosition(
        context.layout.getCellFloor(blockerCell),
        0,
      );
      const destinationPosition = this.alignmentPosition(
        context.layout.getCellFloor(destination),
        0,
      );
      const groups = [
        this.moveElevatorGroup(
          sourcePosition,
          context.snapshot.elevator.currentFloor,
          context,
        ),
        {
          name: `buffer-idle-blocker-${blocker.vehicleId}`,
          actions: [
            {
              type: "MoveBlocker" as const,
              vehicleId: blocker.vehicleId,
              from: blockerCell,
              to: this.deckId(0),
              path: extractionPath,
              deckIndex: 0,
              durationSeconds: this.pathTransferSeconds(extractionPath, context),
            },
          ],
        },
        this.moveElevatorGroup(destinationPosition, sourcePosition, context),
        {
          name: `relocate-idle-blocker-${blocker.vehicleId}`,
          actions: [
            {
              type: "IdleUnblock" as const,
              vehicleId: blocker.vehicleId,
              from: this.deckId(0),
              to: destination,
              path: relocationPath,
              deckIndex: 0,
              durationSeconds: this.pathTransferSeconds(relocationPath, context),
            },
          ],
        },
        this.moveElevatorGroup(1, destinationPosition, context),
      ];
      return {
        id: `unblock-${this.nextTripNumber++}`,
        phase: "idle-unblocking",
        stops: [sourcePosition, destinationPosition, 1],
        inboundVehicleIds: [],
        outboundVehicleIds: [],
        selectedOutboundVehicleIds: [],
        inducedInboundVehicles: 0,
        groups,
      };
    }
    return null;
  }

  private moveElevatorGroup(
    targetPosition: number,
    from: number,
    context: TripPlanningContext,
  ): ElevatorTripActionGroup {
    const floorDistance = Math.abs(targetPosition - from);
    const duration = Math.ceil(
      (floorDistance * context.config.elevator.floorHeightMeters) /
        context.config.elevator.verticalSpeedMetersPerSecond,
    );
    return {
      name: `move-elevator-${targetPosition}`,
      elevatorDirection:
        targetPosition > from ? "up" : targetPosition < from ? "down" : "stopped",
      actions: [
        {
          type: "MoveElevator",
          from: `elevator-position-${from}`,
          to: `elevator-position-${targetPosition}`,
          durationSeconds: Math.max(1, duration),
        },
      ],
    };
  }

  private rotateDeckGroup(
    name: string,
    deckIndexes: number[],
    orientation: "garage" | "street",
    context: TripPlanningContext,
  ): ElevatorTripActionGroup {
    return {
      name,
      actions: [...new Set(deckIndexes)].map((deckIndex) => ({
        type: "RotateDeck",
        from: orientation === "garage" ? "street" : "garage",
        to: orientation,
        deckIndex,
        durationSeconds: context.config.elevator.deckRotationSeconds,
      })),
    };
  }

  private doorGroup(
    name: string,
    positions: PreparationPositionState[],
    finalState: "open" | "closed",
    context: TripPlanningContext,
    setDriverReady = false,
  ): ElevatorTripActionGroup {
    return {
      name,
      actions: positions.map((position) => ({
        type: "OperateDoor",
        from:
          position.doorState ??
          (position.direction === "inbound" ? "open" : "closed"),
        to: finalState,
        preparationPositionId: position.id,
        doorFinalState: finalState,
        setDriverReady,
        durationSeconds: context.config.preparationPositions.doorSeconds,
      })),
    };
  }

  private chooseAccessibleDestination(
    vehicleId: VehicleId,
    occupancy: OccupancyState,
    context: TripPlanningContext,
  ): CellId | null {
    const ranked = context.placementStrategy.rankCandidateCells({
      time: context.time,
      layout: context.layout,
      occupancy,
    });
    for (const candidate of ranked) {
      if (
        context.pathPlanner.findClearPathFromElevator(
          candidate.cellId,
          occupancy,
        )
      ) {
        return candidate.cellId;
      }
    }
    return null;
  }

  private ppTransferSeconds(
    ppId: string,
    context: TripPlanningContext,
  ): number {
    const positionNumber = Number(/\d+$/.exec(ppId)?.[0] ?? 1);
    const oneWayDistance = Math.max(3, positionNumber * 3);
    return Math.ceil(
      (oneWayDistance * 2) / context.config.vmr.speedMetersPerSecond +
        context.config.vmr.gripReleaseSeconds * 2,
    );
  }

  private pathTransferSeconds(
    path: VmrPath,
    context: TripPlanningContext,
  ): number {
    return Math.ceil(
      path.distanceMeters / context.config.vmr.speedMetersPerSecond +
        context.config.vmr.gripReleaseSeconds * 2,
    );
  }

  private extractStops(groups: ElevatorTripActionGroup[]): number[] {
    return groups
      .filter((group) => group.name.startsWith("move-elevator-"))
      .map((group) => Number(group.name.slice("move-elevator-".length)));
  }

  private firstFreeDeckIndex(
    reserved: Set<number>,
    deckCount: number,
  ): number | null {
    for (let index = 0; index < deckCount; index += 1) {
      if (!reserved.has(index)) return index;
    }
    return null;
  }

  private alignmentPosition(floor: number, deckIndex: number): number {
    return floor + deckIndex;
  }

  private deckId(index: number): string {
    return `D${index + 1}`;
  }

  private cloneOccupancy(occupancy: OccupancyState): OccupancyState {
    return {
      ...occupancy,
      occupied: occupancy.occupied.map((cell) => ({ ...cell })),
    };
  }

  private addOccupancy(
    occupancy: OccupancyState,
    cellId: CellId,
    vehicleId: VehicleId,
    parkedAt: number,
  ): void {
    occupancy.occupied.push({ cellId, vehicleId, parkedAt });
    occupancy.occupiedCount = occupancy.occupied.length;
    occupancy.occupancyPercent =
      occupancy.totalParkingCells === 0
        ? 0
        : occupancy.occupiedCount / occupancy.totalParkingCells;
  }

  private removeVehicleFromOccupancy(
    occupancy: OccupancyState,
    vehicleId: VehicleId,
  ): void {
    occupancy.occupied = occupancy.occupied.filter(
      (cell) => cell.vehicleId !== vehicleId,
    );
    occupancy.occupiedCount = occupancy.occupied.length;
    occupancy.occupancyPercent =
      occupancy.totalParkingCells === 0
        ? 0
        : occupancy.occupiedCount / occupancy.totalParkingCells;
  }
}
