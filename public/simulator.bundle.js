define("domain/types", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
});
define("garage/occupancy", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.effectiveOccupiedCellIds = effectiveOccupiedCellIds;
    exports.effectiveOccupiedCells = effectiveOccupiedCells;
    function effectiveOccupiedCellIds(occupancy) {
        return new Set(effectiveOccupiedCells(occupancy).map((cell) => cell.cellId));
    }
    function effectiveOccupiedCells(occupancy) {
        const byCell = new Map();
        for (const cell of occupancy.occupied) {
            byCell.set(cell.cellId, { cellId: cell.cellId, vehicleId: cell.vehicleId });
        }
        for (const reservation of occupancy.reservations ?? []) {
            if (!byCell.has(reservation.cellId)) {
                byCell.set(reservation.cellId, {
                    cellId: reservation.cellId,
                    vehicleId: reservation.vehicleId,
                });
            }
        }
        return [...byCell.values()];
    }
});
define("garage/strategies", ["require", "exports", "garage/occupancy"], function (require, exports, occupancy_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IdleAfterTenMinutesUnblockingStrategy = exports.NoopUnblockingStrategy = exports.FixedPreparationPositionPolicy = exports.SimpleRetrievalStrategy = exports.FirstAvailablePlacementStrategy = exports.LowestCostPlacementStrategy = void 0;
    class LowestCostPlacementStrategy {
        rankCandidateCells(context) {
            const occupied = (0, occupancy_js_1.effectiveOccupiedCellIds)(context.occupancy);
            return context.layout
                .getParkingCells()
                .filter((cellId) => !occupied.has(cellId))
                .filter((cellId) => !context.layout.wouldCreateBlockedEmptyCell(cellId, context.occupancy))
                .map((cellId) => ({
                cellId,
                score: context.layout.estimateAccessCost(cellId, context.occupancy),
                reason: "Lowest estimated access cost in simple baseline strategy.",
            }))
                .sort((a, b) => a.score - b.score || a.cellId.localeCompare(b.cellId));
        }
        chooseCell(_vehicleId, context, _rng) {
            return this.rankCandidateCells(context)[0]?.cellId ?? null;
        }
    }
    exports.LowestCostPlacementStrategy = LowestCostPlacementStrategy;
    class FirstAvailablePlacementStrategy {
        rankCandidateCells(context) {
            const occupied = (0, occupancy_js_1.effectiveOccupiedCellIds)(context.occupancy);
            return context.layout
                .getParkingCells()
                .filter((cellId) => !occupied.has(cellId))
                .filter((cellId) => !context.layout.wouldCreateBlockedEmptyCell(cellId, context.occupancy))
                .map((cellId, index) => ({
                cellId,
                score: index,
                reason: "First available cell in layout order.",
            }));
        }
        chooseCell(_vehicleId, context, _rng) {
            return this.rankCandidateCells(context)[0]?.cellId ?? null;
        }
    }
    exports.FirstAvailablePlacementStrategy = FirstAvailablePlacementStrategy;
    class SimpleRetrievalStrategy {
        classifyRequest(vehicleId, context) {
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
        buildRetrievalPlan(vehicleId, context) {
            const classification = this.classifyRequest(vehicleId, context);
            return {
                vehicleId,
                blockers: [],
                estimatedSeconds: classification.estimatedSeconds,
            };
        }
    }
    exports.SimpleRetrievalStrategy = SimpleRetrievalStrategy;
    class FixedPreparationPositionPolicy {
        chooseAssignments(context) {
            const inboundPositionIds = context.snapshot.preparationPositions
                .filter((position) => position.direction === "inbound")
                .map((position) => position.id);
            const outboundPositionIds = context.snapshot.preparationPositions
                .filter((position) => position.direction === "outbound")
                .map((position) => position.id);
            return { inboundPositionIds, outboundPositionIds };
        }
    }
    exports.FixedPreparationPositionPolicy = FixedPreparationPositionPolicy;
    class NoopUnblockingStrategy {
        shouldStartIdleUnblocking(_context) {
            return false;
        }
        planUnblocking(_context) {
            return null;
        }
    }
    exports.NoopUnblockingStrategy = NoopUnblockingStrategy;
    class IdleAfterTenMinutesUnblockingStrategy {
        shouldStartIdleUnblocking(context) {
            return context.idleSeconds >= 600;
        }
        planUnblocking(_context) {
            return { operations: [] };
        }
    }
    exports.IdleAfterTenMinutesUnblockingStrategy = IdleAfterTenMinutesUnblockingStrategy;
});
define("garage/elevator-trip-planner", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BaselineElevatorTripPlanner = void 0;
    class BaselineElevatorTripPlanner {
        constructor() {
            this.nextTripNumber = 1;
        }
        planNextTrip(context) {
            const readyInboundPositions = context.snapshot.preparationPositions.filter((position) => position.direction === "inbound" &&
                position.occupiedBy &&
                position.doorState === "open" &&
                (position.readyAt ?? Number.POSITIVE_INFINITY) <= context.time);
            const outboundPps = context.snapshot.preparationPositions.filter((position) => position.direction === "outbound" &&
                !position.occupiedBy &&
                position.doorState === "closed");
            let planningOccupancy = this.cloneOccupancy(context.snapshot.occupancy);
            const outboundAssignments = [];
            let maxBlockerDecks = 0;
            for (const queued of context.snapshot.queues.outbound) {
                if (outboundAssignments.length >= outboundPps.length)
                    break;
                const parked = planningOccupancy.occupied.find((cell) => cell.vehicleId === queued.vehicleId);
                if (!parked)
                    continue;
                const accessPlan = context.pathPlanner.findAccessPlan(parked.cellId, planningOccupancy);
                if (!accessPlan)
                    continue;
                const blockers = accessPlan.blockerCells
                    .map((cellId) => planningOccupancy.occupied.find((cell) => cell.cellId === cellId))
                    .filter((cell) => Boolean(cell));
                const targetCount = outboundAssignments.length + 1;
                if (targetCount + Math.max(maxBlockerDecks, blockers.length) >
                    context.snapshot.elevator.deckCount) {
                    continue;
                }
                const usedTargetDecks = new Set(outboundAssignments.map((assignment) => assignment.deckIndex));
                const targetDeckIndex = this.firstFreeDeckIndex(usedTargetDecks, context.snapshot.elevator.deckCount);
                if (targetDeckIndex === null)
                    continue;
                const reserved = new Set([...usedTargetDecks, targetDeckIndex]);
                const provisionalBlockers = [];
                for (const blocker of blockers) {
                    const deckIndex = this.firstFreeDeckIndex(reserved, context.snapshot.elevator.deckCount);
                    if (deckIndex === null)
                        break;
                    reserved.add(deckIndex);
                    provisionalBlockers.push({
                        vehicleId: blocker.vehicleId,
                        cellId: blocker.cellId,
                        deckIndex,
                    });
                }
                if (provisionalBlockers.length !== blockers.length)
                    continue;
                const physicalPlan = this.planOutboundPhysicalPaths(parked.cellId, provisionalBlockers, planningOccupancy, context);
                if (!physicalPlan)
                    continue;
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
            const availableInboundDecks = Math.max(0, context.snapshot.elevator.deckCount - reservedForOutbound);
            const inboundAssignments = this.assignInboundDestinations(readyInboundPositions.slice(0, availableInboundDecks), outboundAssignments, planningOccupancy, context);
            if (outboundAssignments.length === 0 && inboundAssignments.length === 0) {
                return this.planIdleUnblockingTrip(context);
            }
            const tripId = `trip-${this.nextTripNumber++}`;
            const groups = this.buildTripGroups(inboundAssignments, outboundAssignments, context);
            return {
                id: tripId,
                phase: "planned",
                stops: this.extractStops(groups),
                inboundVehicleIds: inboundAssignments.map((assignment) => assignment.vehicleId),
                outboundVehicleIds: outboundAssignments.map((assignment) => assignment.vehicleId),
                selectedOutboundVehicleIds: outboundAssignments.map((assignment) => assignment.vehicleId),
                inducedInboundVehicles: outboundAssignments.reduce((count, assignment) => count + assignment.blockers.length, 0),
                groups,
            };
        }
        assignInboundDestinations(positions, outbound, plannedOccupancy, context) {
            const simulated = this.cloneOccupancy(plannedOccupancy);
            const reservedDecks = new Set(outbound.flatMap((assignment) => [
                assignment.deckIndex,
                ...assignment.blockers.map((blocker) => blocker.deckIndex),
            ]));
            const assignments = [];
            for (const position of positions) {
                if (!position.occupiedBy)
                    continue;
                const deckIndex = this.firstFreeDeckIndex(reservedDecks, context.snapshot.elevator.deckCount);
                if (deckIndex === null)
                    break;
                const destination = this.chooseAccessibleDestination(position.occupiedBy, simulated, context);
                if (!destination)
                    continue;
                const path = context.pathPlanner.findClearPathFromElevator(destination, simulated);
                if (!path)
                    continue;
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
        planOutboundPhysicalPaths(outboundCell, blockers, occupancy, context) {
            const simulated = this.cloneOccupancy(occupancy);
            const extractions = [];
            for (const blocker of blockers) {
                const extractionPath = context.pathPlanner.findClearPathToElevator(blocker.cellId, simulated);
                if (!extractionPath)
                    return null;
                extractions.push({ ...blocker, extractionPath });
                this.removeVehicleFromOccupancy(simulated, blocker.vehicleId);
            }
            const extractionPath = context.pathPlanner.findClearPathToElevator(outboundCell, simulated);
            if (!extractionPath)
                return null;
            const outboundVehicle = simulated.occupied.find((cell) => cell.cellId === outboundCell);
            if (!outboundVehicle)
                return null;
            this.removeVehicleFromOccupancy(simulated, outboundVehicle.vehicleId);
            const assignments = [];
            for (const blocker of extractions) {
                const destinationCell = this.chooseAccessibleDestination(blocker.vehicleId, simulated, context);
                if (!destinationCell)
                    return null;
                const relocationPath = context.pathPlanner.findClearPathFromElevator(destinationCell, simulated);
                if (!relocationPath)
                    return null;
                assignments.push({ ...blocker, destinationCell, relocationPath });
                this.addOccupancy(simulated, destinationCell, blocker.vehicleId, context.time);
            }
            return { blockers: assignments, extractionPath, occupancy: simulated };
        }
        buildTripGroups(inbound, outbound, context) {
            const groups = [];
            let plannedElevatorPosition = context.snapshot.elevator.currentFloor;
            const inboundPps = inbound
                .map((assignment) => context.snapshot.preparationPositions.find((position) => position.id === assignment.ppId))
                .filter((position) => Boolean(position));
            if (inboundPps.length > 0) {
                groups.push(this.doorGroup("close-inbound-doors", inboundPps, "closed", context));
                groups.push(this.rotateDeckGroup("rotate-inbound-to-street", inbound.map((assignment) => assignment.deckIndex), "street", context));
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
                groups.push(this.rotateDeckGroup("rotate-inbound-to-garage", inbound.map((assignment) => assignment.deckIndex), "garage", context));
                groups.push(this.doorGroup("open-inbound-doors", inboundPps, "open", context));
            }
            for (const assignment of outbound) {
                for (const blocker of assignment.blockers) {
                    const position = this.alignmentPosition(context.layout.getCellFloor(blocker.cellId), blocker.deckIndex);
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
                const targetPosition = this.alignmentPosition(context.layout.getCellFloor(assignment.cellId), assignment.deckIndex);
                groups.push(this.moveElevatorGroup(targetPosition, plannedElevatorPosition, context));
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
                    const position = this.alignmentPosition(context.layout.getCellFloor(blocker.destinationCell), blocker.deckIndex);
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
                const position = this.alignmentPosition(context.layout.getCellFloor(assignment.destination), assignment.deckIndex);
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
                groups.push(this.rotateDeckGroup("rotate-outbound-to-street", outbound.map((assignment) => assignment.deckIndex), "street", context));
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
                    .map((assignment) => context.snapshot.preparationPositions.find((position) => position.id === assignment.outboundPpId))
                    .filter((position) => Boolean(position));
                groups.push(this.doorGroup("open-outbound-doors", outboundPps, "open", context, true));
                groups.push(this.rotateDeckGroup("rotate-outbound-to-garage", outbound.map((assignment) => assignment.deckIndex), "garage", context));
            }
            return groups.filter((group) => group.actions.length > 0);
        }
        planIdleUnblockingTrip(context) {
            if (!context.idleUnblockingAllowed ||
                context.snapshot.queues.inbound.length > 0 ||
                context.snapshot.queues.outbound.length > 0 ||
                context.snapshot.preparationPositions.some((position) => position.occupiedBy)) {
                return null;
            }
            const occupancy = context.snapshot.occupancy;
            for (const target of occupancy.occupied) {
                const blockerCell = context.pathPlanner.findAccessPlan(target.cellId, occupancy)?.blockerCells[0];
                if (!blockerCell)
                    continue;
                const blocker = occupancy.occupied.find((cell) => cell.cellId === blockerCell);
                if (!blocker)
                    continue;
                const extractionPath = context.pathPlanner.findClearPathToElevator(blockerCell, occupancy);
                if (!extractionPath)
                    continue;
                const simulated = this.cloneOccupancy(occupancy);
                this.removeVehicleFromOccupancy(simulated, blocker.vehicleId);
                const destination = this.chooseAccessibleDestination(blocker.vehicleId, simulated, context);
                if (!destination || destination === blockerCell)
                    continue;
                const relocationPath = context.pathPlanner.findClearPathFromElevator(destination, simulated);
                if (!relocationPath)
                    continue;
                const sourcePosition = this.alignmentPosition(context.layout.getCellFloor(blockerCell), 0);
                const destinationPosition = this.alignmentPosition(context.layout.getCellFloor(destination), 0);
                const groups = [
                    this.moveElevatorGroup(sourcePosition, context.snapshot.elevator.currentFloor, context),
                    {
                        name: `buffer-idle-blocker-${blocker.vehicleId}`,
                        actions: [
                            {
                                type: "MoveBlocker",
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
                                type: "IdleUnblock",
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
        moveElevatorGroup(targetPosition, from, context) {
            const floorDistance = Math.abs(targetPosition - from);
            const duration = Math.ceil((floorDistance * context.config.elevator.floorHeightMeters) /
                context.config.elevator.verticalSpeedMetersPerSecond);
            return {
                name: `move-elevator-${targetPosition}`,
                elevatorDirection: targetPosition > from ? "up" : targetPosition < from ? "down" : "stopped",
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
        rotateDeckGroup(name, deckIndexes, orientation, context) {
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
        doorGroup(name, positions, finalState, context, setDriverReady = false) {
            return {
                name,
                actions: positions.map((position) => ({
                    type: "OperateDoor",
                    from: position.doorState ??
                        (position.direction === "inbound" ? "open" : "closed"),
                    to: finalState,
                    preparationPositionId: position.id,
                    doorFinalState: finalState,
                    setDriverReady,
                    durationSeconds: context.config.preparationPositions.doorSeconds,
                })),
            };
        }
        chooseAccessibleDestination(vehicleId, occupancy, context) {
            const ranked = context.placementStrategy.rankCandidateCells({
                time: context.time,
                layout: context.layout,
                occupancy,
            });
            for (const candidate of ranked) {
                if (context.pathPlanner.findClearPathFromElevator(candidate.cellId, occupancy)) {
                    return candidate.cellId;
                }
            }
            return null;
        }
        ppTransferSeconds(ppId, context) {
            const positionNumber = Number(/\d+$/.exec(ppId)?.[0] ?? 1);
            const oneWayDistance = Math.max(3, positionNumber * 3);
            return Math.ceil((oneWayDistance * 2) / context.config.vmr.speedMetersPerSecond +
                context.config.vmr.gripReleaseSeconds * 2);
        }
        pathTransferSeconds(path, context) {
            return Math.ceil(path.distanceMeters / context.config.vmr.speedMetersPerSecond +
                context.config.vmr.gripReleaseSeconds * 2);
        }
        extractStops(groups) {
            return groups
                .filter((group) => group.name.startsWith("move-elevator-"))
                .map((group) => Number(group.name.slice("move-elevator-".length)));
        }
        firstFreeDeckIndex(reserved, deckCount) {
            for (let index = 0; index < deckCount; index += 1) {
                if (!reserved.has(index))
                    return index;
            }
            return null;
        }
        alignmentPosition(floor, deckIndex) {
            return floor + deckIndex;
        }
        deckId(index) {
            return `D${index + 1}`;
        }
        cloneOccupancy(occupancy) {
            return {
                ...occupancy,
                occupied: occupancy.occupied.map((cell) => ({ ...cell })),
                reservations: (occupancy.reservations ?? []).map((reservation) => ({
                    ...reservation,
                })),
            };
        }
        addOccupancy(occupancy, cellId, vehicleId, parkedAt) {
            occupancy.reservations = (occupancy.reservations ?? []).filter((reservation) => reservation.cellId !== cellId && reservation.vehicleId !== vehicleId);
            occupancy.occupied.push({ cellId, vehicleId, parkedAt });
            this.recalculateOccupancyCounts(occupancy);
        }
        removeVehicleFromOccupancy(occupancy, vehicleId) {
            occupancy.occupied = occupancy.occupied.filter((cell) => cell.vehicleId !== vehicleId);
            occupancy.reservations = (occupancy.reservations ?? []).filter((reservation) => reservation.vehicleId !== vehicleId);
            this.recalculateOccupancyCounts(occupancy);
        }
        recalculateOccupancyCounts(occupancy) {
            occupancy.occupiedCount = occupancy.occupied.length;
            const occupiedCellIds = new Set(occupancy.occupied.map((cell) => cell.cellId));
            const reservedCount = (occupancy.reservations ?? []).filter((reservation) => !occupiedCellIds.has(reservation.cellId)).length;
            occupancy.reservedCount = reservedCount;
            occupancy.effectiveOccupiedCount = occupancy.occupiedCount + reservedCount;
            occupancy.occupancyPercent =
                occupancy.totalParkingCells === 0
                    ? 0
                    : occupancy.occupiedCount / occupancy.totalParkingCells;
            occupancy.effectiveOccupancyPercent =
                occupancy.totalParkingCells === 0
                    ? 0
                    : occupancy.effectiveOccupiedCount / occupancy.totalParkingCells;
        }
    }
    exports.BaselineElevatorTripPlanner = BaselineElevatorTripPlanner;
});
define("garage/strategy-registry", ["require", "exports", "garage/strategies", "garage/elevator-trip-planner"], function (require, exports, strategies_js_1, elevator_trip_planner_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultGarageStrategyConfig = void 0;
    exports.createGarageStrategies = createGarageStrategies;
    exports.normalizeGarageStrategyConfig = normalizeGarageStrategyConfig;
    exports.validateGarageStrategyConfig = validateGarageStrategyConfig;
    exports.getStrategyDescriptors = getStrategyDescriptors;
    exports.defaultGarageStrategyConfig = {
        placement: { type: "lowest-access-cost" },
        retrieval: { type: "simple-retrieval" },
        tripPlanner: { type: "baseline-physical" },
        preparationPositions: { type: "fixed-assignment" },
        unblocking: { type: "idle-after-10-minutes" },
    };
    const placementRegistry = {
        factories: {
            "lowest-access-cost": (options) => {
                requireNoOptions("lowest-access-cost", options);
                return new strategies_js_1.LowestCostPlacementStrategy();
            },
            "first-available": (options) => {
                requireNoOptions("first-available", options);
                return new strategies_js_1.FirstAvailablePlacementStrategy();
            },
        },
        descriptors: [
            {
                category: "placement",
                type: "lowest-access-cost",
                label: "Lowest Access Cost",
                description: "Chooses the empty cell with the lowest estimated elevator, movement, and blockage cost.",
            },
            {
                category: "placement",
                type: "first-available",
                label: "First Available",
                description: "Chooses the first empty parking cell in layout order.",
            },
        ],
    };
    const retrievalRegistry = {
        factories: {
            "simple-retrieval": (options) => {
                requireNoOptions("simple-retrieval", options);
                return new strategies_js_1.SimpleRetrievalStrategy();
            },
        },
        descriptors: [
            {
                category: "retrieval",
                type: "simple-retrieval",
                label: "Simple Retrieval",
                description: "Classifies blockage and estimates retrieval cost without moving blockers.",
            },
        ],
    };
    const tripPlannerRegistry = {
        factories: {
            "baseline-physical": (options) => {
                requireNoOptions("baseline-physical", options);
                return new elevator_trip_planner_js_1.BaselineElevatorTripPlanner();
            },
            "single-operation": (options) => {
                requireNoOptions("single-operation", options);
                return new elevator_trip_planner_js_1.BaselineElevatorTripPlanner();
            },
        },
        descriptors: [
            {
                category: "tripPlanner",
                type: "baseline-physical",
                label: "Baseline Physical Planner",
                description: "Builds elevator trips with deck assignments, blocker moves, explicit VMR paths, and PP transfers.",
            },
        ],
    };
    const preparationPositionRegistry = {
        factories: {
            "fixed-assignment": (options) => {
                requireNoOptions("fixed-assignment", options);
                return new strategies_js_1.FixedPreparationPositionPolicy();
            },
        },
        descriptors: [
            {
                category: "preparationPositions",
                type: "fixed-assignment",
                label: "Fixed Assignment",
                description: "Keeps preparation positions assigned to their configured inbound or outbound direction.",
            },
        ],
    };
    const unblockingRegistry = {
        factories: {
            "idle-after-10-minutes": (options) => {
                requireNoOptions("idle-after-10-minutes", options);
                return new strategies_js_1.IdleAfterTenMinutesUnblockingStrategy();
            },
            disabled: (options) => {
                requireNoOptions("disabled", options);
                return new strategies_js_1.NoopUnblockingStrategy();
            },
        },
        descriptors: [
            {
                category: "unblocking",
                type: "idle-after-10-minutes",
                label: "Idle After 10 Minutes",
                description: "Relocates blocking vehicles after ten minutes without normal demand.",
            },
            {
                category: "unblocking",
                type: "disabled",
                label: "Disabled",
                description: "Does not initiate idle unblocking operations.",
            },
        ],
    };
    function createGarageStrategies(config) {
        const normalized = normalizeGarageStrategyConfig(config);
        return {
            placementStrategy: createFromRegistry(placementRegistry, normalized.placement),
            retrievalStrategy: createFromRegistry(retrievalRegistry, normalized.retrieval),
            tripPlanner: createFromRegistry(tripPlannerRegistry, normalized.tripPlanner),
            ppAssignmentPolicy: createFromRegistry(preparationPositionRegistry, normalized.preparationPositions),
            unblockingStrategy: createFromRegistry(unblockingRegistry, normalized.unblocking),
        };
    }
    function normalizeGarageStrategyConfig(config) {
        if (!config) {
            return cloneDefaultConfig();
        }
        return {
            placement: config.placement ?? { ...exports.defaultGarageStrategyConfig.placement },
            retrieval: config.retrieval ?? { ...exports.defaultGarageStrategyConfig.retrieval },
            tripPlanner: config.tripPlanner ?? { ...exports.defaultGarageStrategyConfig.tripPlanner },
            preparationPositions: config.preparationPositions ?? { ...exports.defaultGarageStrategyConfig.preparationPositions },
            unblocking: config.unblocking ?? { ...exports.defaultGarageStrategyConfig.unblocking },
        };
    }
    function validateGarageStrategyConfig(config) {
        if (!config)
            return [];
        const normalized = normalizeGarageStrategyConfig(config);
        return [
            ...validateSelection("placement", placementRegistry, normalized.placement),
            ...validateSelection("retrieval", retrievalRegistry, normalized.retrieval),
            ...validateSelection("tripPlanner", tripPlannerRegistry, normalized.tripPlanner),
            ...validateSelection("preparationPositions", preparationPositionRegistry, normalized.preparationPositions),
            ...validateSelection("unblocking", unblockingRegistry, normalized.unblocking),
        ];
    }
    function getStrategyDescriptors() {
        return [
            ...placementRegistry.descriptors,
            ...retrievalRegistry.descriptors,
            ...tripPlannerRegistry.descriptors,
            ...preparationPositionRegistry.descriptors,
            ...unblockingRegistry.descriptors,
        ];
    }
    function createFromRegistry(registry, selection) {
        const factory = registry.factories[selection.type];
        if (!factory) {
            throw new Error(unknownStrategyMessage(selection.type, registry));
        }
        return factory(selection.options ?? {});
    }
    function validateSelection(category, registry, selection) {
        if (!selection || typeof selection.type !== "string" || selection.type.length === 0) {
            return [`garage.strategies.${category}.type is required.`];
        }
        const factory = registry.factories[selection.type];
        if (!factory) {
            return [`garage.strategies.${category}: ${unknownStrategyMessage(selection.type, registry)}`];
        }
        try {
            factory(selection.options ?? {});
            return [];
        }
        catch (error) {
            return [
                `garage.strategies.${category}.${selection.type}: ${error instanceof Error ? error.message : String(error)}`,
            ];
        }
    }
    function unknownStrategyMessage(type, registry) {
        return `Unknown strategy '${type}'. Available strategies: ${Object.keys(registry.factories).join(", ")}.`;
    }
    function requireNoOptions(type, options) {
        const keys = Object.keys(options);
        if (keys.length > 0) {
            throw new Error(`Strategy '${type}' does not accept options. Unexpected: ${keys.join(", ")}.`);
        }
    }
    function cloneDefaultConfig() {
        return {
            placement: { ...exports.defaultGarageStrategyConfig.placement },
            retrieval: { ...exports.defaultGarageStrategyConfig.retrieval },
            tripPlanner: { ...exports.defaultGarageStrategyConfig.tripPlanner },
            preparationPositions: { ...exports.defaultGarageStrategyConfig.preparationPositions },
            unblocking: { ...exports.defaultGarageStrategyConfig.unblocking },
        };
    }
});
define("config/validate-config", ["require", "exports", "garage/strategy-registry"], function (require, exports, strategy_registry_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateSimulationConfig = validateSimulationConfig;
    function validateSimulationConfig(config) {
        const errors = [];
        if (!config.simulation)
            errors.push("simulation is required.");
        if (!config.demand)
            errors.push("demand is required.");
        if (!config.garage)
            errors.push("garage is required.");
        if (config.simulation) {
            if (config.simulation.durationSeconds <= 0)
                errors.push("simulation.durationSeconds must be positive.");
            if (config.simulation.tickSeconds <= 0)
                errors.push("simulation.tickSeconds must be positive.");
            if (!config.simulation.outputDir)
                errors.push("simulation.outputDir is required.");
            if (!config.simulation.rawOutputFile)
                errors.push("simulation.rawOutputFile is required.");
            if (config.simulation.diagnostics?.planningSampleIntervalSeconds !== undefined &&
                config.simulation.diagnostics.planningSampleIntervalSeconds <= 0) {
                errors.push("simulation.diagnostics.planningSampleIntervalSeconds must be positive.");
            }
        }
        if (config.garage) {
            const { layout, elevator, preparationPositions } = config.garage;
            if (layout.rows <= 0 || layout.columns <= 0 || layout.floors <= 0) {
                errors.push("garage.layout rows, columns, and floors must be positive.");
            }
            if (elevator.deckCount <= 0)
                errors.push("garage.elevator.deckCount must be positive.");
            if (preparationPositions.inboundCount < 0 || preparationPositions.outboundCount < 0) {
                errors.push("preparation position counts cannot be negative.");
            }
            errors.push(...(0, strategy_registry_js_1.validateGarageStrategyConfig)(config.garage.strategies));
        }
        return { valid: errors.length === 0, errors };
    }
});
define("report/metrics-aggregator", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DailyMetricsAggregator = void 0;
    class DailyMetricsAggregator {
        constructor(config) {
            this.config = config;
            this.byDay = new Map();
            this.inboundEventTimeByVehicle = new Map();
            this.outboundRequestTimeByVehicle = new Map();
            this.parkedAtByVehicle = new Map();
            this.lastCounterSnapshot = null;
        }
        consumeRecord(record) {
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
        consumeSecond(record) {
            const day = this.getDay(record.time);
            this.captureGeneratedEvents(record.generatedEvents);
            this.captureIntakeResults(record.intakeResults, day);
            this.captureCompletedOperations(record.time, record.tickResult.completedOperations, day);
            this.captureSnapshot(record.afterSnapshot.occupancy.occupiedCount, record.afterSnapshot.queues.inboundLength, record.afterSnapshot.queues.outboundLength, record.afterSnapshot.occupancy.occupancyPercent, record.afterSnapshot.counters, day);
        }
        finalize() {
            return [...this.byDay.values()]
                .sort((a, b) => a.dayIndex - b.dayIndex)
                .map((day) => ({
                dayIndex: day.dayIndex,
                dateOfMonth: day.dateOfMonth,
                date: day.date,
                dayOfWeek: day.dayOfWeek,
                successfulActivities: day.successfulActivities,
                vehiclesStayingUntilMidnight: day.vehiclesStayingUntilMidnight,
                averageInboundDriverWaitingSeconds: average(day.inboundDriverWaitingSeconds),
                averageInboundWaitSeconds: average(day.inboundWaitSeconds),
                averageOutboundWaitSeconds: average(day.outboundWaitSeconds),
                averageInboundDriverWaitingSecondsDuringMorningPeak: average(day.morningPeakInboundDriverWaitingSeconds),
                averageInboundWaitSecondsDuringMorningPeak: average(day.morningPeakInboundWaitSeconds),
                averageOutboundWaitSecondsDuringEveningPeak: average(day.eveningPeakOutboundWaitSeconds),
                longestInboundDriverWaitingSeconds: max(day.inboundDriverWaitingSeconds),
                longestInboundWaitSeconds: max(day.inboundWaitSeconds),
                longestOutboundWaitSeconds: max(day.outboundWaitSeconds),
                biggestInboundQueueLength: day.biggestInboundQueueLength,
                biggestOutboundQueueLength: day.biggestOutboundQueueLength,
                inboundBalkingVehicles: day.inboundBalkingVehicles,
                balkingOverSuccessfulInboundPercent: day.successfulActivities === 0 ? 0 : (day.inboundBalkingVehicles / Math.max(1, this.countSuccessfulInbound(day))) * 100,
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
        captureGeneratedEvents(events) {
            for (const event of events) {
                if (event.type === "InboundArrival") {
                    this.inboundEventTimeByVehicle.set(event.vehicleId, event.time);
                }
                else {
                    this.outboundRequestTimeByVehicle.set(event.vehicleId, event.time);
                }
            }
        }
        captureIntakeResults(results, day) {
            for (const result of results) {
                if (result.outcome === "Balked") {
                    day.inboundBalkingVehicles += 1;
                }
            }
        }
        captureCompletedOperations(time, operations, day) {
            for (const operation of operations) {
                if (!operation.vehicleId)
                    continue;
                if (operation.type === "EnterInboundPreparationPosition") {
                    const arrivalTime = this.inboundEventTimeByVehicle.get(operation.vehicleId);
                    if (arrivalTime !== undefined) {
                        const waitSeconds = time - arrivalTime;
                        day.inboundDriverWaitingSeconds.push(waitSeconds);
                        if (this.isHourWindow(arrivalTime, 8, 10)) {
                            day.morningPeakInboundDriverWaitingSeconds.push(waitSeconds);
                        }
                    }
                }
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
        captureStateRecord(record, day) {
            this.captureSnapshot(record.occupancy.occupiedCount, record.queues.inboundLength, record.queues.outboundLength, record.occupancy.occupancyPercent, record.counters, day);
        }
        captureCheckpoint(record, day) {
            this.captureSnapshot(record.snapshot.occupancy.occupiedCount, record.snapshot.queues.inboundLength, record.snapshot.queues.outboundLength, record.snapshot.occupancy.occupancyPercent, record.snapshot.counters, day);
        }
        captureSnapshot(occupiedCount, inboundQueueLength, outboundQueueLength, occupancyPercent, counters, day) {
            day.vehiclesStayingUntilMidnight = occupiedCount;
            day.biggestInboundQueueLength = Math.max(day.biggestInboundQueueLength, inboundQueueLength);
            day.biggestOutboundQueueLength = Math.max(day.biggestOutboundQueueLength, outboundQueueLength);
            day.maximumOccupancyPercent = Math.max(day.maximumOccupancyPercent, occupancyPercent * 100);
            if (this.lastCounterSnapshot) {
                day.totalElevatorFloorsPassed += positiveDelta(counters.elevatorFloorsPassed, this.lastCounterSnapshot.elevatorFloorsPassed);
                day.totalVmrDistanceMeters += positiveDelta(counters.vmrDistanceMeters, this.lastCounterSnapshot.vmrDistanceMeters);
                day.elevatorTripsCarryingInducedInboundVehicles += positiveDelta(counters.inducedInboundTrips, this.lastCounterSnapshot.inducedInboundTrips);
                day.totalInducedInboundVehicles += positiveDelta(counters.inducedInboundVehicles, this.lastCounterSnapshot.inducedInboundVehicles);
                day.idleUnblockingActions += positiveDelta(counters.idleUnblockingActions, this.lastCounterSnapshot.idleUnblockingActions);
                day.idleUnblockedVehicles += positiveDelta(counters.idleUnblockedVehicles, this.lastCounterSnapshot.idleUnblockedVehicles);
                day.downwardTripPlacements += positiveDelta(counters.downwardTripPlacements, this.lastCounterSnapshot.downwardTripPlacements);
            }
            else {
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
        getDay(time) {
            const dayIndex = Math.floor(time / 86400) + 1;
            const existing = this.byDay.get(dayIndex);
            if (existing)
                return existing;
            const date = this.dateForTime(time);
            const day = {
                dayIndex,
                date,
                dateOfMonth: Number(this.formatDatePart(time, "day")),
                dayOfWeek: this.formatDatePart(time, "weekday"),
                successfulActivities: 0,
                vehiclesStayingUntilMidnight: 0,
                inboundDriverWaitingSeconds: [],
                inboundWaitSeconds: [],
                outboundWaitSeconds: [],
                morningPeakInboundDriverWaitingSeconds: [],
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
        countSuccessfulInbound(day) {
            return day.inboundWaitSeconds.length;
        }
        collectableParkingHours(parkingSeconds, policy) {
            const blocks = Math.ceil(parkingSeconds / (policy.billingBlockMinutes * 60));
            return (blocks * policy.billingBlockMinutes) / 60;
        }
        isHourWindow(time, startHour, endHour) {
            const hour = Number(this.formatDatePart(time, "hour"));
            return hour >= startHour && hour < endHour;
        }
        dateForTime(time) {
            const date = this.absoluteDate(time);
            const year = this.formatDatePart(time, "year");
            const month = this.formatDatePart(time, "month").padStart(2, "0");
            const day = this.formatDatePart(time, "day").padStart(2, "0");
            if (Number.isNaN(date.getTime())) {
                throw new Error(`Invalid simulation start time: ${this.config.simulation.startTime}`);
            }
            return `${year}-${month}-${day}`;
        }
        formatDatePart(time, part) {
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
        absoluteDate(time) {
            return new Date(new Date(this.config.simulation.startTime).getTime() + time * 1000);
        }
    }
    exports.DailyMetricsAggregator = DailyMetricsAggregator;
    function average(values) {
        if (values.length === 0)
            return 0;
        return round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
    }
    function max(values) {
        if (values.length === 0)
            return 0;
        return Math.max(...values);
    }
    function positiveDelta(current, previous) {
        return Math.max(0, current - previous);
    }
    function round(value, digits) {
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }
});
define("report/summary", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.summarizeDailyMetrics = summarizeDailyMetrics;
    const numericFields = [
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
    function summarizeDailyMetrics(daily) {
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
    function zeroSummary() {
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
    function round(value, digits) {
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }
});
define("report/report-builder", ["require", "exports", "report/metrics-aggregator", "report/summary"], function (require, exports, metrics_aggregator_js_1, summary_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.buildReportFromRecords = buildReportFromRecords;
    function buildReportFromRecords(metadata, records, source) {
        const aggregator = new metrics_aggregator_js_1.DailyMetricsAggregator(metadata.config);
        for (const record of records) {
            aggregator.consumeRecord(record);
        }
        const daily = aggregator.finalize();
        return {
            sessionId: metadata.sessionId,
            generatedAt: new Date().toISOString(),
            source,
            simulationStartTime: metadata.config.simulation.startTime,
            timezone: metadata.config.simulation.timezone,
            daily,
            thirtyDaySummary: (0, summary_js_1.summarizeDailyMetrics)(daily),
        };
    }
});
define("simulation/compact-records", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultCheckpointIntervalSeconds = void 0;
    exports.buildCompactRecords = buildCompactRecords;
    exports.defaultCheckpointIntervalSeconds = 300;
    function buildCompactRecords(record, previousStateKey, checkpointIntervalSeconds = exports.defaultCheckpointIntervalSeconds) {
        const records = [];
        if (record.generatedEvents.length > 0 || record.intakeResults.length > 0) {
            const events = {
                kind: "events",
                t: record.time,
                generated: record.generatedEvents,
                intake: record.intakeResults,
            };
            records.push(events);
        }
        if (record.tickResult.startedOperations.length > 0 ||
            record.tickResult.completedOperations.length > 0 ||
            record.telemetry.length > 0) {
            const operations = {
                kind: "operations",
                t: record.time,
                ...(record.tickResult.startedOperations.length > 0 ? { started: record.tickResult.startedOperations } : {}),
                ...(record.tickResult.completedOperations.length > 0 ? { completed: record.tickResult.completedOperations } : {}),
                ...(record.telemetry.length > 0 ? { telemetry: record.telemetry } : {}),
            };
            records.push(operations);
        }
        const state = toStateRecord(record);
        const stateKey = buildStateKey(state);
        const isCheckpoint = record.time % checkpointIntervalSeconds === 0;
        if (stateKey !== previousStateKey || isCheckpoint) {
            records.push(state);
        }
        if (isCheckpoint) {
            const checkpoint = {
                kind: "checkpoint",
                t: record.time,
                snapshot: record.afterSnapshot,
            };
            records.push(checkpoint);
        }
        return { records, stateKey };
    }
    function toStateRecord(record) {
        return {
            kind: "state",
            t: record.time,
            occupancy: {
                occupiedCount: record.afterSnapshot.occupancy.occupiedCount,
                reservedCount: record.afterSnapshot.occupancy.reservedCount ?? 0,
                effectiveOccupiedCount: record.afterSnapshot.occupancy.effectiveOccupiedCount ??
                    record.afterSnapshot.occupancy.occupiedCount,
                totalParkingCells: record.afterSnapshot.occupancy.totalParkingCells,
                occupancyPercent: record.afterSnapshot.occupancy.occupancyPercent,
                effectiveOccupancyPercent: record.afterSnapshot.occupancy.effectiveOccupancyPercent ??
                    record.afterSnapshot.occupancy.occupancyPercent,
            },
            queues: {
                inboundLength: record.afterSnapshot.queues.inboundLength,
                outboundLength: record.afterSnapshot.queues.outboundLength,
            },
            counters: compactCounters(record.afterSnapshot.counters),
        };
    }
    function buildStateKey(state) {
        return JSON.stringify({
            o: state.occupancy,
            q: state.queues,
            c: state.counters,
        });
    }
    function compactCounters(counters) {
        return { ...counters };
    }
});
define("simulation/in-memory-recorder", ["require", "exports", "simulation/compact-records"], function (require, exports, compact_records_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InMemorySimulationStateRecorder = void 0;
    class InMemorySimulationStateRecorder {
        constructor() {
            this.metadata = null;
            this.records = [];
            this.lastStateKey = "";
        }
        async open(session) {
            this.metadata = {
                kind: "metadata",
                sessionId: session.id,
                config: session.config,
                recording: {
                    schema: "compact-jsonl-v1",
                    checkpointIntervalSeconds: compact_records_js_1.defaultCheckpointIntervalSeconds,
                },
            };
            this.records.length = 0;
            this.lastStateKey = "";
        }
        async recordSecond(record) {
            const result = (0, compact_records_js_1.buildCompactRecords)(record, this.lastStateKey, compact_records_js_1.defaultCheckpointIntervalSeconds);
            this.records.push(...result.records);
            this.lastStateKey = result.stateKey;
        }
        async close() {
            return;
        }
        getOutputRef() {
            return { path: "memory://simulation-output.jsonl" };
        }
        getMetadata() {
            if (!this.metadata) {
                throw new Error("Recorder has not been opened.");
            }
            return this.metadata;
        }
        getRecords() {
            return [...this.records];
        }
        toJsonl() {
            return [JSON.stringify(this.getMetadata()), ...this.records.map((record) => JSON.stringify(record))].join("\n") + "\n";
        }
    }
    exports.InMemorySimulationStateRecorder = InMemorySimulationStateRecorder;
});
define("garage/grid-layout", ["require", "exports", "garage/occupancy"], function (require, exports, occupancy_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.GridGarageLayout = void 0;
    class GridGarageLayout {
        constructor(config) {
            this.config = config;
            this.geometryByCell = new Map();
            const unavailable = new Set([config.elevatorCell, ...config.unavailableCells]);
            const cellsPerFloor = config.rows * config.columns;
            const parkingCells = [];
            for (let floor = 1; floor <= config.floors; floor += 1) {
                for (let cell = 1; cell <= cellsPerFloor; cell += 1) {
                    const cellId = `f${floor}c${cell}`;
                    const row = Math.floor((cell - 1) / config.columns) + 1;
                    const column = ((cell - 1) % config.columns) + 1;
                    this.geometryByCell.set(cellId, { floor, row, column });
                    if (!unavailable.has(cell)) {
                        parkingCells.push(cellId);
                    }
                }
            }
            this.parkingCells = parkingCells;
        }
        getParkingCells() {
            return [...this.parkingCells];
        }
        getCellFloor(cellId) {
            return this.getCellGeometry(cellId).floor;
        }
        getCellGeometry(cellId) {
            const geometry = this.geometryByCell.get(cellId);
            if (!geometry) {
                throw new Error(`Unknown cell id: ${cellId}`);
            }
            return geometry;
        }
        getBlockingCells(cellId, occupancy) {
            const target = this.getCellGeometry(cellId);
            const centerRow = Math.ceil(this.config.rows / 2);
            const centerColumn = Math.ceil(this.config.columns / 2);
            const occupied = (0, occupancy_js_2.effectiveOccupiedCellIds)(occupancy);
            const horizontalFirst = this.buildPath(target.floor, centerRow, centerColumn, target.row, target.column, true);
            const verticalFirst = this.buildPath(target.floor, centerRow, centerColumn, target.row, target.column, false);
            const candidates = [horizontalFirst, verticalFirst]
                .map((path) => path.filter((pathCell) => pathCell !== cellId && occupied.has(pathCell)))
                .sort((a, b) => a.length - b.length || a.join(",").localeCompare(b.join(",")));
            return candidates[0] ?? [];
        }
        wouldCreateBlockedEmptyCell(cellId, occupancy) {
            const candidateOccupancy = {
                ...occupancy,
                occupied: [
                    ...occupancy.occupied,
                    { cellId, vehicleId: "__candidate__", parkedAt: 0 },
                ],
                occupiedCount: occupancy.occupiedCount + 1,
            };
            const occupied = (0, occupancy_js_2.effectiveOccupiedCellIds)(candidateOccupancy);
            return this.parkingCells.some((parkingCell) => !occupied.has(parkingCell) &&
                this.getBlockingCells(parkingCell, candidateOccupancy).length > 0);
        }
        classifyBlockage(cellId, occupancy) {
            const blockerCount = this.getBlockingCells(cellId, occupancy).length;
            if (blockerCount === 0)
                return "none";
            return blockerCount === 1 ? "shallow" : "deep";
        }
        estimateAccessCost(cellId, occupancy) {
            const geometry = this.getCellGeometry(cellId);
            const blockage = this.classifyBlockage(cellId, occupancy);
            const blockagePenalty = blockage === "deep" ? 120 : blockage === "shallow" ? 60 : 0;
            const manhattanFromElevator = Math.abs(geometry.row - Math.ceil(this.config.rows / 2)) +
                Math.abs(geometry.column - Math.ceil(this.config.columns / 2));
            return geometry.floor * 10 + manhattanFromElevator * 5 + blockagePenalty;
        }
        buildPath(floor, startRow, startColumn, targetRow, targetColumn, horizontalFirst) {
            const coordinates = [];
            let row = startRow;
            let column = startColumn;
            const moveHorizontal = () => {
                while (column !== targetColumn) {
                    column += Math.sign(targetColumn - column);
                    coordinates.push([row, column]);
                }
            };
            const moveVertical = () => {
                while (row !== targetRow) {
                    row += Math.sign(targetRow - row);
                    coordinates.push([row, column]);
                }
            };
            if (horizontalFirst) {
                moveHorizontal();
                moveVertical();
            }
            else {
                moveVertical();
                moveHorizontal();
            }
            return coordinates
                .map(([pathRow, pathColumn]) => this.cellIdAt(floor, pathRow, pathColumn))
                .filter((pathCell) => pathCell !== null);
        }
        cellIdAt(floor, row, column) {
            if (row < 1 || row > this.config.rows || column < 1 || column > this.config.columns) {
                return null;
            }
            const cellNumber = (row - 1) * this.config.columns + column;
            if (cellNumber === this.config.elevatorCell || this.config.unavailableCells.includes(cellNumber)) {
                return null;
            }
            return `f${floor}c${cellNumber}`;
        }
    }
    exports.GridGarageLayout = GridGarageLayout;
});
define("garage/vmr-path-planner", ["require", "exports", "garage/occupancy"], function (require, exports, occupancy_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.GridVmrPathPlanner = void 0;
    class GridVmrPathPlanner {
        constructor(config, layout) {
            this.config = config;
            this.layout = layout;
            const cell = config.layout.elevatorCell;
            this.elevatorCoordinate = {
                row: Math.floor((cell - 1) / config.layout.columns) + 1,
                column: ((cell - 1) % config.layout.columns) + 1,
            };
        }
        findAccessPlan(cellId, occupancy) {
            const path = this.findPath(cellId, occupancy, true);
            if (!path)
                return null;
            const occupied = (0, occupancy_js_3.effectiveOccupiedCellIds)(occupancy);
            return {
                path,
                blockerCells: path.cells.filter((pathCell) => pathCell !== cellId && occupied.has(pathCell)),
            };
        }
        findClearPathFromElevator(cellId, occupancy) {
            const path = this.findPath(cellId, occupancy, false);
            if (!path)
                return null;
            return this.isClear(path, occupancy, cellId, false)
                ? this.roundTrip(path)
                : null;
        }
        findClearPathToElevator(cellId, occupancy) {
            const outward = this.findPath(cellId, occupancy, false);
            if (!outward || !this.isClear(outward, occupancy, cellId, true))
                return null;
            return this.roundTrip(outward);
        }
        isClear(path, occupancy, endpointCell, endpointMayBeOccupied) {
            const occupied = (0, occupancy_js_3.effectiveOccupiedCellIds)(occupancy);
            return path.cells.every((cellId) => !occupied.has(cellId) ||
                (cellId === endpointCell && endpointMayBeOccupied));
        }
        pathsConflict(a, b) {
            if (a.floor !== b.floor)
                return false;
            const locations = new Set(a.locations);
            return b.locations.some((location) => locations.has(location));
        }
        findPath(cellId, occupancy, minimizeBlockers) {
            const target = this.layout.getCellGeometry(cellId);
            const floor = target.floor;
            const startKey = this.coordinateKey(this.elevatorCoordinate);
            const targetKey = this.coordinateKey(target);
            const occupied = (0, occupancy_js_3.effectiveOccupiedCellIds)(occupancy);
            const frontier = [
                { key: startKey, blockers: 0, steps: 0 },
            ];
            const best = new Map([
                [startKey, { blockers: 0, steps: 0 }],
            ]);
            const previous = new Map();
            while (frontier.length > 0) {
                frontier.sort((a, b) => a.blockers - b.blockers ||
                    a.steps - b.steps ||
                    a.key.localeCompare(b.key));
                const current = frontier.shift();
                if (!current)
                    break;
                if (current.key === targetKey) {
                    return this.buildPath(floor, current.key, previous);
                }
                for (const neighbor of this.neighbors(current.key)) {
                    const neighborCell = this.cellAt(floor, neighbor);
                    if (neighbor !== targetKey && neighborCell === null)
                        continue;
                    if (!minimizeBlockers &&
                        neighbor !== targetKey &&
                        neighborCell &&
                        occupied.has(neighborCell)) {
                        continue;
                    }
                    const blockerCost = minimizeBlockers && neighborCell && occupied.has(neighborCell) ? 1 : 0;
                    const next = {
                        blockers: current.blockers + blockerCost,
                        steps: current.steps + 1,
                    };
                    const known = best.get(neighbor);
                    if (known &&
                        (known.blockers < next.blockers ||
                            (known.blockers === next.blockers && known.steps <= next.steps))) {
                        continue;
                    }
                    best.set(neighbor, next);
                    previous.set(neighbor, current.key);
                    frontier.push({ key: neighbor, ...next });
                }
            }
            return null;
        }
        buildPath(floor, targetKey, previous) {
            const keys = [targetKey];
            let cursor = targetKey;
            while (previous.has(cursor)) {
                cursor = previous.get(cursor);
                keys.push(cursor);
            }
            keys.reverse();
            const locations = keys.map((key) => key === this.coordinateKey(this.elevatorCoordinate)
                ? this.elevatorLocation(floor)
                : this.cellAt(floor, key));
            const cells = locations.filter((location) => location.startsWith("f"));
            return {
                floor,
                locations,
                cells,
                distanceMeters: Math.max(0, locations.length - 1) * 3,
            };
        }
        roundTrip(path) {
            const returnLocations = [...path.locations].reverse().slice(1);
            const locations = [...path.locations, ...returnLocations];
            return {
                ...path,
                locations,
                cells: locations.filter((location) => location.startsWith("f")),
                distanceMeters: path.distanceMeters * 2,
            };
        }
        neighbors(key) {
            const coordinate = this.parseCoordinate(key);
            return [
                { row: coordinate.row - 1, column: coordinate.column },
                { row: coordinate.row + 1, column: coordinate.column },
                { row: coordinate.row, column: coordinate.column - 1 },
                { row: coordinate.row, column: coordinate.column + 1 },
            ]
                .filter((candidate) => candidate.row >= 1 &&
                candidate.row <= this.config.layout.rows &&
                candidate.column >= 1 &&
                candidate.column <= this.config.layout.columns)
                .map((candidate) => this.coordinateKey(candidate));
        }
        cellAt(floor, key) {
            const coordinate = this.parseCoordinate(key);
            const cellNumber = (coordinate.row - 1) * this.config.layout.columns + coordinate.column;
            if (cellNumber === this.config.layout.elevatorCell)
                return null;
            if (this.config.layout.unavailableCells.includes(cellNumber))
                return null;
            return `f${floor}c${cellNumber}`;
        }
        elevatorLocation(floor) {
            return `f${floor}:elevator`;
        }
        coordinateKey(coordinate) {
            return `${coordinate.row},${coordinate.column}`;
        }
        parseCoordinate(key) {
            const [row, column] = key.split(",").map(Number);
            return { row: row ?? 0, column: column ?? 0 };
        }
    }
    exports.GridVmrPathPlanner = GridVmrPathPlanner;
});
define("garage/simple-garage", ["require", "exports", "garage/grid-layout", "garage/vmr-path-planner"], function (require, exports, grid_layout_js_1, vmr_path_planner_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SimpleGarageTowerSystem = void 0;
    const failedIdleUnblockingCacheMaxEntries = 512;
    const failedIdleUnblockingCacheTtlSeconds = 600;
    class SimpleGarageTowerSystem {
        constructor(strategies) {
            this.strategies = strategies;
            this.inboundQueue = [];
            this.outboundQueue = [];
            this.parked = new Map();
            this.cellReservations = new Map();
            this.requestedOutbound = new Set();
            this.preparationPositions = [];
            this.decks = [];
            this.vmrs = [];
            this.trip = null;
            this.elevatorFloor = 1;
            this.elevatorDirection = "stopped";
            this.lastExternalActivityAt = 0;
            this.planningDiagnostics = null;
            this.failedIdleUnblockingCache = new Map();
            this.counters = this.newCounters();
        }
        initialize(config) {
            this.config = config;
            this.layout = new grid_layout_js_1.GridGarageLayout(config.layout);
            this.pathPlanner = new vmr_path_planner_js_1.GridVmrPathPlanner(config, this.layout);
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
                    direction: "inbound",
                    doorState: "open",
                })),
                ...Array.from({ length: config.preparationPositions.outboundCount }, (_, index) => ({
                    id: `OPP${index + 1}`,
                    direction: "outbound",
                    doorState: "closed",
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
        submitEvents(context) {
            if (context.events.length > 0) {
                this.lastExternalActivityAt = context.time;
            }
            const results = context.events.map((event) => event.type === "InboundArrival"
                ? this.submitInbound(event.id, event.vehicleId, context)
                : this.submitOutbound(event.id, event.vehicleId, context.time));
            this.updateMaxQueues();
            return results;
        }
        updateOneSecond(context) {
            this.updatePreparationPositions(context.time);
            const completedOperations = this.fillInboundPreparationPositions(context.time);
            const startedOperations = [];
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
        getSnapshot() {
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
        isIdle() {
            return (!this.trip &&
                this.inboundQueue.length === 0 &&
                this.outboundQueue.length === 0 &&
                !this.preparationPositions.some((position) => position.occupiedBy));
        }
        getCapacity() {
            const totalParkingCells = this.layout.getParkingCells().length;
            return {
                totalParkingCells,
                occupiedParkingCells: this.parked.size,
                availableParkingCells: totalParkingCells - this.parked.size,
            };
        }
        submitInbound(eventId, vehicleId, context) {
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
        submitOutbound(eventId, vehicleId, time) {
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
        planTrip(context) {
            const snapshot = this.getSnapshot();
            snapshot.time = context.time;
            const idleSeconds = context.time - this.lastExternalActivityAt;
            const garageIsFull = snapshot.occupancy.occupiedCount >= snapshot.occupancy.totalParkingCells;
            const idleUnblockingAllowed = !garageIsFull &&
                this.strategies.unblockingStrategy.shouldStartIdleUnblocking({
                    time: context.time,
                    snapshot,
                    idleSeconds,
                });
            const diagnosticsEnabled = context.simulation.diagnostics?.enabled === true;
            const planningStartedAtMs = diagnosticsEnabled ? nowMs() : 0;
            const idleUnblockingCandidate = idleUnblockingAllowed && this.isIdleUnblockingPlanningCandidate(snapshot);
            const idleUnblockingCacheKey = idleUnblockingCandidate
                ? this.failedIdleUnblockingCacheKey(snapshot)
                : null;
            if (idleUnblockingCacheKey &&
                this.hasFailedIdleUnblockingCacheHit(idleUnblockingCacheKey, context.time)) {
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
                }
                else {
                    this.rememberFailedIdleUnblockingPlan(idleUnblockingCacheKey, context.time);
                }
            }
            if (!plan)
                return null;
            const selectedOutboundIds = new Set(plan.selectedOutboundVehicleIds);
            this.outboundQueue = this.outboundQueue.filter((queued) => !selectedOutboundIds.has(queued.vehicleId));
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
        recordPlanningDiagnostics(params) {
            const { context, snapshot, idleUnblockingAllowed, elapsedMs, planned, failedIdleUnblockCacheHit, } = params;
            const interval = Math.max(1, context.simulation.diagnostics?.planningSampleIntervalSeconds ?? 60);
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
            window.maxInboundQueueLength = Math.max(window.maxInboundQueueLength, snapshot.queues.inboundLength);
            window.maxOutboundQueueLength = Math.max(window.maxOutboundQueueLength, snapshot.queues.outboundLength);
            if (planned) {
                window.planCount += 1;
            }
            else {
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
            if (context.time - window.startedAt < interval)
                return;
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
        newPlanningDiagnosticWindow(startedAt) {
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
        isIdleUnblockingPlanningCandidate(snapshot) {
            return (snapshot.queues.inboundLength === 0 &&
                snapshot.queues.outboundLength === 0 &&
                !snapshot.preparationPositions.some((position) => position.occupiedBy));
        }
        failedIdleUnblockingCacheKey(snapshot) {
            const occupiedCellIds = snapshot.occupancy.occupied
                .map((cell) => cell.cellId)
                .sort()
                .join(",");
            return `${snapshot.elevator.currentFloor}|${occupiedCellIds}`;
        }
        hasFailedIdleUnblockingCacheHit(key, time) {
            const cached = this.failedIdleUnblockingCache.get(key);
            if (!cached)
                return false;
            if (cached.expiresAt <= time) {
                this.failedIdleUnblockingCache.delete(key);
                return false;
            }
            this.failedIdleUnblockingCache.delete(key);
            this.failedIdleUnblockingCache.set(key, cached);
            return true;
        }
        rememberFailedIdleUnblockingPlan(key, time) {
            this.failedIdleUnblockingCache.set(key, {
                expiresAt: time + failedIdleUnblockingCacheTtlSeconds,
            });
            this.trimFailedIdleUnblockingCache();
        }
        trimFailedIdleUnblockingCache() {
            while (this.failedIdleUnblockingCache.size > failedIdleUnblockingCacheMaxEntries) {
                const oldestKey = this.failedIdleUnblockingCache.keys().next().value;
                if (!oldestKey)
                    return;
                this.failedIdleUnblockingCache.delete(oldestKey);
            }
        }
        startNextGroup(context) {
            if (!this.trip)
                return [];
            const group = this.trip.groups[this.trip.groupIndex];
            if (!group)
                return [];
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
                const operation = {
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
        completeActiveGroup(time) {
            if (!this.trip?.activeGroup)
                return [];
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
        finishTrip(time) {
            if (!this.trip)
                return;
            const wasNormalTrip = this.trip.state.inboundVehicleIds.length > 0 ||
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
        applyActionStart(action, time, operation) {
            this.reserveDestinationCell(action, time, operation);
            if (action.type === "OperateDoor" && action.preparationPositionId && action.doorFinalState) {
                const position = this.findPp(action.preparationPositionId);
                if (!position)
                    return;
                position.doorState =
                    action.doorFinalState === "open" ? "opening" : "closing";
                position.doorTransitionCompleteAt = time + action.durationSeconds;
            }
        }
        applyActionComplete(action, time) {
            const deck = action.deckIndex === undefined ? undefined : this.decks[action.deckIndex];
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
                    if (!position || !action.doorFinalState)
                        break;
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
                            cellId: action.to,
                            parkedAt: time,
                        });
                        this.releaseReservation(action.to);
                    }
                    if (action.deckIndex !== undefined)
                        this.clearDeck(action.deckIndex);
                    break;
                case "ParkInbound":
                    if (action.vehicleId && action.to) {
                        this.parked.set(action.vehicleId, {
                            vehicleId: action.vehicleId,
                            cellId: action.to,
                            parkedAt: time,
                        });
                        this.releaseReservation(action.to);
                        this.counters.inboundCompleted += 1;
                        this.counters.downwardTripPlacements += 1;
                    }
                    if (action.deckIndex !== undefined)
                        this.clearDeck(action.deckIndex);
                    break;
                case "RetrieveOutbound": {
                    const position = action.preparationPositionId
                        ? this.findPp(action.preparationPositionId)
                        : undefined;
                    if (position && action.vehicleId) {
                        position.occupiedBy = action.vehicleId;
                        position.doorState = "closed";
                    }
                    if (action.deckIndex !== undefined)
                        this.clearDeck(action.deckIndex);
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
                            cellId: action.to,
                            parkedAt: time,
                        });
                        this.releaseReservation(action.to);
                        this.counters.idleUnblockingActions += 1;
                        this.counters.idleUnblockedVehicles += 1;
                    }
                    if (action.deckIndex !== undefined)
                        this.clearDeck(action.deckIndex);
                    break;
                case "UnloadOutbound":
                case "EnterInboundPreparationPosition":
                    break;
            }
        }
        elevatorPosition(location) {
            const value = Number(location?.slice("elevator-position-".length));
            return Number.isFinite(value) ? value : this.elevatorFloor;
        }
        updatePreparationPositions(time) {
            for (const position of this.preparationPositions) {
                if (position.direction === "outbound" &&
                    position.doorState === "open" &&
                    position.occupiedBy &&
                    (position.readyAt ?? Number.POSITIVE_INFINITY) <= time) {
                    delete position.occupiedBy;
                    delete position.readyAt;
                    position.doorState = "closing";
                    position.doorTransitionCompleteAt =
                        time + this.config.preparationPositions.doorSeconds;
                }
                if (position.doorTransitionCompleteAt !== undefined &&
                    position.doorTransitionCompleteAt <= time) {
                    position.doorState =
                        position.doorState === "closing" ? "closed" : "open";
                    delete position.doorTransitionCompleteAt;
                }
            }
        }
        fillInboundPreparationPositions(time) {
            const completed = [];
            const inboundPositions = this.preparationPositions.filter((position) => position.direction === "inbound");
            for (const position of inboundPositions) {
                if (this.inboundQueue.length === 0)
                    return completed;
                if (position.doorState !== "open" || position.occupiedBy)
                    continue;
                if (this.config.preparationPositions.kind === "sequential" &&
                    inboundPositions.some((candidate) => Number(candidate.id.slice(3)) < Number(position.id.slice(3)) &&
                        !candidate.occupiedBy)) {
                    continue;
                }
                const next = this.inboundQueue.shift();
                if (!next)
                    return completed;
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
        startVmrTask(index, operation) {
            const vmr = this.vmrs[index];
            if (!vmr)
                return;
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
        finishVmrTask(index) {
            const vmr = this.vmrs[index];
            if (!vmr)
                return;
            const task = vmr.currentTask;
            if (task) {
                const distance = task.path?.distanceMeters ?? this.taskDistance(task.from, task.to);
                vmr.distanceMovedMeters += distance;
                this.counters.vmrDistanceMeters += distance;
            }
            vmr.status = "Idle";
            delete vmr.currentTask;
        }
        allVmrsHomeAndIdle() {
            return this.vmrs.every((vmr) => vmr.status === "Idle" && vmr.deckId === vmr.homeDeckId);
        }
        validateActionGroupPaths(group) {
            const pathActions = group.actions.filter((action) => Boolean(action.path));
            for (let index = 0; index < pathActions.length; index += 1) {
                for (let otherIndex = index + 1; otherIndex < pathActions.length; otherIndex += 1) {
                    const first = pathActions[index];
                    const second = pathActions[otherIndex];
                    if (first &&
                        second &&
                        this.pathPlanner.pathsConflict(first.path, second.path)) {
                        throw new Error(`Concurrent VMR paths conflict in group '${group.name}': ` +
                            `${first.vehicleId ?? first.type} and ${second.vehicleId ?? second.type}.`);
                    }
                }
            }
            const occupancy = this.getOccupancy();
            for (const action of pathActions) {
                const extraction = action.type === "MoveBlocker" || action.type === "LoadOutbound";
                const endpoint = extraction ? action.from : action.to;
                if (!endpoint?.startsWith("f"))
                    continue;
                if (!this.pathPlanner.isClear(action.path, occupancy, endpoint, extraction)) {
                    throw new Error(`VMR path is obstructed for ${action.type} ${action.vehicleId ?? ""}: ` +
                        action.path.locations.join(" -> "));
                }
            }
        }
        clearDeck(index) {
            const deck = this.decks[index];
            if (!deck)
                return;
            delete deck.vehicleId;
            delete deck.vehicleRole;
        }
        findPp(id) {
            return this.preparationPositions.find((position) => position.id === id);
        }
        reserveDestinationCell(action, time, operation) {
            if (!this.isCellReservationPurpose(action.type) || !action.vehicleId || !action.to?.startsWith("f")) {
                return;
            }
            const cellId = action.to;
            this.cellReservations.set(cellId, {
                cellId,
                vehicleId: action.vehicleId,
                operationId: operation.id,
                reservedAt: time,
                expectedOccupiedAt: operation.completesAt,
                purpose: action.type,
            });
        }
        releaseReservation(cellId) {
            this.cellReservations.delete(cellId);
        }
        isCellReservationPurpose(type) {
            return (type === "ParkInbound" ||
                type === "RelocateBlocker" ||
                type === "IdleUnblock");
        }
        taskDistance(from, to) {
            const cell = [from, to].find((value) => value?.startsWith("f"));
            if (cell) {
                const geometry = this.layout.getCellGeometry(cell);
                const centerRow = Math.ceil(this.config.layout.rows / 2);
                const centerColumn = Math.ceil(this.config.layout.columns / 2);
                return ((Math.abs(geometry.row - centerRow) +
                    Math.abs(geometry.column - centerColumn)) *
                    3 *
                    2);
            }
            const pp = [from, to].find((value) => value?.includes("PP"));
            if (pp) {
                const positionNumber = Number(/\d+$/.exec(pp)?.[0] ?? 1);
                return Math.max(3, positionNumber * 3) * 2;
            }
            return 0;
        }
        getOccupancy() {
            const occupied = [...this.parked.values()].map((record) => ({
                cellId: record.cellId,
                vehicleId: record.vehicleId,
                parkedAt: record.parkedAt,
            }));
            const reservations = [...this.cellReservations.values()].map((reservation) => ({
                ...reservation,
            }));
            const reservedCellIds = new Set(reservations
                .filter((reservation) => !occupied.some((cell) => cell.cellId === reservation.cellId))
                .map((reservation) => reservation.cellId));
            const totalParkingCells = this.layout.getParkingCells().length;
            const effectiveOccupiedCount = occupied.length + reservedCellIds.size;
            return {
                occupied,
                reservations,
                occupiedCount: occupied.length,
                reservedCount: reservedCellIds.size,
                effectiveOccupiedCount,
                totalParkingCells,
                occupancyPercent: totalParkingCells === 0 ? 0 : occupied.length / totalParkingCells,
                effectiveOccupancyPercent: totalParkingCells === 0 ? 0 : effectiveOccupiedCount / totalParkingCells,
            };
        }
        inboundVehiclesInPhysicalSystem() {
            const onPps = this.preparationPositions.filter((position) => position.direction === "inbound" && position.occupiedBy).length;
            const onDecks = this.decks.filter((deck) => deck.vehicleRole === "inbound" && deck.vehicleId).length;
            return onPps + onDecks;
        }
        updateMaxQueues() {
            this.counters.maxInboundQueueLength = Math.max(this.counters.maxInboundQueueLength, this.inboundQueue.length);
            this.counters.maxOutboundQueueLength = Math.max(this.counters.maxOutboundQueueLength, this.outboundQueue.length);
        }
        shouldBalk(queueLengthExcludingPps, context) {
            const policy = {
                startsAtQueueLength: 13,
                initialProbability: 0.5,
                probabilityStep: 0.1,
                certainAtQueueLength: 18,
            };
            const queuePosition = queueLengthExcludingPps + 1;
            if (queuePosition < policy.startsAtQueueLength)
                return false;
            if (queuePosition >= policy.certainAtQueueLength)
                return true;
            const probability = policy.initialProbability +
                (queuePosition - policy.startsAtQueueLength) * policy.probabilityStep;
            return context.rng.nextFloat() < probability;
        }
        preparationClearSeconds() {
            return this.config.preparationPositions.kind === "sequential"
                ? this.config.preparationPositions.sequentialClearSeconds
                : this.config.preparationPositions.parallelClearSeconds;
        }
        newCounters() {
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
    exports.SimpleGarageTowerSystem = SimpleGarageTowerSystem;
    function nowMs() {
        return globalThis.performance?.now() ?? Date.now();
    }
    function roundMilliseconds(value) {
        return Math.round(value * 1000) / 1000;
    }
});
define("simulation/random", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SeededRandomSource = void 0;
    class SeededRandomSource {
        constructor(seed) {
            this.state = seed >>> 0;
        }
        nextFloat() {
            this.state = (1664525 * this.state + 1013904223) >>> 0;
            return this.state / 0x100000000;
        }
        nextInt(minInclusive, maxInclusive) {
            const span = maxInclusive - minInclusive + 1;
            return minInclusive + Math.floor(this.nextFloat() * span);
        }
        choose(items) {
            if (items.length === 0) {
                throw new Error("Cannot choose from an empty collection.");
            }
            return items[this.nextInt(0, items.length - 1)];
        }
    }
    exports.SeededRandomSource = SeededRandomSource;
});
define("simulation/demand-generator", ["require", "exports", "simulation/random"], function (require, exports, random_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SeededDemandGenerator = void 0;
    class SeededDemandGenerator {
        constructor() {
            this.nextVehicleNumber = 1;
            this.futureOutbounds = [];
            this.dueOutbounds = new Map();
            this.canceledInboundEventIds = new Set();
            this.startLocalSecondOfDay = 0;
            this.weekendByDayOffset = new Map();
        }
        initialize(params, runtime, seed) {
            this.config = params;
            this.runtime = runtime;
            this.rng = new random_js_1.SeededRandomSource(seed);
            this.startLocalSecondOfDay = this.getStartLocalSecondOfDay();
            this.futureOutbounds.length = 0;
            this.dueOutbounds.clear();
            this.canceledInboundEventIds.clear();
            this.weekendByDayOffset.clear();
            this.nextVehicleNumber = 1;
        }
        generateEventsAt(time, garageState) {
            const events = [];
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
                if (!scheduled)
                    break;
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
        recordIntakeResults(results) {
            const rejectedInboundEventIds = new Set(results
                .filter((result) => !result.accepted &&
                (result.outcome === "Balked" || result.outcome === "RejectedGarageFull"))
                .map((result) => result.eventId));
            for (const result of results) {
                if (!rejectedInboundEventIds.has(result.eventId))
                    continue;
                const removedFromDueQueue = this.dueOutbounds.delete(result.vehicleId);
                if (!removedFromDueQueue) {
                    this.canceledInboundEventIds.add(result.eventId);
                }
            }
        }
        insertFutureOutbound(outbound) {
            let low = 0;
            let high = this.futureOutbounds.length;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                const middleTime = this.futureOutbounds[middle]?.time ?? Number.POSITIVE_INFINITY;
                if (middleTime <= outbound.time) {
                    low = middle + 1;
                }
                else {
                    high = middle;
                }
            }
            this.futureOutbounds.splice(low, 0, outbound);
        }
        inboundLambdaPerSecond(time) {
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
        isWeekend(dayOffset) {
            const cached = this.weekendByDayOffset.get(dayOffset);
            if (cached !== undefined)
                return cached;
            const start = new Date(this.runtime.startTime);
            const localMiddayMilliseconds = start.getTime() +
                (dayOffset * 24 * 60 * 60 - this.startLocalSecondOfDay + 12 * 60 * 60) * 1000;
            const weekday = new Intl.DateTimeFormat("en-US", {
                timeZone: this.runtime.timezone,
                weekday: "short",
            }).format(new Date(localMiddayMilliseconds));
            const weekend = weekday === "Sat" || weekday === "Sun";
            this.weekendByDayOffset.set(dayOffset, weekend);
            return weekend;
        }
        getStartLocalSecondOfDay() {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: this.runtime.timezone,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23",
            }).formatToParts(new Date(this.runtime.startTime));
            const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
            return value("hour") * 3600 + value("minute") * 60 + value("second");
        }
        samplePoisson(lambda) {
            if (lambda <= 0)
                return 0;
            const threshold = Math.exp(-lambda);
            let count = 0;
            let product = 1;
            do {
                count += 1;
                product *= this.rng.nextFloat();
            } while (product > threshold);
            return count - 1;
        }
        sampleParkingDurationSeconds() {
            const { minHours, maxHours, modeHours } = this.config.parkingDuration;
            const left = this.rng.nextFloat();
            const right = this.rng.nextFloat();
            const triangularHours = minHours + (modeHours - minHours) * left + (maxHours - modeHours) * right;
            const bounded = Math.max(minHours, Math.min(maxHours, triangularHours));
            return Math.round(bounded * 3600);
        }
    }
    exports.SeededDemandGenerator = SeededDemandGenerator;
});
define("simulation/session-factory", ["require", "exports", "garage/simple-garage", "garage/strategy-registry", "simulation/demand-generator", "simulation/random"], function (require, exports, simple_garage_js_1, strategy_registry_js_2, demand_generator_js_1, random_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createSimulationSession = createSimulationSession;
    class SimpleGarageFactory {
        createGarage(config, strategies) {
            const garage = new simple_garage_js_1.SimpleGarageTowerSystem(strategies);
            garage.initialize(config);
            return garage;
        }
    }
    function createSimulationSession(config, recorder) {
        const strategies = (0, strategy_registry_js_2.createGarageStrategies)(config.garage.strategies);
        const garage = new SimpleGarageFactory().createGarage(config.garage, strategies);
        const demandGenerator = new demand_generator_js_1.SeededDemandGenerator();
        demandGenerator.initialize(config.demand, config.simulation, config.simulation.seed);
        return {
            id: `${config.simulation.sessionName}-${config.simulation.seed}`,
            config,
            garage,
            demandGenerator,
            recorder,
            intakeRandomSource: new random_js_2.SeededRandomSource(config.simulation.seed + 1),
            garageRandomSource: new random_js_2.SeededRandomSource(config.simulation.seed + 2),
        };
    }
});
define("simulation/telemetry", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BufferedGarageTelemetrySink = void 0;
    class BufferedGarageTelemetrySink {
        constructor() {
            this.records = [];
        }
        recordOperation(operation) {
            this.records.push({ kind: "operation", value: operation });
        }
        recordMetric(metric) {
            this.records.push({ kind: "metric", value: metric });
        }
        recordWarning(warning) {
            this.records.push({ kind: "warning", value: warning });
        }
        flush() {
            const flushed = [...this.records];
            this.records.length = 0;
            return flushed;
        }
    }
    exports.BufferedGarageTelemetrySink = BufferedGarageTelemetrySink;
});
define("simulation/simulation-engine", ["require", "exports", "simulation/telemetry"], function (require, exports, telemetry_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SimulationEngine = void 0;
    class SimulationEngine {
        async run(session) {
            await session.recorder.open(session);
            let time = 0;
            const endTime = session.config.simulation.durationSeconds;
            while (time <= endTime) {
                await this.runOneSecond(session, time);
                time += session.config.simulation.tickSeconds;
            }
            await session.recorder.close();
            return {
                sessionId: session.id,
                rawOutput: session.recorder.getOutputRef(),
                startedAt: 0,
                endedAt: endTime,
                finalSnapshot: session.garage.getSnapshot(),
            };
        }
        async runOneSecond(session, time) {
            const beforeSnapshot = session.garage.getSnapshot();
            beforeSnapshot.time = time;
            const generatedEvents = session.demandGenerator.generateEventsAt(time, beforeSnapshot);
            const intakeResults = session.garage.submitEvents({
                time,
                events: generatedEvents,
                rng: session.intakeRandomSource,
            });
            session.demandGenerator.recordIntakeResults(intakeResults);
            const telemetry = new telemetry_js_1.BufferedGarageTelemetrySink();
            const context = {
                time,
                deltaSeconds: session.config.simulation.tickSeconds,
                simulation: session.config.simulation,
                rng: session.garageRandomSource,
                telemetry,
            };
            const tickResult = session.garage.updateOneSecond(context);
            const afterSnapshot = session.garage.getSnapshot();
            afterSnapshot.time = time;
            const telemetryRecords = telemetry.flush();
            this.logDiagnostics(session, telemetryRecords);
            const record = {
                sessionId: session.id,
                time,
                generatedEvents,
                intakeResults,
                tickResult,
                beforeSnapshot,
                afterSnapshot,
                telemetry: telemetryRecords,
            };
            await session.recorder.recordSecond(record);
            return { record };
        }
        logDiagnostics(session, telemetryRecords) {
            const diagnostics = session.config.simulation.diagnostics;
            if (diagnostics?.enabled !== true || diagnostics.console !== true)
                return;
            for (const record of telemetryRecords) {
                if (record.kind !== "warning")
                    continue;
                if (record.value.message !== "PlanningDiagnostics")
                    continue;
                const detail = record.value.detail ?? {};
                console.info("[parking-sim][diagnostics]", {
                    time: record.value.time,
                    ...detail,
                });
            }
        }
    }
    exports.SimulationEngine = SimulationEngine;
});
define("browser/app", ["require", "exports", "config/validate-config", "garage/strategy-registry", "report/report-builder", "simulation/in-memory-recorder", "simulation/session-factory", "simulation/simulation-engine"], function (require, exports, validate_config_js_1, strategy_registry_js_3, report_builder_js_1, in_memory_recorder_js_1, session_factory_js_1, simulation_engine_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.startApp = startApp;
    const exampleConfig = {
        simulation: {
            sessionName: "browser-3x3-baseline",
            startTime: "2026-06-01T00:00:00-07:00",
            durationSeconds: 3600,
            tickSeconds: 1,
            timezone: "America/Los_Angeles",
            seed: 12345,
            outputDir: "output",
            rawOutputFile: "browser-3x3-baseline.jsonl",
            revenuePolicy: {
                chargePerBillingBlock: 30,
                billingBlockMinutes: 30,
            },
            balkingPolicy: {
                startsAtQueueLength: 13,
                initialProbability: 0.5,
                probabilityStep: 0.1,
                certainAtQueueLength: 18,
            },
            "diagnostics": {
                "enabled": true,
                "console": false,
                "planningSampleIntervalSeconds": 60
            }
        },
        demand: {
            averageInboundPerDay: 1200,
            weekendMultiplier: 0.5,
            peakHour: 9,
            peakWindowHours: 2,
            peakShare: 0.5,
            parkingDuration: {
                minHours: 0.05,
                maxHours: 0.4,
                modeHours: 0.15,
            },
        },
        garage: {
            layout: {
                rows: 3,
                columns: 3,
                floors: 10,
                elevatorCell: 5,
                unavailableCells: [],
                streetFacing: "longSide",
            },
            elevator: {
                deckCount: 2,
                verticalSpeedMetersPerSecond: 0.9,
                floorHeightMeters: 2.7,
                deckRotationSeconds: 6,
            },
            vmr: {
                speedMetersPerSecond: 1.5,
                gripReleaseSeconds: 10,
            },
            preparationPositions: {
                inboundCount: 2,
                outboundCount: 2,
                kind: "parallel",
                mode: "designated",
                parallelClearSeconds: 60,
                sequentialClearSeconds: 80,
                doorSeconds: 5,
            },
            strategies: {
                placement: { type: "lowest-access-cost" },
                retrieval: { type: "simple-retrieval" },
                tripPlanner: { type: "baseline-physical" },
                preparationPositions: { type: "fixed-assignment" },
                unblocking: { type: "idle-after-10-minutes" },
            },
        },
    };
    let latestRun = null;
    const strategyControlIds = {
        placement: "placement-strategy",
        retrieval: "retrieval-strategy",
        tripPlanner: "trip-planner-strategy",
        preparationPositions: "pp-strategy",
        unblocking: "unblocking-strategy",
    };
    function startApp() {
        const configInput = getElement("config-input");
        const runButton = getElement("run-button");
        const loadExampleButton = getElement("load-example-button");
        const loadConfigButton = getElement("load-config-button");
        const saveConfigButton = getElement("save-config-button");
        const configFileInput = getElement("config-file-input");
        const rawDownloadButton = getElement("download-raw-button");
        const reportDownloadButton = getElement("download-report-button");
        configInput.value = JSON.stringify(exampleConfig, null, 2);
        initializeStrategyControls(configInput);
        loadExampleButton.addEventListener("click", () => {
            configInput.value = JSON.stringify(exampleConfig, null, 2);
            syncStrategyControlsFromConfig(configInput);
            setStatus("Example configuration loaded.");
        });
        loadConfigButton.addEventListener("click", () => {
            configFileInput.click();
        });
        configFileInput.addEventListener("change", () => {
            const file = configFileInput.files?.[0];
            configFileInput.value = "";
            if (!file)
                return;
            void loadConfigFile(file, configInput);
        });
        saveConfigButton.addEventListener("click", () => {
            saveCurrentConfig(configInput);
        });
        configInput.addEventListener("change", () => syncStrategyControlsFromConfig(configInput));
        runButton.addEventListener("click", () => {
            void runFromConfig(configInput.value);
        });
        rawDownloadButton.addEventListener("click", () => {
            if (latestRun)
                downloadText("parking-tower-raw-output.jsonl", latestRun.rawJsonl, "application/x-ndjson");
        });
        reportDownloadButton.addEventListener("click", () => {
            if (latestRun)
                downloadText("parking-tower-report.json", latestRun.reportJson, "application/json");
        });
    }
    async function loadConfigFile(file, configInput) {
        try {
            const text = await file.text();
            configInput.value = text;
            const config = JSON.parse(text);
            const validation = (0, validate_config_js_1.validateSimulationConfig)(config);
            if (!validation.valid) {
                syncStrategyControlsFromConfig(configInput);
                throw new Error(validation.errors.join("\n"));
            }
            configInput.value = JSON.stringify(config, null, 2);
            syncStrategyControlsFromConfig(configInput);
            setStatus(`Configuration loaded: ${file.name}`);
        }
        catch (error) {
            setStatus(`Configuration file loaded, but it needs attention:\n${error instanceof Error ? error.message : String(error)}`, true);
        }
    }
    function saveCurrentConfig(configInput) {
        try {
            const config = JSON.parse(configInput.value);
            const validation = (0, validate_config_js_1.validateSimulationConfig)(config);
            if (!validation.valid) {
                throw new Error(validation.errors.join("\n"));
            }
            const filename = `${safeFilename(config.simulation.sessionName || "parking-tower-config")}.json`;
            const text = JSON.stringify(config, null, 2);
            configInput.value = text;
            downloadText(filename, text, "application/json");
            setStatus(`Configuration saved: ${filename}`);
        }
        catch (error) {
            setStatus(`Configuration was not saved:\n${error instanceof Error ? error.message : String(error)}`, true);
        }
    }
    function initializeStrategyControls(configInput) {
        const descriptors = (0, strategy_registry_js_3.getStrategyDescriptors)();
        for (const category of Object.keys(strategyControlIds)) {
            const select = getElement(strategyControlIds[category]);
            for (const descriptor of descriptors.filter((item) => item.category === category)) {
                const option = document.createElement("option");
                option.value = descriptor.type;
                option.textContent = descriptor.label;
                option.title = descriptor.description;
                select.append(option);
            }
            select.addEventListener("change", () => updateConfigFromStrategyControls(configInput));
        }
        syncStrategyControlsFromConfig(configInput);
    }
    function syncStrategyControlsFromConfig(configInput) {
        try {
            const config = JSON.parse(configInput.value);
            const strategies = (0, strategy_registry_js_3.normalizeGarageStrategyConfig)(config.garage?.strategies);
            for (const category of Object.keys(strategyControlIds)) {
                getElement(strategyControlIds[category]).value = strategies[category].type;
            }
        }
        catch {
            // Malformed JSON is reported when the user runs the simulation.
        }
    }
    function updateConfigFromStrategyControls(configInput) {
        try {
            const config = JSON.parse(configInput.value);
            config.garage.strategies = {
                placement: { type: getElement(strategyControlIds.placement).value },
                retrieval: { type: getElement(strategyControlIds.retrieval).value },
                tripPlanner: { type: getElement(strategyControlIds.tripPlanner).value },
                preparationPositions: {
                    type: getElement(strategyControlIds.preparationPositions).value,
                },
                unblocking: { type: getElement(strategyControlIds.unblocking).value },
            };
            configInput.value = JSON.stringify(config, null, 2);
            setStatus("Strategy selection updated.");
        }
        catch {
            setStatus("Fix the configuration JSON before changing strategies.", true);
        }
    }
    async function runFromConfig(configText) {
        setControlsDisabled(true);
        setStatus("Parsing configuration...");
        clearSummary();
        try {
            const config = JSON.parse(configText);
            const validation = (0, validate_config_js_1.validateSimulationConfig)(config);
            if (!validation.valid) {
                throw new Error(validation.errors.join("\n"));
            }
            const recorder = new in_memory_recorder_js_1.InMemorySimulationStateRecorder();
            const session = (0, session_factory_js_1.createSimulationSession)(config, recorder);
            const runner = new simulation_engine_js_1.SimulationEngine();
            const result = await runWithProgress(runner, session);
            const report = (0, report_builder_js_1.buildReportFromRecords)(recorder.getMetadata(), recorder.getRecords(), recorder.getOutputRef());
            const run = {
                rawJsonl: recorder.toJsonl(),
                reportJson: JSON.stringify(report, null, 2),
                result,
                summary: report.thirtyDaySummary.sum,
            };
            latestRun = run;
            renderSummary(run);
            setStatus(`Simulation complete. ${report.daily.length} day row(s), ${report.thirtyDaySummary.sum.successfulActivities} successful activities.`);
            setDownloadButtonsEnabled(true);
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            setControlsDisabled(false);
        }
    }
    async function runWithProgress(runner, session) {
        await session.recorder.open(session);
        let time = 0;
        const endTime = session.config.simulation.durationSeconds;
        const tickSeconds = session.config.simulation.tickSeconds;
        let ticksSinceYield = 0;
        while (time <= endTime) {
            await runner.runOneSecond(session, time);
            time += tickSeconds;
            ticksSinceYield += 1;
            if (ticksSinceYield >= 1000) {
                ticksSinceYield = 0;
                setProgress(Math.min(100, Math.round((time / endTime) * 100)));
                await yieldToBrowser();
            }
        }
        await session.recorder.close();
        setProgress(100);
        return {
            sessionId: session.id,
            rawOutput: session.recorder.getOutputRef(),
            startedAt: 0,
            endedAt: endTime,
            finalSnapshot: session.garage.getSnapshot(),
        };
    }
    function renderSummary(run) {
        const summary = run.summary;
        const finalSnapshot = run.result.finalSnapshot;
        setText("metric-activities", String(summary.successfulActivities));
        setText("metric-occupancy", `${finalSnapshot.occupancy.occupiedCount}/${finalSnapshot.occupancy.totalParkingCells}`);
        setText("metric-inbound-wait", `${Math.round(summary.averageInboundDriverWaitingSeconds)}s`);
        setText("metric-outbound-wait", `${Math.round(summary.averageOutboundWaitSeconds)}s`);
        setText("metric-revenue", String(summary.totalRevenue));
        setText("metric-raw-size", `${Math.round(run.rawJsonl.length / 1024)} KB`);
    }
    function clearSummary() {
        for (const id of ["metric-activities", "metric-occupancy", "metric-inbound-wait", "metric-outbound-wait", "metric-revenue", "metric-raw-size"]) {
            setText(id, "-");
        }
        setProgress(0);
        setDownloadButtonsEnabled(false);
    }
    function setControlsDisabled(disabled) {
        for (const id of [
            "run-button",
            "load-example-button",
            "load-config-button",
            "save-config-button",
            "config-file-input",
            "config-input",
            ...Object.values(strategyControlIds),
        ]) {
            getElement(id).disabled = disabled;
        }
    }
    function setDownloadButtonsEnabled(enabled) {
        getElement("download-raw-button").disabled = !enabled;
        getElement("download-report-button").disabled = !enabled;
    }
    function setProgress(percent) {
        getElement("progress").value = percent;
        setText("progress-label", `${percent}%`);
    }
    function setStatus(message, isError = false) {
        const element = getElement("status");
        element.textContent = message;
        element.dataset["state"] = isError ? "error" : "normal";
    }
    function setText(id, text) {
        getElement(id).textContent = text;
    }
    function downloadText(filename, text, mimeType) {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }
    function safeFilename(value) {
        const cleaned = value
            .trim()
            .replace(/[^a-z0-9._-]+/gi, "-")
            .replace(/^-+|-+$/g, "");
        return cleaned || "parking-tower-config";
    }
    function yieldToBrowser() {
        return new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    function getElement(id) {
        const element = document.getElementById(id);
        if (!element) {
            throw new Error(`Missing element: ${id}`);
        }
        return element;
    }
});
define("browser/visualizer", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.startVisualizer = startVisualizer;
    const playbackSecondsPerSecond = 20;
    const frameCacheMaxEntries = 360;
    const parkingCellLengthMeters = 6;
    const parkingCellWidthMeters = 3;
    const vehicleLengthMeters = 5;
    const vehicleWidthMeters = 2;
    const vmrLengthMeters = 5.5;
    const vmrWidthMeters = 2.5;
    function startVisualizer() {
        const root = document.querySelector("[data-visualizer-root]");
        if (!root)
            return;
        new BrowserVisualizerApp(root).start();
    }
    class BrowserVisualizerApp {
        constructor(root) {
            this.root = root;
            this.dataSet = null;
            this.replayEngine = null;
            this.isPlaying = false;
            this.lastAnimationTime = 0;
            this.currentTime = 0;
            this.animationHandle = 0;
            this.loader = new JsonlVisualizerRawOutputLoader();
            this.physicalRenderer = new CanvasPhysicalStateRenderer();
            this.computationalRenderer = new HtmlComputationalStateRenderer();
            this.fileInput = requiredElement(root, "#raw-output-input", HTMLInputElement);
            this.status = requiredElement(root, "#visualizer-status", HTMLElement);
            this.playButton = requiredElement(root, "#play-button", HTMLButtonElement);
            this.pauseButton = requiredElement(root, "#pause-button", HTMLButtonElement);
            this.slider = requiredElement(root, "#time-slider", HTMLInputElement);
            this.timeReadout = requiredElement(root, "#time-readout", HTMLElement);
            this.physicalView = requiredElement(root, "#physical-state-view", HTMLElement);
            this.computationalView = requiredElement(root, "#computational-state-view", HTMLElement);
        }
        start() {
            this.fileInput.addEventListener("change", () => void this.loadSelectedFile());
            this.playButton.addEventListener("click", () => this.play());
            this.pauseButton.addEventListener("click", () => this.pause());
            this.slider.addEventListener("input", () => {
                this.pause();
                this.seek(Number(this.slider.value));
            });
            this.setControls(false);
            this.setStatus("Select a raw JSONL output file to inspect.", "normal");
        }
        async loadSelectedFile() {
            const file = this.fileInput.files?.[0];
            if (!file)
                return;
            this.pause();
            this.setStatus(`Loading ${file.name}...`, "normal");
            try {
                this.dataSet = await this.loader.load(file);
                this.replayEngine = new CheckpointReplayEngine(this.dataSet);
                this.currentTime = 0;
                this.slider.min = "0";
                this.slider.max = String(this.dataSet.durationSeconds);
                this.slider.step = "1";
                this.slider.value = "0";
                this.setControls(true);
                this.renderCurrentFrame();
                this.setStatus(`Loaded ${file.name}. ${this.dataSet.records.length.toLocaleString()} records, ${this.dataSet.checkpoints.length.toLocaleString()} checkpoints.`, "normal");
            }
            catch (error) {
                this.dataSet = null;
                this.replayEngine = null;
                this.setControls(false);
                this.setStatus(error instanceof Error ? error.message : String(error), "error");
            }
        }
        play() {
            if (!this.replayEngine || this.isPlaying)
                return;
            this.isPlaying = true;
            this.lastAnimationTime = performance.now();
            this.animationHandle = requestAnimationFrame((timestamp) => this.advance(timestamp));
            this.setControls(true);
        }
        pause() {
            if (this.animationHandle) {
                cancelAnimationFrame(this.animationHandle);
                this.animationHandle = 0;
            }
            this.isPlaying = false;
            this.setControls(Boolean(this.replayEngine));
        }
        advance(timestamp) {
            if (!this.isPlaying || !this.dataSet)
                return;
            const elapsedSeconds = (timestamp - this.lastAnimationTime) / 1000;
            this.lastAnimationTime = timestamp;
            const nextTime = Math.min(this.dataSet.durationSeconds, this.currentTime + elapsedSeconds * playbackSecondsPerSecond);
            this.seek(nextTime);
            if (nextTime >= this.dataSet.durationSeconds) {
                this.pause();
                return;
            }
            this.animationHandle = requestAnimationFrame((nextTimestamp) => this.advance(nextTimestamp));
        }
        seek(time) {
            if (!this.dataSet)
                return;
            this.currentTime = clamp(time, 0, this.dataSet.durationSeconds);
            this.slider.value = String(Math.round(this.currentTime));
            this.renderCurrentFrame();
        }
        renderCurrentFrame() {
            if (!this.replayEngine || !this.dataSet)
                return;
            const frame = this.replayEngine.getFrameAt(Math.round(this.currentTime));
            this.timeReadout.textContent = formatDuration(frame.time);
            this.physicalRenderer.render(this.physicalView, frame, this.dataSet.metadata.config.garage);
            this.computationalRenderer.render(this.computationalView, frame, this.dataSet.metadata.config);
        }
        setControls(enabled) {
            this.playButton.disabled = !enabled || this.isPlaying;
            this.pauseButton.disabled = !enabled || !this.isPlaying;
            this.slider.disabled = !enabled;
        }
        setStatus(message, state) {
            this.status.textContent = message;
            this.status.dataset.state = state;
        }
    }
    class JsonlVisualizerRawOutputLoader {
        async load(file) {
            const text = await file.text();
            const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
            if (lines.length === 0)
                throw new Error("The selected file is empty.");
            let metadata = null;
            const records = [];
            const checkpoints = [];
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                if (!line)
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch (error) {
                    throw new Error(`Line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
                }
                if (parsed.kind === "metadata") {
                    metadata = parsed;
                    continue;
                }
                records.push(parsed);
                if (parsed.kind === "checkpoint")
                    checkpoints.push(parsed);
            }
            if (!metadata)
                throw new Error("The raw output does not contain a metadata record.");
            const loadedMetadata = metadata;
            if (checkpoints.length === 0)
                throw new Error("The raw output does not contain checkpoints, so it cannot be replayed.");
            records.sort((a, b) => recordTime(a) - recordTime(b));
            checkpoints.sort((a, b) => a.t - b.t);
            return {
                metadata: loadedMetadata,
                records,
                checkpoints,
                durationSeconds: loadedMetadata.config.simulation.durationSeconds,
            };
        }
    }
    class CheckpointReplayEngine {
        constructor(dataSet) {
            this.dataSet = dataSet;
            this.cache = new Map();
        }
        getFrameAt(time) {
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
                if (t <= baseTime)
                    continue;
                if (t > key)
                    break;
                this.applyRecord(snapshot, record);
            }
            snapshot.time = key;
            this.cleanupActiveOperations(snapshot, key);
            this.recalculateDerivedState(snapshot);
            const elevatorDestination = this.currentElevatorDestination(snapshot.activeOperations);
            const frame = {
                time: key,
                snapshot,
                interpolatedOperations: snapshot.activeOperations.map((operation) => interpolateOperation(operation, key)),
                ...(elevatorDestination !== undefined ? { elevatorDestination } : {}),
            };
            this.rememberFrame(key, frame);
            return frame;
        }
        closestCheckpointAtOrBefore(time) {
            let low = 0;
            let high = this.dataSet.checkpoints.length - 1;
            let result = this.dataSet.checkpoints[0];
            if (!result)
                throw new Error("No checkpoints are available.");
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const candidate = this.dataSet.checkpoints[mid];
                if (!candidate)
                    break;
                if (candidate.t <= time) {
                    result = candidate;
                    low = mid + 1;
                }
                else {
                    high = mid - 1;
                }
            }
            return result;
        }
        closestCachedFrameAtOrBefore(time, checkpointTime) {
            let result = null;
            for (const [cachedTime, frame] of this.cache) {
                if (cachedTime <= checkpointTime || cachedTime >= time)
                    continue;
                if (!result || cachedTime > result.time)
                    result = frame;
            }
            if (result) {
                this.cache.delete(result.time);
                this.cache.set(result.time, result);
            }
            return result;
        }
        applyRecord(snapshot, record) {
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
        applyEvents(snapshot, record) {
            for (const result of record.intake) {
                if (!result.accepted)
                    continue;
                const event = record.generated.find((candidate) => candidate.id === result.eventId);
                const queued = {
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
        applyOperations(snapshot, record) {
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
        applyState(snapshot, record) {
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
        applyOperationStart(snapshot, operation) {
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
            if (deckIndex === null)
                return;
            const vmr = snapshot.vmrs[deckIndex];
            if (!vmr)
                return;
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
        applyOperationComplete(snapshot, operation, time) {
            snapshot.activeOperations = snapshot.activeOperations.filter((active) => {
                if (active.completesAt > time)
                    return true;
                if (active.type !== operation.type)
                    return true;
                if (operation.vehicleId && active.vehicleId !== operation.vehicleId)
                    return true;
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
        enterInboundPreparationPosition(snapshot, operation, time) {
            if (!operation.vehicleId)
                return;
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
        loadDeckFromPreparationPosition(snapshot, operation, role) {
            if (!operation.vehicleId)
                return;
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
        loadDeckFromCell(snapshot, operation, role) {
            if (!operation.vehicleId)
                return;
            const to = stringDetail(operation.detail, "to");
            removeOccupiedVehicle(snapshot, operation.vehicleId);
            const deck = deckByLocation(snapshot.elevator.decks ?? [], to);
            if (deck) {
                deck.vehicleId = operation.vehicleId;
                deck.vehicleRole = role;
            }
        }
        parkFromDeck(snapshot, operation, time) {
            if (!operation.vehicleId)
                return;
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
            if (deck)
                clearDeck(deck);
        }
        retrieveOutbound(snapshot, operation, time) {
            if (!operation.vehicleId)
                return;
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
            if (deck)
                clearDeck(deck);
            snapshot.queues.outbound = snapshot.queues.outbound.filter((item) => item.vehicleId !== operation.vehicleId);
        }
        moveElevator(snapshot, operation) {
            const to = elevatorPosition(stringDetail(operation.detail, "to"));
            if (to === null)
                return;
            snapshot.elevator.currentFloor = to;
            snapshot.elevator.status = "Busy";
            snapshot.elevator.direction = "stopped";
            for (const deck of snapshot.elevator.decks ?? []) {
                deck.alignedFloor = to - deck.index;
            }
        }
        rotateDeck(snapshot, operation) {
            const to = stringDetail(operation.detail, "to");
            if (to !== "garage" && to !== "street")
                return;
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
        operateDoor(snapshot, operation, time) {
            const to = stringDetail(operation.detail, "to");
            if (to !== "open" && to !== "closed")
                return;
            const group = stringDetail(operation.detail, "group") ?? "";
            const direction = group.includes("outbound") ? "outbound" : group.includes("inbound") ? "inbound" : null;
            for (const position of snapshot.preparationPositions) {
                if (direction && position.direction !== direction)
                    continue;
                position.doorState = to;
                delete position.doorTransitionCompleteAt;
                if (to === "open" && position.direction === "outbound" && position.occupiedBy) {
                    position.readyAt = time;
                }
            }
        }
        finishVmrForOperation(snapshot, operation) {
            const from = stringDetail(operation.detail, "from");
            const to = stringDetail(operation.detail, "to");
            const index = parseDeckIndex(from) ?? parseDeckIndex(to);
            if (index === null)
                return;
            const vmr = snapshot.vmrs[index];
            if (!vmr)
                return;
            vmr.status = "Idle";
            delete vmr.currentTask;
        }
        cleanupActiveOperations(snapshot, time) {
            snapshot.activeOperations = snapshot.activeOperations.filter((operation) => operation.completesAt > time);
            const busyDeckIndexes = new Set();
            for (const operation of snapshot.activeOperations) {
                const deckIndex = operationDeckIndex(operation);
                if (deckIndex !== null && operation.type !== "RotateDeck") {
                    busyDeckIndexes.add(deckIndex);
                }
            }
            snapshot.vmrs = snapshot.vmrs.map((vmr, index) => {
                if (!busyDeckIndexes.has(index)) {
                    const idle = { ...vmr, status: "Idle" };
                    delete idle.currentTask;
                    return idle;
                }
                return vmr;
            });
            snapshot.elevator.status = snapshot.activeOperations.length > 0 ? "Busy" : "IdleAtHome";
        }
        recalculateDerivedState(snapshot) {
            snapshot.queues.inboundLength = snapshot.queues.inbound.length;
            snapshot.queues.outboundLength = snapshot.queues.outbound.length;
            snapshot.occupancy.occupied.sort((a, b) => a.cellId.localeCompare(b.cellId));
            snapshot.occupancy.occupiedCount = snapshot.occupancy.occupied.length;
            const occupiedCellIds = new Set(snapshot.occupancy.occupied.map((cell) => cell.cellId));
            const reservedCount = (snapshot.occupancy.reservations ?? []).filter((reservation) => !occupiedCellIds.has(reservation.cellId)).length;
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
        currentElevatorDestination(operations) {
            const move = operations.find((operation) => operation.type === "MoveElevator");
            const destination = move ? elevatorPosition(move.to) : null;
            return destination ?? undefined;
        }
        rememberFrame(time, frame) {
            this.cache.set(time, frame);
            while (this.cache.size > frameCacheMaxEntries) {
                const firstKey = this.cache.keys().next().value;
                if (firstKey === undefined)
                    return;
                this.cache.delete(firstKey);
            }
        }
    }
    class CanvasPhysicalStateRenderer {
        constructor() {
            this.canvas = null;
        }
        render(container, frame, garage) {
            const geometry = this.buildGeometry(Math.max(720, Math.floor(container.clientWidth || 960)), garage.layout, frame.snapshot.preparationPositions);
            const canvas = this.ensureCanvas(container);
            const context = canvas.getContext("2d");
            if (!context)
                return;
            this.sizeCanvas(canvas, context, geometry);
            this.drawBackground(context, geometry);
            this.drawFloors(context, geometry, garage.layout);
            this.drawStreet(context, geometry, frame.snapshot);
            this.drawPlannedPaths(context, geometry, frame);
            this.drawPreparationPositionFrames(context, geometry, frame.snapshot);
            this.drawMovingVmrs(context, geometry, frame);
            this.drawElevatorDecks(context, geometry, frame);
            this.drawParkedVehicles(context, geometry, frame);
            this.drawReservedDestinations(context, geometry, frame);
            this.drawPreparationPositionVehicles(context, geometry, frame.snapshot);
            this.drawMovingVehicles(context, geometry, frame);
        }
        ensureCanvas(container) {
            if (this.canvas && container.contains(this.canvas))
                return this.canvas;
            const existingCanvas = container.querySelector("canvas.garage-canvas");
            if (existingCanvas) {
                this.canvas = existingCanvas;
                return existingCanvas;
            }
            const panel = document.createElement("section");
            panel.className = "canvas-visualizer-panel";
            panel.setAttribute("aria-label", "Physical garage canvas");
            const canvas = document.createElement("canvas");
            canvas.className = "garage-canvas";
            panel.append(canvas);
            container.replaceChildren(panel);
            this.canvas = canvas;
            return canvas;
        }
        sizeCanvas(canvas, context, geometry) {
            const ratio = globalThis.devicePixelRatio || 1;
            canvas.width = Math.ceil(geometry.width * ratio);
            canvas.height = Math.ceil(geometry.height * ratio);
            canvas.style.width = `${geometry.width}px`;
            canvas.style.height = `${geometry.height}px`;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
        buildGeometry(availableWidth, layout, preparationPositions) {
            const margin = 24;
            const labelHeight = 28;
            const floorGap = 34;
            const streetGap = 14;
            const cellWidthMeters = layout.streetFacing === "longSide" ? parkingCellLengthMeters : parkingCellWidthMeters;
            const cellHeightMeters = layout.streetFacing === "longSide" ? parkingCellWidthMeters : parkingCellLengthMeters;
            const floorWidthMeters = layout.columns * cellWidthMeters;
            const floorHeightMeters = layout.rows * cellHeightMeters;
            const scale = Math.max(12, Math.min(34, (availableWidth - margin * 2) / floorWidthMeters));
            const longAxisHorizontal = layout.streetFacing === "longSide";
            const vehicleSize = {
                width: (longAxisHorizontal ? vehicleLengthMeters : vehicleWidthMeters) * scale,
                height: (longAxisHorizontal ? vehicleWidthMeters : vehicleLengthMeters) * scale,
            };
            const perpendicularVehicleSize = {
                width: (longAxisHorizontal ? vehicleWidthMeters : vehicleLengthMeters) * scale,
                height: (longAxisHorizontal ? vehicleLengthMeters : vehicleWidthMeters) * scale,
            };
            const vmrSize = {
                width: (longAxisHorizontal ? vmrLengthMeters : vmrWidthMeters) * scale,
                height: (longAxisHorizontal ? vmrWidthMeters : vmrLengthMeters) * scale,
            };
            const streetHeight = Math.max(126, vehicleSize.height * 3 + 78);
            const floorWidth = floorWidthMeters * scale;
            const floorHeight = floorHeightMeters * scale;
            const width = Math.ceil(Math.max(availableWidth, floorWidth + margin * 2));
            const cellsById = new Map();
            const elevatorByFloor = new Map();
            const floors = new Map();
            let y = margin;
            let street = { x: margin, y: margin, width: floorWidth, height: streetHeight };
            for (let floor = layout.floors; floor >= 1; floor -= 1) {
                const floorRect = {
                    x: margin,
                    y: y + labelHeight,
                    width: floorWidth,
                    height: floorHeight,
                };
                floors.set(floor, floorRect);
                for (let cellNumber = 1; cellNumber <= layout.rows * layout.columns; cellNumber += 1) {
                    const row = Math.floor((cellNumber - 1) / layout.columns);
                    const column = (cellNumber - 1) % layout.columns;
                    const rect = {
                        x: floorRect.x + column * cellWidthMeters * scale,
                        y: floorRect.y + row * cellHeightMeters * scale,
                        width: cellWidthMeters * scale,
                        height: cellHeightMeters * scale,
                    };
                    const cellId = `f${floor}c${cellNumber}`;
                    cellsById.set(cellId, rect);
                    if (cellNumber === layout.elevatorCell)
                        elevatorByFloor.set(floor, rect);
                }
                y += labelHeight + floorHeight;
                if (floor === 1) {
                    street = {
                        x: margin,
                        y: y + streetGap,
                        width: floorWidth,
                        height: streetHeight,
                    };
                    y += streetGap + streetHeight;
                }
                y += floorGap;
            }
            const inboundQueue = {
                x: street.x + 12,
                y: street.y + 36,
                width: Math.max(180, street.width * 0.42),
                height: street.height - 50,
            };
            const preparationRects = this.buildPreparationPositionRects(layout, cellsById, street, inboundQueue, preparationPositions);
            return {
                width,
                height: Math.ceil(y),
                scale,
                vehicleSize,
                perpendicularVehicleSize,
                vmrSize,
                floorWidth,
                floorHeight,
                cellsById,
                elevatorByFloor,
                floors,
                street,
                inboundQueue,
                preparationPositions: preparationRects,
            };
        }
        buildPreparationPositionRects(layout, cellsById, street, inboundQueue, positions) {
            const result = new Map();
            const firstFloorSlots = this.firstFloorPreparationPositionSlots(layout, cellsById);
            if (firstFloorSlots.length > 0) {
                positions.forEach((position, index) => {
                    const slot = firstFloorSlots[index % firstFloorSlots.length];
                    if (slot)
                        result.set(position.id, slot);
                });
                return result;
            }
            const gap = 8;
            const startX = inboundQueue.x + inboundQueue.width + 16;
            const availableWidth = Math.max(160, street.x + street.width - startX - 12);
            const columns = positions.length <= 2 ? positions.length || 1 : 2;
            const rows = Math.max(1, Math.ceil(positions.length / columns));
            const rectWidth = (availableWidth - gap * (columns - 1)) / columns;
            const rectHeight = Math.min(42, (street.height - 50 - gap * (rows - 1)) / rows);
            positions.forEach((position, index) => {
                const column = index % columns;
                const row = Math.floor(index / columns);
                result.set(position.id, {
                    x: startX + column * (rectWidth + gap),
                    y: street.y + 36 + row * (rectHeight + gap),
                    width: rectWidth,
                    height: rectHeight,
                });
            });
            return result;
        }
        firstFloorPreparationPositionSlots(layout, cellsById) {
            if (layout.streetFacing !== "longSide" || layout.rows < 3 || layout.columns < 3) {
                return [];
            }
            const left = unionRects(cellsById.get("f1c4"), cellsById.get("f1c7"));
            const right = unionRects(cellsById.get("f1c6"), cellsById.get("f1c9"));
            if (!left || !right)
                return [];
            return [leftHalf(left), rightHalf(left), leftHalf(right), rightHalf(right)];
        }
        drawBackground(context, geometry) {
            context.clearRect(0, 0, geometry.width, geometry.height);
            context.fillStyle = "#ffffff";
            this.fillRoundedRect(context, 0, 0, geometry.width, geometry.height, 8);
        }
        drawFloors(context, geometry, layout) {
            const unavailable = new Set([layout.elevatorCell, ...layout.unavailableCells]);
            for (const [floor, floorRect] of geometry.floors) {
                context.fillStyle = "#1f2a2e";
                context.font = "700 15px Arial, Helvetica, sans-serif";
                context.fillText(`Floor ${floor}`, floorRect.x, floorRect.y - 9);
                context.fillStyle = "#627178";
                context.font = "12px Arial, Helvetica, sans-serif";
                context.fillText(`${formatMeters(geometry.floorWidth / geometry.scale)}m x ${formatMeters(geometry.floorHeight / geometry.scale)}m`, floorRect.x + 78, floorRect.y - 9);
                context.strokeStyle = "#ccd7d4";
                context.lineWidth = 1;
                context.strokeRect(floorRect.x, floorRect.y, floorRect.width, floorRect.height);
                for (let cellNumber = 1; cellNumber <= layout.rows * layout.columns; cellNumber += 1) {
                    const rect = geometry.cellsById.get(`f${floor}c${cellNumber}`);
                    if (!rect)
                        continue;
                    const isElevator = cellNumber === layout.elevatorCell;
                    const isUnavailable = unavailable.has(cellNumber);
                    context.fillStyle = isElevator ? "#e7ecef" : isUnavailable ? "#eef0ef" : "#fbfcfc";
                    context.fillRect(rect.x, rect.y, rect.width, rect.height);
                    context.strokeStyle = isElevator ? "#7d8f99" : "#d7dfdc";
                    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
                    context.fillStyle = "#627178";
                    context.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
                    context.fillText(`c${cellNumber}`, rect.x + 5, rect.y + 14);
                    if (isElevator) {
                        context.fillStyle = "#50636c";
                        context.font = "700 11px Arial, Helvetica, sans-serif";
                        context.fillText("Elevator", rect.x + 5, rect.y + rect.height - 8);
                    }
                }
            }
        }
        drawStreet(context, geometry, snapshot) {
            context.fillStyle = "#f6f8f7";
            this.fillRoundedRect(context, geometry.street.x, geometry.street.y, geometry.street.width, geometry.street.height, 8);
            context.strokeStyle = "#d7dfdc";
            context.strokeRect(geometry.street.x, geometry.street.y, geometry.street.width, geometry.street.height);
            context.fillStyle = "#1f2a2e";
            context.font = "700 14px Arial, Helvetica, sans-serif";
            context.fillText("Street Level", geometry.street.x + 12, geometry.street.y + 22);
            this.drawLabeledBox(context, geometry.inboundQueue, "Inbound Queue", "#eef4f2");
            const vehicleStepX = geometry.vehicleSize.width + 10;
            const vehicleStepY = geometry.vehicleSize.height + 10;
            const queueColumns = Math.max(1, Math.floor((geometry.inboundQueue.width - 20) / vehicleStepX));
            snapshot.queues.inbound.slice(0, 12).forEach((vehicle, index) => {
                const center = {
                    x: geometry.inboundQueue.x + 10 + geometry.vehicleSize.width / 2 + (index % queueColumns) * vehicleStepX,
                    y: geometry.inboundQueue.y + 30 + geometry.vehicleSize.height / 2 + Math.floor(index / queueColumns) * vehicleStepY,
                };
                this.drawVehicle(context, this.vehicleRectAt(center, geometry), vehicle.vehicleId, "#14343d");
            });
            if (snapshot.queues.inbound.length > 12) {
                context.fillStyle = "#627178";
                context.font = "12px Arial, Helvetica, sans-serif";
                context.fillText(`+${snapshot.queues.inbound.length - 12} more`, geometry.inboundQueue.x + 10, geometry.inboundQueue.y + geometry.inboundQueue.height - 10);
            }
        }
        drawPreparationPositionFrames(context, geometry, snapshot) {
            for (const position of snapshot.preparationPositions) {
                const rect = geometry.preparationPositions.get(position.id);
                if (!rect)
                    continue;
                context.fillStyle = position.direction === "inbound" ? "#fff34a" : "#ffef65";
                context.fillRect(rect.x, rect.y, rect.width, rect.height);
                context.strokeStyle = "#1f2a2e";
                context.lineWidth = 1;
                context.strokeRect(rect.x, rect.y, rect.width, rect.height);
                context.fillStyle = "#1f2a2e";
                context.font = "700 11px Arial, Helvetica, sans-serif";
                this.drawStackedText(context, physicalPreparationPositionLabel(position), rect.x + 9, rect.y + 20, 15);
                context.font = "10px Arial, Helvetica, sans-serif";
                context.fillText(position.doorState ?? "unknown", rect.x + 6, rect.y + rect.height - 6);
            }
        }
        drawPreparationPositionVehicles(context, geometry, snapshot) {
            for (const position of snapshot.preparationPositions) {
                if (!position.occupiedBy)
                    continue;
                const rect = geometry.preparationPositions.get(position.id);
                if (!rect)
                    continue;
                this.drawVehicle(context, this.vehicleRectAt(rectCenter(rect), geometry, "perpendicular"), position.occupiedBy, "#14343d");
            }
        }
        drawPlannedPaths(context, geometry, frame) {
            frame.interpolatedOperations.forEach((item, index) => {
                const points = this.polylineForOperation(geometry, item.operation);
                if (points.length < 2)
                    return;
                const color = index % 2 === 0 ? "#c18622" : "#0f7a6c";
                context.save();
                context.strokeStyle = color;
                context.fillStyle = color;
                context.lineWidth = 3;
                context.setLineDash([8, 6]);
                context.beginPath();
                context.moveTo(points[0]?.x ?? 0, points[0]?.y ?? 0);
                for (const point of points.slice(1))
                    context.lineTo(point.x, point.y);
                context.stroke();
                context.setLineDash([]);
                this.drawArrowHead(context, points[points.length - 2], points[points.length - 1], color);
                const last = points[points.length - 1];
                if (last) {
                    context.font = "700 11px Arial, Helvetica, sans-serif";
                    context.fillText(`${deckLabel(item.operation)} dest`, last.x + 6, last.y - 6);
                }
                context.restore();
            });
        }
        drawParkedVehicles(context, geometry, frame) {
            const movingVehicles = this.movingVehicleIds(frame);
            for (const occupancy of frame.snapshot.occupancy.occupied) {
                if (movingVehicles.has(occupancy.vehicleId))
                    continue;
                const rect = geometry.cellsById.get(occupancy.cellId);
                if (!rect)
                    continue;
                this.drawVehicle(context, this.vehicleRectAt(rectCenter(rect), geometry), occupancy.vehicleId, "#14343d");
            }
        }
        drawReservedDestinations(context, geometry, frame) {
            const occupied = new Set(frame.snapshot.occupancy.occupied.map((cell) => cell.cellId));
            for (const reservation of frame.snapshot.occupancy.reservations ?? []) {
                if (occupied.has(reservation.cellId))
                    continue;
                const rect = geometry.cellsById.get(reservation.cellId);
                if (!rect)
                    continue;
                const vehicleRect = this.vehicleRectAt(rectCenter(rect), geometry);
                context.save();
                context.strokeStyle = "#a13a31";
                context.lineWidth = 2;
                context.setLineDash([6, 4]);
                context.strokeRect(vehicleRect.x, vehicleRect.y, vehicleRect.width, vehicleRect.height);
                context.setLineDash([]);
                context.fillStyle = "#a13a31";
                context.font = "700 10px Arial, Helvetica, sans-serif";
                context.fillText(`R ${shortId(reservation.vehicleId)}`, vehicleRect.x + 5, vehicleRect.y + 14);
                context.restore();
            }
        }
        drawElevatorDecks(context, geometry, frame) {
            const movingVehicles = this.movingVehicleIds(frame);
            const activeVmrDeckIndexes = this.activeVmrDeckIndexes(frame);
            const decksByFloor = groupDecksByFloor(frame.snapshot.elevator.decks ?? []);
            for (const [floor, decks] of decksByFloor) {
                const shaft = geometry.elevatorByFloor.get(floor);
                if (!shaft)
                    continue;
                decks.forEach((deck, index) => {
                    const deckRect = insetRectByPixels(shaft, 5 + index * 2, 18 + index * 2);
                    context.fillStyle = "rgba(255, 255, 255, 0.68)";
                    this.fillRoundedRect(context, deckRect.x, deckRect.y, deckRect.width, deckRect.height, 5);
                    context.strokeStyle = "#7d8f99";
                    context.strokeRect(deckRect.x, deckRect.y, deckRect.width, deckRect.height);
                    context.fillStyle = "#1f2a2e";
                    context.font = "700 11px Arial, Helvetica, sans-serif";
                    context.fillText(deck.id, deckRect.x + 5, deckRect.y + 13);
                    context.fillStyle = "#627178";
                    context.font = "10px Arial, Helvetica, sans-serif";
                    context.fillText(deck.vmrId, deckRect.x + 5, deckRect.y + deckRect.height - 6);
                    if (!activeVmrDeckIndexes.has(deck.index)) {
                        this.drawVmr(context, this.vmrRectAt(rectCenter(shaft), geometry), deck.vmrId);
                    }
                    if (deck.vehicleId && !movingVehicles.has(deck.vehicleId)) {
                        this.drawVehicle(context, this.vehicleRectAt(rectCenter(shaft), geometry), deck.vehicleId, deck.vehicleRole === "outbound" ? "#87352f" : "#14343d");
                    }
                });
            }
        }
        drawMovingVmrs(context, geometry, frame) {
            for (const item of frame.interpolatedOperations) {
                const points = this.polylineForOperation(geometry, item.operation);
                if (points.length < 2)
                    continue;
                const sample = samplePolyline(points, item.progress);
                const deck = deckLabel(item.operation);
                this.drawVmr(context, this.vmrRectAt(sample.point, geometry), deck);
                context.fillStyle = "#1f2a2e";
                context.font = "700 11px Arial, Helvetica, sans-serif";
                context.fillText(`${deck} ${Math.round(item.progress * 100)}%`, sample.point.x + 12, sample.point.y - 12);
            }
        }
        drawMovingVehicles(context, geometry, frame) {
            for (const item of frame.interpolatedOperations) {
                const points = this.polylineForOperation(geometry, item.operation);
                if (points.length < 2)
                    continue;
                const sample = samplePolyline(points, item.progress);
                if (item.operation.vehicleId && carriesVehicle(item.operation.type)) {
                    this.drawVehicle(context, this.vehicleRectAt({
                        x: sample.point.x,
                        y: sample.point.y - geometry.vmrSize.height * 0.18,
                    }, geometry), item.operation.vehicleId, "#87352f");
                }
            }
        }
        polylineForOperation(geometry, operation) {
            const rawLocations = operation.path && operation.path.locations.length > 0
                ? operation.path.locations
                : operation.path?.cells ?? [];
            const points = [];
            for (const location of rawLocations) {
                const point = this.pointForLocation(geometry, location);
                if (!point)
                    continue;
                const previous = points[points.length - 1];
                if (previous && previous.x === point.x && previous.y === point.y)
                    continue;
                points.push(point);
            }
            return points;
        }
        pointForLocation(geometry, location) {
            const cell = geometry.cellsById.get(location);
            if (cell)
                return rectCenter(cell);
            const elevatorMatch = location.match(/^f(\d+):elevator$/);
            if (elevatorMatch?.[1]) {
                const elevator = geometry.elevatorByFloor.get(Number(elevatorMatch[1]));
                return elevator ? rectCenter(elevator) : null;
            }
            return null;
        }
        movingVehicleIds(frame) {
            const result = new Set();
            for (const item of frame.interpolatedOperations) {
                if (item.operation.vehicleId && item.operation.path && carriesVehicle(item.operation.type)) {
                    result.add(item.operation.vehicleId);
                }
            }
            return result;
        }
        activeVmrDeckIndexes(frame) {
            const result = new Set();
            for (const item of frame.interpolatedOperations) {
                const deckIndex = operationDeckIndex(item.operation);
                if (deckIndex !== null && item.operation.path && item.operation.type !== "RotateDeck") {
                    result.add(deckIndex);
                }
            }
            return result;
        }
        drawLabeledBox(context, rect, label, fill) {
            context.fillStyle = fill;
            this.fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 6);
            context.strokeStyle = "#d7dfdc";
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);
            context.fillStyle = "#1f2a2e";
            context.font = "700 12px Arial, Helvetica, sans-serif";
            context.fillText(label, rect.x + 8, rect.y + 15);
        }
        drawVehicle(context, rect, vehicleId, color) {
            context.fillStyle = color;
            this.fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
            context.fillStyle = "#ffffff";
            context.font = "700 10px Arial, Helvetica, sans-serif";
            context.fillText(`V ${shortId(vehicleId)}`, rect.x + 5, rect.y + Math.min(rect.height - 5, 14));
        }
        drawVmr(context, rect, label) {
            context.fillStyle = "#0f7a6c";
            this.fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
            context.strokeStyle = "#ffffff";
            context.lineWidth = 2;
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);
            context.fillStyle = "#ffffff";
            context.font = "700 10px Arial, Helvetica, sans-serif";
            context.fillText(label, rect.x + 5, rect.y + Math.min(rect.height - 5, 14));
        }
        vehicleRectAt(center, geometry, orientation = "parking") {
            const size = orientation === "perpendicular"
                ? geometry.perpendicularVehicleSize
                : geometry.vehicleSize;
            return rectFromCenter(center, size.width, size.height);
        }
        vmrRectAt(center, geometry) {
            return rectFromCenter(center, geometry.vmrSize.width, geometry.vmrSize.height);
        }
        drawArrowHead(context, from, to, color) {
            if (!from || !to)
                return;
            const angle = Math.atan2(to.y - from.y, to.x - from.x);
            const size = 9;
            context.fillStyle = color;
            context.beginPath();
            context.moveTo(to.x, to.y);
            context.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
            context.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
            context.closePath();
            context.fill();
        }
        fillRoundedRect(context, x, y, width, height, radius) {
            const r = Math.min(radius, width / 2, height / 2);
            context.beginPath();
            context.moveTo(x + r, y);
            context.lineTo(x + width - r, y);
            context.quadraticCurveTo(x + width, y, x + width, y + r);
            context.lineTo(x + width, y + height - r);
            context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
            context.lineTo(x + r, y + height);
            context.quadraticCurveTo(x, y + height, x, y + height - r);
            context.lineTo(x, y + r);
            context.quadraticCurveTo(x, y, x + r, y);
            context.closePath();
            context.fill();
        }
        drawStackedText(context, text, x, y, lineHeight) {
            [...text].forEach((char, index) => {
                context.fillText(char, x, y + index * lineHeight);
            });
        }
    }
    class HtmlComputationalStateRenderer {
        render(container, frame, config) {
            const snapshot = frame.snapshot;
            const active = snapshot.activeOperations;
            container.innerHTML = `
      <section class="state-panel">
        <h2>Simulation State</h2>
        <dl class="state-list">
          <div><dt>Scenario</dt><dd>${escapeHtml(config.simulation.sessionName)}</dd></div>
          <div><dt>Time</dt><dd>${formatDuration(frame.time)}</dd></div>
          <div><dt>Occupancy</dt><dd>${snapshot.occupancy.occupiedCount} / ${snapshot.occupancy.totalParkingCells}</dd></div>
          <div><dt>Reserved Cells</dt><dd>${snapshot.occupancy.reservedCount ?? 0}</dd></div>
          <div><dt>Effective Occupancy</dt><dd>${snapshot.occupancy.effectiveOccupiedCount ?? snapshot.occupancy.occupiedCount} / ${snapshot.occupancy.totalParkingCells}</dd></div>
          <div><dt>Inbound Queue</dt><dd>${snapshot.queues.inboundLength}</dd></div>
          <div><dt>Outbound Queue</dt><dd>${snapshot.queues.outboundLength}</dd></div>
          <div><dt>Elevator</dt><dd>floor ${snapshot.elevator.currentFloor}, ${escapeHtml(snapshot.elevator.direction ?? "stopped")}</dd></div>
          <div><dt>Elevator Destination</dt><dd>${frame.elevatorDestination === undefined ? "none" : `floor ${frame.elevatorDestination}`}</dd></div>
        </dl>
      </section>
      <section class="state-panel">
        <h2>Outbound Queue</h2>
        <div class="compact-queue">${snapshot.queues.outbound.length === 0 ? "<span class=\"muted-text\">Empty</span>" : snapshot.queues.outbound.map((item) => `<span>V ${escapeHtml(item.vehicleId)} <small>@ ${formatDuration(item.queuedAt)}</small></span>`).join("")}</div>
      </section>
      <section class="state-panel">
        <h2>Active Operations</h2>
        ${active.length === 0 ? "<p class=\"muted-text\">No active operations.</p>" : `<div class="operation-list">${frame.interpolatedOperations.map((item) => this.renderOperation(item)).join("")}</div>`}
      </section>
      <section class="state-panel">
        <h2>Trip And Counters</h2>
        <dl class="state-list">
          <div><dt>Trip Phase</dt><dd>${escapeHtml(snapshot.elevator.activeTrip?.phase ?? "none")}</dd></div>
          <div><dt>Trip Route</dt><dd>${snapshot.elevator.activeTrip?.route.join(" -> ") ?? "none"}</dd></div>
          <div><dt>Inbound Completed</dt><dd>${snapshot.counters.inboundCompleted}</dd></div>
          <div><dt>Outbound Completed</dt><dd>${snapshot.counters.outboundCompleted}</dd></div>
          <div><dt>VMR Distance</dt><dd>${Math.round(snapshot.counters.vmrDistanceMeters)} m</dd></div>
        </dl>
      </section>
    `;
        }
        renderOperation(item) {
            const operation = item.operation;
            return `
      <div class="operation-item">
        <strong>${escapeHtml(operation.type)}${operation.vehicleId ? `, V ${escapeHtml(operation.vehicleId)}` : ""}</strong>
        <span>${escapeHtml(operation.from ?? "unknown")} -> ${escapeHtml(operation.to ?? "unknown")}</span>
        <progress max="1" value="${item.progress.toFixed(3)}"></progress>
        <small>${Math.round(item.progress * 100)}%${item.currentLocation ? `, now ${escapeHtml(item.currentLocation)}` : ""}</small>
      </div>
    `;
        }
    }
    function buildActivePathIndex(operations) {
        const result = new Map();
        for (const item of operations) {
            const path = item.operation.path;
            if (!path)
                continue;
            const label = `${deckLabel(item.operation)}${item.operation.vehicleId ? ` V${item.operation.vehicleId}` : ""}`;
            for (const cell of path.cells) {
                const entry = ensurePathEntry(result, cell);
                entry.path.push(label);
            }
            if (item.currentLocation?.startsWith("f")) {
                ensurePathEntry(result, item.currentLocation).current.push(label);
            }
            if (item.destination?.startsWith("f")) {
                ensurePathEntry(result, item.destination).destination.push(`to ${label}`);
            }
        }
        return result;
    }
    function groupDecksByFloor(decks) {
        const result = new Map();
        for (const deck of decks) {
            const list = result.get(deck.alignedFloor) ?? [];
            list.push(deck);
            result.set(deck.alignedFloor, list);
        }
        return result;
    }
    function ensurePathEntry(map, cellId) {
        const existing = map.get(cellId);
        if (existing)
            return existing;
        const entry = { path: [], current: [], destination: [] };
        map.set(cellId, entry);
        return entry;
    }
    function interpolateOperation(operation, time) {
        const duration = Math.max(1, operation.completesAt - operation.startedAt);
        const progress = clamp((time - operation.startedAt) / duration, 0, 1);
        const pathLocation = pathLocationAt(operation.path, progress);
        return {
            operation,
            progress,
            ...(pathLocation.current ? { currentLocation: pathLocation.current } : {}),
            ...(pathLocation.destination ? { destination: pathLocation.destination } : {}),
        };
    }
    function pathLocationAt(path, progress) {
        if (!path || path.locations.length === 0)
            return {};
        const lastIndex = path.locations.length - 1;
        const index = Math.min(lastIndex, Math.max(0, Math.floor(progress * lastIndex)));
        return {
            ...(path.locations[index] ? { current: path.locations[index] } : {}),
            ...(path.locations[lastIndex] ? { destination: path.locations[lastIndex] } : {}),
        };
    }
    function samplePolyline(points, progress) {
        if (points.length === 0) {
            const origin = { x: 0, y: 0 };
            return { point: origin, previous: origin, next: origin };
        }
        if (points.length === 1) {
            const only = points[0] ?? { x: 0, y: 0 };
            return { point: only, previous: only, next: only };
        }
        const segmentLengths = [];
        let totalLength = 0;
        for (let index = 0; index < points.length - 1; index += 1) {
            const from = points[index];
            const to = points[index + 1];
            if (!from || !to)
                continue;
            const length = distance(from, to);
            segmentLengths.push(length);
            totalLength += length;
        }
        if (totalLength === 0) {
            const first = points[0] ?? { x: 0, y: 0 };
            return { point: first, previous: first, next: first };
        }
        let remaining = clamp(progress, 0, 1) * totalLength;
        for (let index = 0; index < segmentLengths.length; index += 1) {
            const length = segmentLengths[index] ?? 0;
            const from = points[index];
            const to = points[index + 1];
            if (!from || !to)
                continue;
            if (remaining <= length || index === segmentLengths.length - 1) {
                const localProgress = length === 0 ? 0 : remaining / length;
                return {
                    point: {
                        x: from.x + (to.x - from.x) * localProgress,
                        y: from.y + (to.y - from.y) * localProgress,
                    },
                    previous: from,
                    next: to,
                };
            }
            remaining -= length;
        }
        const last = points[points.length - 1] ?? { x: 0, y: 0 };
        const previous = points[points.length - 2] ?? last;
        return { point: last, previous, next: last };
    }
    function distance(from, to) {
        return Math.hypot(to.x - from.x, to.y - from.y);
    }
    function rectCenter(rect) {
        return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
        };
    }
    function rectFromCenter(center, width, height) {
        return {
            x: center.x - width / 2,
            y: center.y - height / 2,
            width,
            height,
        };
    }
    function insetRectByPixels(rect, xInset, yInset) {
        return {
            x: rect.x + xInset,
            y: rect.y + yInset,
            width: Math.max(8, rect.width - xInset * 2),
            height: Math.max(8, rect.height - yInset * 2),
        };
    }
    function unionRects(a, b) {
        if (!a || !b)
            return null;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const right = Math.max(a.x + a.width, b.x + b.width);
        const bottom = Math.max(a.y + a.height, b.y + b.height);
        return {
            x,
            y,
            width: right - x,
            height: bottom - y,
        };
    }
    function leftHalf(rect) {
        return {
            x: rect.x,
            y: rect.y,
            width: rect.width / 2,
            height: rect.height,
        };
    }
    function rightHalf(rect) {
        return {
            x: rect.x + rect.width / 2,
            y: rect.y,
            width: rect.width / 2,
            height: rect.height,
        };
    }
    function physicalPreparationPositionLabel(position) {
        const number = Number(/\d+$/.exec(position.id)?.[0] ?? 1);
        if (position.id.startsWith("IPP"))
            return `PP${5 - number}`;
        if (position.id.startsWith("OPP"))
            return `PP${3 - number}`;
        return position.id.replace(/^P/, "PP");
    }
    function carriesVehicle(type) {
        return (type === "ParkInbound" ||
            type === "LoadOutbound" ||
            type === "MoveBlocker" ||
            type === "RelocateBlocker" ||
            type === "IdleUnblock");
    }
    function shortId(id) {
        return id.length <= 8 ? id : id.slice(-8);
    }
    function formatMeters(value) {
        return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }
    function operationDeckIndex(operation) {
        return parseDeckIndex(operation.from) ?? parseDeckIndex(operation.to);
    }
    function deckByLocation(decks, location) {
        const index = parseDeckIndex(location);
        return index === null ? undefined : decks[index];
    }
    function parseDeckIndex(location) {
        if (!location?.startsWith("D"))
            return null;
        const value = Number(location.slice(1));
        return Number.isFinite(value) && value >= 1 ? value - 1 : null;
    }
    function deckLabel(operation) {
        const index = operationDeckIndex(operation);
        return index === null ? "VMR" : `D${index + 1}`;
    }
    function elevatorPosition(location) {
        if (!location?.startsWith("elevator-position-"))
            return null;
        const value = Number(location.slice("elevator-position-".length));
        return Number.isFinite(value) ? value : null;
    }
    function inferDeckFromRotateGroup(decks, group) {
        if (!group)
            return undefined;
        const match = group.match(/D(\d+)/i);
        if (!match?.[1])
            return undefined;
        const index = Number(match[1]) - 1;
        return decks[index];
    }
    function reserveDestinationForOperation(snapshot, operation) {
        if (!isCellReservationPurpose(operation.type) || !operation.vehicleId || !operation.to?.startsWith("f")) {
            return;
        }
        const reservation = {
            cellId: operation.to,
            vehicleId: operation.vehicleId,
            operationId: operation.id,
            reservedAt: operation.startedAt,
            expectedOccupiedAt: operation.completesAt,
            purpose: operation.type,
        };
        const existing = snapshot.occupancy.reservations ?? [];
        snapshot.occupancy.reservations = [
            ...existing.filter((candidate) => candidate.cellId !== reservation.cellId &&
                candidate.operationId !== reservation.operationId),
            reservation,
        ];
    }
    function releaseReservationForCompletedOperation(snapshot, operation) {
        if (!isCellReservationPurpose(operation.type))
            return;
        const to = stringDetail(operation.detail, "to");
        snapshot.occupancy.reservations = (snapshot.occupancy.reservations ?? []).filter((reservation) => reservation.cellId !== to &&
            (!operation.vehicleId || reservation.vehicleId !== operation.vehicleId));
    }
    function isCellReservationPurpose(type) {
        return (type === "ParkInbound" ||
            type === "RelocateBlocker" ||
            type === "IdleUnblock");
    }
    function removeOccupiedVehicle(snapshot, vehicleId) {
        snapshot.occupancy.occupied = snapshot.occupancy.occupied.filter((cell) => cell.vehicleId !== vehicleId);
    }
    function upsertOccupied(snapshot, cell) {
        snapshot.occupancy.occupied = snapshot.occupancy.occupied.filter((candidate) => candidate.vehicleId !== cell.vehicleId && candidate.cellId !== cell.cellId);
        snapshot.occupancy.reservations = (snapshot.occupancy.reservations ?? []).filter((reservation) => reservation.vehicleId !== cell.vehicleId && reservation.cellId !== cell.cellId);
        snapshot.occupancy.occupied.push(cell);
    }
    function clearDeck(deck) {
        delete deck.vehicleId;
        delete deck.vehicleRole;
    }
    function recordTime(record) {
        return record.kind === "second" ? record.record.time : record.t;
    }
    function stringDetail(detail, key) {
        const value = detail[key];
        return typeof value === "string" ? value : undefined;
    }
    function cloneValue(value) {
        if (typeof globalThis.structuredClone === "function") {
            return globalThis.structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    }
    function requiredElement(root, selector, constructor) {
        const element = root.querySelector(selector);
        if (!(element instanceof constructor)) {
            throw new Error(`Missing required visualizer element: ${selector}`);
        }
        return element;
    }
    function formatDuration(totalSeconds) {
        const seconds = Math.max(0, Math.round(totalSeconds));
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remaining = seconds % 60;
        const clock = [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
        return days > 0 ? `day ${days + 1}, ${clock}` : clock;
    }
    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }
    function escapeHtml(value) {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
});
