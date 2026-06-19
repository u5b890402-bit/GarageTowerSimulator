import type {
  GarageConfig,
  GarageTickContext,
  GarageTowerSystem,
  SimulationConfig,
  SimulationEvent,
  SimulationRuntimeConfig,
} from "./domain/types.js";
import { SimpleGarageTowerSystem } from "./garage/simple-garage.js";
import { GridGarageLayout } from "./garage/grid-layout.js";
import { createGarageStrategies } from "./garage/strategy-registry.js";
import { GridVmrPathPlanner } from "./garage/vmr-path-planner.js";
import { SeededRandomSource } from "./simulation/random.js";
import { BufferedGarageTelemetrySink } from "./simulation/telemetry.js";
import { DailyMetricsAggregator } from "./report/metrics-aggregator.js";

const garageConfig: GarageConfig = {
  layout: {
    rows: 3,
    columns: 3,
    floors: 1,
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
    parallelClearSeconds: 10,
    sequentialClearSeconds: 15,
    doorSeconds: 2,
  },
  strategies: {
    placement: { type: "first-available" },
    retrieval: { type: "simple-retrieval" },
    tripPlanner: { type: "baseline-physical" },
    preparationPositions: { type: "fixed-assignment" },
    unblocking: { type: "idle-after-10-minutes" },
  },
};

const runtime: SimulationRuntimeConfig = {
  sessionName: "physical-test",
  startTime: "2026-06-01T00:00:00-07:00",
  durationSeconds: 10_000,
  tickSeconds: 1,
  timezone: "America/Los_Angeles",
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
};

const garage = new SimpleGarageTowerSystem(createGarageStrategies(garageConfig.strategies));
const layout = new GridGarageLayout(garageConfig.layout);
const pathPlanner = new GridVmrPathPlanner(garageConfig, layout);
garage.initialize(garageConfig);
const intakeRng = new SeededRandomSource(10);
const garageRng = new SeededRandomSource(20);
let time = 0;
let sawConcurrentVmrs = false;
let sawStreetRotation = false;
let sawElevatorMovement = false;
let sawExplicitCellPath = false;

verifyPathPlanner();
verifyInboundDriverWaitingMetric();

submit(
  Array.from({ length: 5 }, (_, index) => ({
    id: `in-${index + 1}`,
    time,
    type: "InboundArrival" as const,
    vehicleId: `V${index + 1}`,
  })),
);

runUntil(() => garage.getSnapshot().counters.inboundCompleted === 5, 5_000);

const beforeOutbound = garage.getSnapshot();
assert(beforeOutbound.occupancy.occupiedCount === 5, "Five vehicles should be parked.");
assert(
  beforeOutbound.occupancy.occupied.some((cell) => cell.vehicleId === "V1"),
  "V1 should be parked before its outbound request.",
);

submit([
  {
    id: "out-1",
    time,
    type: "OutboundRequest",
    vehicleId: "V1",
  },
]);

runUntil(() => garage.getSnapshot().counters.outboundCompleted === 1, 5_000);
runUntil(() => garage.isIdle(), 2_000);

const finalSnapshot = garage.getSnapshot();
assert(sawConcurrentVmrs, "Two VMRs should work concurrently during a multi-deck trip.");
assert(sawStreetRotation, "Decks should rotate to street orientation for PP transfers.");
assert(sawElevatorMovement, "The elevator should execute timed movement operations.");
assert(sawExplicitCellPath, "Cell transfers should expose explicit VMR paths.");
assert(
  finalSnapshot.counters.inducedInboundVehicles >= 1,
  "Retrieving blocked V1 should buffer at least one blocker.",
);
assert(
  !finalSnapshot.occupancy.occupied.some((cell) => cell.vehicleId === "V1"),
  "Outbound V1 should leave storage.",
);
assert(
  finalSnapshot.occupancy.occupiedCount === 4,
  "Blocker vehicles must be restored rather than disappearing.",
);
assertNoEmptyBlockedCells(finalSnapshot.occupancy);
assert(finalSnapshot.elevator.currentFloor === 1, "Elevator should return home.");
assert(
  finalSnapshot.elevator.decks?.every(
    (deck) => !deck.vehicleId && deck.orientation === "garage",
  ) === true,
  "All decks should be empty and garage-oriented at home.",
);
assert(
  finalSnapshot.vmrs.every(
    (vmr) => vmr.status === "Idle" && vmr.deckId === vmr.homeDeckId,
  ),
  "All VMRs should return idle to their home decks.",
);

