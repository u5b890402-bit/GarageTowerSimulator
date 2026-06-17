define("domain/types", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
});
define("config/validate-config", ["require", "exports"], function (require, exports) {
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
                averageInboundWaitSeconds: average(day.inboundWaitSeconds),
                averageOutboundWaitSeconds: average(day.outboundWaitSeconds),
                averageInboundWaitSecondsDuringMorningPeak: average(day.morningPeakInboundWaitSeconds),
                averageOutboundWaitSecondsDuringEveningPeak: average(day.eveningPeakOutboundWaitSeconds),
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
        "averageInboundWaitSeconds",
        "averageOutboundWaitSeconds",
        "averageInboundWaitSecondsDuringMorningPeak",
        "averageOutboundWaitSecondsDuringEveningPeak",
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
            averageInboundWaitSeconds: 0,
            averageOutboundWaitSeconds: 0,
            averageInboundWaitSecondsDuringMorningPeak: 0,
            averageOutboundWaitSecondsDuringEveningPeak: 0,
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
                totalParkingCells: record.afterSnapshot.occupancy.totalParkingCells,
                occupancyPercent: record.afterSnapshot.occupancy.occupancyPercent,
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
define("garage/grid-layout", ["require", "exports"], function (require, exports) {
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
        classifyBlockage(cellId, _occupancy) {
            const { row, column } = this.getCellGeometry(cellId);
            const corner = (row === 1 || row === this.config.rows) && (column === 1 || column === this.config.columns);
            if (!corner)
                return "none";
            return this.config.rows >= 5 && this.config.columns >= 5 ? "deep" : "shallow";
        }
        estimateAccessCost(cellId, occupancy) {
            const geometry = this.getCellGeometry(cellId);
            const blockage = this.classifyBlockage(cellId, occupancy);
            const blockagePenalty = blockage === "deep" ? 120 : blockage === "shallow" ? 60 : 0;
            const manhattanFromElevator = Math.abs(geometry.row - Math.ceil(this.config.rows / 2)) +
                Math.abs(geometry.column - Math.ceil(this.config.columns / 2));
            return geometry.floor * 10 + manhattanFromElevator * 5 + blockagePenalty;
        }
    }
    exports.GridGarageLayout = GridGarageLayout;
});
define("garage/simple-garage", ["require", "exports", "garage/grid-layout"], function (require, exports, grid_layout_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SimpleGarageTowerSystem = void 0;
    class SimpleGarageTowerSystem {
        constructor(strategies) {
            this.strategies = strategies;
            this.inboundQueue = [];
            this.outboundQueue = [];
            this.parked = new Map();
            this.requestedOutbound = new Set();
            this.preparationPositions = [];
            this.activeOperation = null;
            this.operationDuration = 0;
            this.vmrs = [];
            this.counters = {
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
        initialize(config) {
            this.config = config;
            this.layout = new grid_layout_js_1.GridGarageLayout(config.layout);
            this.preparationPositions = [
                ...Array.from({ length: config.preparationPositions.inboundCount }, (_, index) => ({
                    id: `IPP${index + 1}`,
                    direction: "inbound",
                })),
                ...Array.from({ length: config.preparationPositions.outboundCount }, (_, index) => ({
                    id: `OPP${index + 1}`,
                    direction: "outbound",
                })),
            ];
            this.vmrs = Array.from({ length: config.elevator.deckCount }, (_, index) => ({
                id: `VMR${index + 1}`,
                deckId: `D${index + 1}`,
                status: "Idle",
                distanceMovedMeters: 0,
            }));
        }
        submitEvents(context) {
            const results = [];
            for (const event of context.events) {
                if (event.type === "InboundArrival") {
                    results.push(this.submitInbound(event.id, event.vehicleId, context));
                }
                else {
                    results.push(this.submitOutbound(event.id, event.vehicleId, context.time));
                }
            }
            this.updateMaxQueues();
            return results;
        }
        updateOneSecond(context) {
            this.clearReadyOutboundPreparationPositions(context.time);
            this.fillInboundPreparationPositions(context.time);
            const completedOperations = [];
            if (this.activeOperation && context.time >= this.activeOperation.completesAt) {
                completedOperations.push(this.completeActiveOperation(context.time));
            }
            const startedOperations = [];
            if (!this.activeOperation) {
                const nextOperation = this.startNextOperation(context);
                if (nextOperation) {
                    startedOperations.push(nextOperation);
                }
            }
            this.updateMaxQueues();
            return { completedOperations, startedOperations };
        }
        getSnapshot() {
            const occupancy = this.getOccupancy();
            const elevator = {
                status: this.activeOperation ? "Busy" : "IdleAtHome",
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
        isIdle() {
            return !this.activeOperation && this.inboundQueue.length === 0 && this.outboundQueue.length === 0;
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
        startNextOperation(context) {
            const readyInbound = this.preparationPositions.find((position) => position.direction === "inbound" && position.occupiedBy && (position.readyAt ?? 0) <= context.time);
            if (readyInbound?.occupiedBy) {
                return this.startParkingOperation(readyInbound, context);
            }
            if (this.outboundQueue.length > 0) {
                return this.startRetrievalOperation(context);
            }
            return null;
        }
        startParkingOperation(position, context) {
            const vehicleId = position.occupiedBy;
            if (!vehicleId)
                return null;
            const cellId = this.strategies.placementStrategy.chooseCell(vehicleId, { time: context.time, layout: this.layout, occupancy: this.getOccupancy() }, context.rng);
            if (!cellId)
                return null;
            delete position.occupiedBy;
            delete position.readyAt;
            const duration = this.estimateParkingSeconds(cellId);
            const operation = {
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
        startRetrievalOperation(context) {
            const next = this.outboundQueue.shift();
            if (!next)
                return null;
            const parked = this.parked.get(next.vehicleId);
            if (!parked) {
                this.requestedOutbound.delete(next.vehicleId);
                return null;
            }
            const duration = this.estimateRetrievalSeconds(parked.cellId);
            const operation = {
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
        completeActiveOperation(time) {
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
        activateOperation(operation, duration, cellId) {
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
                ...this.vmrs[0],
                distanceMovedMeters: (this.vmrs[0]?.distanceMovedMeters ?? 0) + vmrDistance,
            };
        }
        fillInboundPreparationPositions(time) {
            for (const position of this.preparationPositions) {
                if (this.inboundQueue.length === 0)
                    return;
                if (position.direction !== "inbound" || position.occupiedBy)
                    continue;
                const next = this.inboundQueue.shift();
                if (!next)
                    return;
                position.occupiedBy = next.vehicleId;
                position.readyAt = time + this.preparationClearSeconds();
            }
        }
        placeVehicleOnOutboundPreparationPosition(vehicleId, time) {
            const openPosition = this.preparationPositions.find((position) => position.direction === "outbound" && !position.occupiedBy);
            if (!openPosition) {
                return;
            }
            openPosition.occupiedBy = vehicleId;
            openPosition.readyAt = time + this.preparationClearSeconds();
        }
        clearReadyOutboundPreparationPositions(time) {
            for (const position of this.preparationPositions) {
                if (position.direction === "outbound" && position.occupiedBy && (position.readyAt ?? 0) <= time) {
                    delete position.occupiedBy;
                    delete position.readyAt;
                }
            }
        }
        shouldBalk(queueLengthExcludingPps, context) {
            const policy = context.rng ? context : undefined;
            if (!policy)
                return false;
            const balking = {
                startsAtQueueLength: 13,
                initialProbability: 0.5,
                probabilityStep: 0.1,
                certainAtQueueLength: 18,
            };
            const queuePosition = queueLengthExcludingPps + 1;
            if (queuePosition < balking.startsAtQueueLength)
                return false;
            if (queuePosition >= balking.certainAtQueueLength)
                return true;
            const probability = balking.initialProbability +
                (queuePosition - balking.startsAtQueueLength) * balking.probabilityStep;
            return context.rng.nextFloat() < probability;
        }
        preparationClearSeconds() {
            return this.config.preparationPositions.kind === "sequential"
                ? this.config.preparationPositions.sequentialClearSeconds
                : this.config.preparationPositions.parallelClearSeconds;
        }
        estimateParkingSeconds(cellId) {
            const floor = this.layout.getCellFloor(cellId);
            const verticalMeters = Math.max(0, floor - 1) * this.config.elevator.floorHeightMeters;
            const verticalSeconds = verticalMeters / this.config.elevator.verticalSpeedMetersPerSecond;
            const accessSeconds = this.layout.estimateAccessCost(cellId, this.getOccupancy());
            return Math.ceil(verticalSeconds * 2 + accessSeconds + this.config.vmr.gripReleaseSeconds * 2);
        }
        estimateRetrievalSeconds(cellId) {
            return this.estimateParkingSeconds(cellId);
        }
        getOccupancy() {
            const occupied = [...this.parked.values()].map((record) => ({
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
        occupiedInboundPreparationPositions() {
            return this.preparationPositions.filter((position) => position.direction === "inbound" && position.occupiedBy);
        }
        updateMaxQueues() {
            this.counters.maxInboundQueueLength = Math.max(this.counters.maxInboundQueueLength, this.inboundQueue.length);
            this.counters.maxOutboundQueueLength = Math.max(this.counters.maxOutboundQueueLength, this.outboundQueue.length);
        }
        estimateOperationFloor(operation) {
            const cell = operation.type === "ParkInbound" ? operation.to : operation.from;
            if (!cell || !cell.startsWith("f"))
                return 1;
            return this.layout.getCellFloor(cell);
        }
    }
    exports.SimpleGarageTowerSystem = SimpleGarageTowerSystem;
});
define("garage/strategies", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopUnblockingStrategy = exports.FixedPreparationPositionPolicy = exports.NoopElevatorTripPlanner = exports.SimpleRetrievalStrategy = exports.LowestCostPlacementStrategy = void 0;
    exports.createBaselineStrategies = createBaselineStrategies;
    class LowestCostPlacementStrategy {
        rankCandidateCells(context) {
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
        chooseCell(_vehicleId, context, _rng) {
            return this.rankCandidateCells(context)[0]?.cellId ?? null;
        }
    }
    exports.LowestCostPlacementStrategy = LowestCostPlacementStrategy;
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
    class NoopElevatorTripPlanner {
        planNextTrip() {
            return null;
        }
    }
    exports.NoopElevatorTripPlanner = NoopElevatorTripPlanner;
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
    function createBaselineStrategies() {
        return {
            placementStrategy: new LowestCostPlacementStrategy(),
            retrievalStrategy: new SimpleRetrievalStrategy(),
            tripPlanner: new NoopElevatorTripPlanner(),
            ppAssignmentPolicy: new FixedPreparationPositionPolicy(),
            unblockingStrategy: new NoopUnblockingStrategy(),
        };
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
            this.scheduledOutbounds = [];
        }
        initialize(params, seed) {
            this.config = params;
            this.rng = new random_js_1.SeededRandomSource(seed);
        }
        generateEventsAt(time, garageState) {
            const events = [];
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
        inboundLambdaPerSecond(time) {
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
define("simulation/session-factory", ["require", "exports", "garage/simple-garage", "garage/strategies", "simulation/demand-generator", "simulation/random"], function (require, exports, simple_garage_js_1, strategies_js_1, demand_generator_js_1, random_js_2) {
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
        const strategies = (0, strategies_js_1.createBaselineStrategies)();
        const garage = new SimpleGarageFactory().createGarage(config.garage, strategies);
        const demandGenerator = new demand_generator_js_1.SeededDemandGenerator();
        demandGenerator.initialize(config.demand, config.simulation.seed);
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
            const record = {
                sessionId: session.id,
                time,
                generatedEvents,
                intakeResults,
                tickResult,
                beforeSnapshot,
                afterSnapshot,
                telemetry: telemetry.flush(),
            };
            await session.recorder.recordSecond(record);
            return { record };
        }
    }
    exports.SimulationEngine = SimulationEngine;
});
define("browser/app", ["require", "exports", "config/validate-config", "report/report-builder", "simulation/in-memory-recorder", "simulation/session-factory", "simulation/simulation-engine"], function (require, exports, validate_config_js_1, report_builder_js_1, in_memory_recorder_js_1, session_factory_js_1, simulation_engine_js_1) {
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
        },
    };
    let latestRun = null;
    function startApp() {
        const configInput = getElement("config-input");
        const runButton = getElement("run-button");
        const loadExampleButton = getElement("load-example-button");
        const rawDownloadButton = getElement("download-raw-button");
        const reportDownloadButton = getElement("download-report-button");
        configInput.value = JSON.stringify(exampleConfig, null, 2);
        loadExampleButton.addEventListener("click", () => {
            configInput.value = JSON.stringify(exampleConfig, null, 2);
            setStatus("Example configuration loaded.");
        });
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
        setText("metric-inbound-wait", `${Math.round(summary.averageInboundWaitSeconds)}s`);
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
        for (const id of ["run-button", "load-example-button", "config-input"]) {
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
define("report/jsonl-raw-simulation-reader", ["require", "exports", "node:fs/promises"], function (require, exports, promises_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonlRawSimulationReader = void 0;
    class JsonlRawSimulationReader {
        constructor(rawOutput) {
            this.rawOutput = rawOutput;
            this.lines = null;
        }
        async readMetadata() {
            const lines = await this.readLines();
            const metadata = lines.find((line) => line.kind === "metadata");
            if (!metadata) {
                throw new Error(`Raw output does not contain metadata: ${this.rawOutput.path}`);
            }
            return metadata;
        }
        async readRecords() {
            const lines = await this.readLines();
            return lines.filter((line) => line.kind !== "metadata");
        }
        async readLines() {
            if (this.lines)
                return this.lines;
            const text = await (0, promises_1.readFile)(this.rawOutput.path, "utf8");
            this.lines = text
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line));
            return this.lines;
        }
    }
    exports.JsonlRawSimulationReader = JsonlRawSimulationReader;
});
define("report/json-report-generator", ["require", "exports", "node:fs/promises", "report/jsonl-raw-simulation-reader", "report/report-builder"], function (require, exports, promises_2, jsonl_raw_simulation_reader_js_1, report_builder_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonReportGenerator = void 0;
    class JsonReportGenerator {
        async generate(rawOutput, _config) {
            const reader = new jsonl_raw_simulation_reader_js_1.JsonlRawSimulationReader(rawOutput);
            const metadata = await reader.readMetadata();
            const records = await reader.readRecords();
            return (0, report_builder_js_2.buildReportFromRecords)(metadata, records, rawOutput);
        }
        async write(report, destination) {
            await (0, promises_2.writeFile)(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        }
    }
    exports.JsonReportGenerator = JsonReportGenerator;
});
define("run-report", ["require", "exports", "report/json-report-generator"], function (require, exports, json_report_generator_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    async function main() {
        const rawOutputPath = process.argv[2] ?? "output/example-3x3-baseline.jsonl";
        const destinationPath = process.argv[3] ?? "output/example-3x3-report.json";
        const generator = new json_report_generator_js_1.JsonReportGenerator();
        const report = await generator.generate({ path: rawOutputPath }, { destinationPath });
        await generator.write(report, destinationPath);
        console.log(`Report complete: ${destinationPath}`);
        console.log(`Daily rows: ${report.daily.length}`);
        console.log(`Successful activities: ${report.thirtyDaySummary.sum.successfulActivities}`);
        console.log(`Revenue: ${report.thirtyDaySummary.sum.totalRevenue}`);
    }
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
});
define("config/json-config-loader", ["require", "exports", "node:fs/promises", "config/validate-config"], function (require, exports, promises_3, validate_config_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonConfigLoader = void 0;
    class JsonConfigLoader {
        async load(path) {
            const text = await (0, promises_3.readFile)(path, "utf8");
            const config = JSON.parse(text);
            const validation = this.validate(config);
            if (!validation.valid) {
                throw new Error(`Invalid simulation config:\n${validation.errors.join("\n")}`);
            }
            return config;
        }
        validate(config) {
            return (0, validate_config_js_2.validateSimulationConfig)(config);
        }
    }
    exports.JsonConfigLoader = JsonConfigLoader;
});
define("simulation/jsonl-recorder", ["require", "exports", "node:fs/promises", "node:path", "simulation/compact-records"], function (require, exports, promises_4, node_path_1, compact_records_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonlSimulationStateRecorder = void 0;
    class JsonlSimulationStateRecorder {
        constructor() {
            this.outputPath = "";
            this.lastStateKey = "";
        }
        async open(session) {
            await (0, promises_4.mkdir)(session.config.simulation.outputDir, { recursive: true });
            this.outputPath = (0, node_path_1.join)(session.config.simulation.outputDir, session.config.simulation.rawOutputFile);
            await (0, promises_4.writeFile)(this.outputPath, `${JSON.stringify({
                kind: "metadata",
                sessionId: session.id,
                config: session.config,
                recording: {
                    schema: "compact-jsonl-v1",
                    checkpointIntervalSeconds: compact_records_js_2.defaultCheckpointIntervalSeconds,
                },
            })}\n`, "utf8");
        }
        async recordSecond(record) {
            const result = (0, compact_records_js_2.buildCompactRecords)(record, this.lastStateKey, compact_records_js_2.defaultCheckpointIntervalSeconds);
            this.lastStateKey = result.stateKey;
            const lines = result.records.map((compactRecord) => JSON.stringify(compactRecord));
            if (lines.length > 0) {
                await (0, promises_4.appendFile)(this.outputPath, `${lines.join("\n")}\n`, "utf8");
            }
        }
        async close() {
            return;
        }
        getOutputRef() {
            return { path: this.outputPath };
        }
    }
    exports.JsonlSimulationStateRecorder = JsonlSimulationStateRecorder;
});
define("simulation/default-runner", ["require", "exports", "config/json-config-loader", "simulation/jsonl-recorder", "simulation/session-factory", "simulation/simulation-engine"], function (require, exports, json_config_loader_js_1, jsonl_recorder_js_1, session_factory_js_2, simulation_engine_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DefaultSimulationRunner = void 0;
    class DefaultSimulationRunner extends simulation_engine_js_2.SimulationEngine {
        constructor() {
            super(...arguments);
            this.configLoader = new json_config_loader_js_1.JsonConfigLoader();
        }
        async initialize(configPath) {
            const config = await this.configLoader.load(configPath);
            return (0, session_factory_js_2.createSimulationSession)(config, new jsonl_recorder_js_1.JsonlSimulationStateRecorder());
        }
    }
    exports.DefaultSimulationRunner = DefaultSimulationRunner;
});
define("run-simulation", ["require", "exports", "node:path", "simulation/default-runner"], function (require, exports, node_path_2, default_runner_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    async function main() {
        const configPath = process.argv[2] ?? "config/example-3x3.json";
        const runner = new default_runner_js_1.DefaultSimulationRunner();
        const session = await runner.initialize((0, node_path_2.resolve)(configPath));
        const result = await runner.run(session);
        console.log(`Simulation complete: ${result.sessionId}`);
        console.log(`Raw output: ${result.rawOutput.path}`);
        console.log(`Final occupancy: ${result.finalSnapshot.occupancy.occupiedCount}/${result.finalSnapshot.occupancy.totalParkingCells}`);
        console.log(`Inbound completed: ${result.finalSnapshot.counters.inboundCompleted}`);
        console.log(`Outbound completed: ${result.finalSnapshot.counters.outboundCompleted}`);
    }
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
});