submit(
  Array.from({ length: 4 }, (_, index) => ({
    id: `fill-${index + 6}`,
    time,
    type: "InboundArrival" as const,
    vehicleId: `V${index + 6}`,
  })),
);
runUntil(() => garage.getSnapshot().counters.inboundCompleted === 9, 5_000);
assert(
  garage.getSnapshot().occupancy.occupiedCount === 8,
  "Garage should reach full capacity without overcommitting cells.",
);

submit([
  {
    id: "out-2",
    time,
    type: "OutboundRequest",
    vehicleId: "V2",
  },
]);
runUntil(() => garage.getSnapshot().counters.outboundCompleted === 2, 5_000);
runUntil(() => garage.isIdle(), 2_000);

const afterFullGarageOutbound = garage.getSnapshot();
assert(
  afterFullGarageOutbound.occupancy.occupiedCount === 7,
  "A full garage must retrieve an outbound vehicle and free a cell.",
);
assertNoEmptyBlockedCells(afterFullGarageOutbound.occupancy);

runUntil(
  () => garage.getSnapshot().counters.idleUnblockingActions >= 1,
  2_000,
);
runUntil(() => garage.isIdle(), 2_000);
const afterIdleUnblocking = garage.getSnapshot();
assert(
  afterIdleUnblocking.counters.idleUnblockedVehicles >= 1,
  "Idle maintenance should relocate a blocker after ten quiet minutes.",
);
assertNoEmptyBlockedCells(afterIdleUnblocking.occupancy);

console.log(
  JSON.stringify({
    inboundCompleted: afterIdleUnblocking.counters.inboundCompleted,
    outboundCompleted: afterIdleUnblocking.counters.outboundCompleted,
    inducedInboundVehicles: afterIdleUnblocking.counters.inducedInboundVehicles,
    idleUnblockedVehicles: afterIdleUnblocking.counters.idleUnblockedVehicles,
    elevatorFloorsPassed: afterIdleUnblocking.counters.elevatorFloorsPassed,
    vmrDistanceMeters: afterIdleUnblocking.counters.vmrDistanceMeters,
  }),
);

function submit(events: SimulationEvent[]): void {
  const results = garage.submitEvents({ time, events, rng: intakeRng });
  const rejected = results.filter((result) => !result.accepted);
  assert(rejected.length === 0, `Unexpected rejected events: ${JSON.stringify(rejected)}`);
}

function runUntil(predicate: () => boolean, maximumTicks: number): void {
  for (let count = 0; count < maximumTicks; count += 1) {
    tick();
    if (predicate()) return;
  }
  throw new Error(`Condition not reached after ${maximumTicks} ticks at t=${time}.`);
}

function tick(): void {
  const telemetry = new BufferedGarageTelemetrySink();
  const context: GarageTickContext = {
    time,
    deltaSeconds: 1,
    simulation: runtime,
    rng: garageRng,
    telemetry,
  };
  garage.updateOneSecond(context);
  const snapshot = garage.getSnapshot();
  const busyVmrs = snapshot.vmrs.filter((vmr) => vmr.status === "Busy").length;
  sawConcurrentVmrs ||= busyVmrs >= 2;
  sawStreetRotation ||= snapshot.elevator.decks?.some(
    (deck) => deck.orientation === "street",
  ) ?? false;
  sawElevatorMovement ||= snapshot.activeOperations.some(
    (operation) => operation.type === "MoveElevator",
  );
  sawExplicitCellPath ||= snapshot.activeOperations.some(
    (operation) => (operation.path?.cells.length ?? 0) > 0,
  );
  time += 1;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoEmptyBlockedCells(
  occupancy: ReturnType<GarageTowerSystem["getSnapshot"]>["occupancy"],
): void {
  const occupied = new Set(occupancy.occupied.map((cell) => cell.cellId));
  const blockedEmpty = layout
    .getParkingCells()
    .filter((cellId) => !occupied.has(cellId))
    .filter((cellId) => layout.getBlockingCells(cellId, occupancy).length > 0);
  assert(
    blockedEmpty.length === 0,
    `Empty parking cells must remain accessible: ${blockedEmpty.join(", ")}`,
  );
}

function verifyPathPlanner(): void {
  const blockedBothWays = occupancy([
    { cellId: "f1c2", vehicleId: "B1" },
    { cellId: "f1c4", vehicleId: "B2" },
    { cellId: "f1c1", vehicleId: "TARGET" },
  ]);
  assert(
    pathPlanner.findClearPathToElevator("f1c1", blockedBothWays) === null,
    "A VMR must not pass through occupied c2 or c4 to reach c1.",
  );
  const accessPlan = pathPlanner.findAccessPlan("f1c1", blockedBothWays);
  assert(
    accessPlan?.blockerCells.length === 1,
    "Access planning should choose one route and identify its blocker.",
  );

  const oneRouteOpen = occupancy([
    { cellId: "f1c2", vehicleId: "B1" },
    { cellId: "f1c1", vehicleId: "TARGET" },
  ]);
  const clearPath = pathPlanner.findClearPathToElevator("f1c1", oneRouteOpen);
  assert(clearPath !== null, "The VMR should route around c2 through empty c4.");
  assert(
    !clearPath.cells.includes("f1c2"),
    "The selected route must not include the occupied blocker.",
  );

  const empty = occupancy([]);
  const left = pathPlanner.findClearPathFromElevator("f1c1", empty);
  const right = pathPlanner.findClearPathFromElevator("f1c3", empty);
  assert(left && right, "Expected valid paths to both top corners.");
  assert(
    pathPlanner.pathsConflict(left, right),
    "Same-floor routes sharing the elevator area must conflict.",
  );
}

function verifyInboundDriverWaitingMetric(): void {
  const config: SimulationConfig = {
    simulation: {
      ...runtime,
      seed: 1,
      outputDir: "output",
      rawOutputFile: "test.jsonl",
    },
    demand: {
      averageInboundPerDay: 250,
      weekendMultiplier: 0.5,
      peakHour: 9,
      peakWindowHours: 2,
      peakShare: 0.5,
      parkingDuration: {
        minHours: 2,
        maxHours: 12,
        modeHours: 8,
      },
    },
    garage: garageConfig,
  };
  const aggregator = new DailyMetricsAggregator(config);
  aggregator.consumeRecord({
    kind: "events",
    t: 10,
    generated: [
      {
        id: "metric-in",
        time: 10,
        type: "InboundArrival",
        vehicleId: "METRIC-V1",
      },
    ],
    intake: [
      {
        eventId: "metric-in",
        vehicleId: "METRIC-V1",
        accepted: true,
        outcome: "QueuedInbound",
        queuePosition: 1,
      },
    ],
  });
  aggregator.consumeRecord({
    kind: "operations",
    t: 25,
    completed: [
      {
        type: "EnterInboundPreparationPosition",
        vehicleId: "METRIC-V1",
        durationSeconds: 0,
        detail: { preparationPositionId: "IPP1" },
      },
    ],
  });
  aggregator.consumeRecord({
    kind: "operations",
    t: 100,
    completed: [
      {
        type: "ParkInbound",
        vehicleId: "METRIC-V1",
        durationSeconds: 75,
        detail: {},
      },
    ],
  });

  const day = aggregator.finalize()[0];
  assert(day, "Expected a daily report row.");
  assert(
    day.averageInboundDriverWaitingSeconds === 15,
    "Inbound driver wait should end when the vehicle reaches the inbound PP.",
  );
  assert(
    day.averageInboundWaitSeconds === 90,
    "End-to-end inbound processing time should remain available separately.",
  );
}

function occupancy(
  cells: Array<{ cellId: string; vehicleId: string }>,
): ReturnType<GarageTowerSystem["getSnapshot"]>["occupancy"] {
  return {
    occupied: cells.map((cell) => ({
      cellId: cell.cellId,
      vehicleId: cell.vehicleId,
      parkedAt: 0,
    })),
    occupiedCount: cells.length,
    totalParkingCells: 8,
    occupancyPercent: cells.length / 8,
  };
}
