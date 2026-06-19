export type SimTime = number;
export type DurationSeconds = number;
export type VehicleId = string;
export type CellId = string;
export type LocationId = string;

export type SimulationEventType = "InboundArrival" | "OutboundRequest";
export type PreparationPositionKind = "parallel" | "sequential";
export type PreparationPositionMode = "designated" | "dynamic";
export type BlockageType = "none" | "shallow" | "deep";
export type GarageOperationType =
  | "EnterInboundPreparationPosition"
  | "ParkInbound"
  | "RetrieveOutbound"
  | "LoadInbound"
  | "LoadOutbound"
  | "UnloadOutbound"
  | "MoveElevator"
  | "RotateDeck"
  | "MoveBlocker"
  | "RelocateBlocker"
  | "OperateDoor"
  | "IdleUnblock";

export interface RandomSource {
  nextFloat(): number;
  nextInt(minInclusive: number, maxInclusive: number): number;
  choose<T>(items: readonly T[]): T;
}

export interface SimulationConfig {
  simulation: SimulationRuntimeConfig & {
    seed: number;
    outputDir: string;
    rawOutputFile: string;
  };
  demand: DemandGenerationConfig;
  garage: GarageConfig;
}

export interface SimulationRuntimeConfig {
  sessionName: string;
  startTime: string;
  durationSeconds: number;
  tickSeconds: number;
  timezone: string;
  revenuePolicy: RevenuePolicyConfig;
  balkingPolicy: BalkingPolicyConfig;
}

export interface DemandGenerationConfig {
  averageInboundPerDay: number;
  weekendMultiplier: number;
  peakHour: number;
  peakWindowHours: number;
  peakShare: number;
  parkingDuration: {
    minHours: number;
    maxHours: number;
    modeHours: number;
  };
}

export interface RevenuePolicyConfig {
  chargePerBillingBlock: number;
  billingBlockMinutes: number;
}

export interface BalkingPolicyConfig {
  startsAtQueueLength: number;
  initialProbability: number;
  probabilityStep: number;
  certainAtQueueLength: number;
}

export interface GarageConfig {
  layout: LayoutConfig;
  elevator: ElevatorConfig;
  vmr: VmrConfig;
  preparationPositions: PreparationPositionConfig;
  strategies?: GarageStrategyConfig;
}

export interface StrategySelection {
  type: string;
  options?: Record<string, unknown>;
}

export interface GarageStrategyConfig {
  placement: StrategySelection;
  retrieval: StrategySelection;
  tripPlanner: StrategySelection;
  preparationPositions: StrategySelection;
  unblocking: StrategySelection;
}

export type StrategyCategory =
  | "placement"
  | "retrieval"
  | "tripPlanner"
  | "preparationPositions"
  | "unblocking";

export interface StrategyDescriptor {
  category: StrategyCategory;
  type: string;
  label: string;
  description: string;
}

export interface LayoutConfig {
  rows: number;
  columns: number;
  floors: number;
  elevatorCell: number;
  unavailableCells: number[];
  streetFacing: "longSide" | "shortSide";
}

export interface ElevatorConfig {
  deckCount: number;
  verticalSpeedMetersPerSecond: number;
  floorHeightMeters: number;
  deckRotationSeconds: number;
}

export interface VmrConfig {
  speedMetersPerSecond: number;
  gripReleaseSeconds: number;
}

export interface PreparationPositionConfig {
  inboundCount: number;
  outboundCount: number;
  kind: PreparationPositionKind;
  mode: PreparationPositionMode;
  parallelClearSeconds: number;
  sequentialClearSeconds: number;
  doorSeconds: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ConfigLoader {
  load(path: string): Promise<SimulationConfig>;
  validate(config: SimulationConfig): ValidationResult;
}

export interface GarageFactory {
  createGarage(config: GarageConfig, strategies: GarageStrategySet): GarageTowerSystem;
}

export interface GarageStrategySet {
  placementStrategy: PlacementStrategy;
  retrievalStrategy: RetrievalStrategy;
  tripPlanner: ElevatorTripPlanner;
  ppAssignmentPolicy: PreparationPositionPolicy;
  unblockingStrategy: UnblockingStrategy;
}

export interface GarageTowerSystem {
  initialize(config: GarageConfig): void;
  submitEvents(context: GarageEventIntakeContext): EventAcceptanceResult[];
  updateOneSecond(context: GarageTickContext): GarageTickResult;
  getSnapshot(): GarageStateSnapshot;
  isIdle(): boolean;
  getCapacity(): CapacityInfo;
}

export interface GarageEventIntakeContext {
  time: SimTime;
  events: SimulationEvent[];
  rng: RandomSource;
}

export interface GarageTickContext {
  time: SimTime;
  deltaSeconds: number;
  simulation: SimulationRuntimeConfig;
  rng: RandomSource;
  telemetry: GarageTelemetrySink;
}

export interface GarageTelemetrySink {
  recordOperation(operation: GarageOperationRecord): void;
  recordMetric(metric: GarageMetricRecord): void;
  recordWarning(warning: GarageWarningRecord): void;
}

export interface GarageOperationRecord {
  time: SimTime;
  type: string;
  vehicleId?: VehicleId;
  detail: Record<string, unknown>;
}

export interface GarageMetricRecord {
  time: SimTime;
  name: string;
  value: number;
  tags?: Record<string, string>;
}

export interface GarageWarningRecord {
  time: SimTime;
  message: string;
  detail?: Record<string, unknown>;
}

export interface SimulationEvent {
  id: string;
  time: SimTime;
  type: SimulationEventType;
  vehicleId: VehicleId;
}

export interface EventAcceptanceResult {
  eventId: string;
  vehicleId: VehicleId;
  accepted: boolean;
  outcome:
    | "QueuedInbound"
    | "QueuedOutbound"
    | "Balked"
    | "RejectedGarageFull"
    | "RejectedUnknownVehicle"
    | "RejectedDuplicateOutboundRequest";
  queuePosition?: number;
  reason?: string;
}

export interface GarageTickResult {
  completedOperations: GarageCompletedOperation[];
  startedOperations: GarageOperation[];
}

export interface GarageCompletedOperation {
  type: GarageOperationType;
  vehicleId?: VehicleId;
  durationSeconds: number;
  detail: Record<string, unknown>;
}

export interface GarageStateSnapshot {
  time: SimTime;
  occupancy: OccupancyState;
  queues: QueueState;
  elevator: ElevatorState;
  preparationPositions: PreparationPositionState[];
  vmrs: VmrState[];
  counters: GarageCumulativeCounters;
  activeOperations: GarageOperation[];
}

export interface OccupancyState {
  occupied: CellOccupancy[];
  occupiedCount: number;
  totalParkingCells: number;
  occupancyPercent: number;
}

export interface CellOccupancy {
  cellId: CellId;
  vehicleId: VehicleId;
  parkedAt: SimTime;
}

export interface QueueState {
  inbound: QueuedVehicle[];
  outbound: QueuedVehicle[];
  inboundLength: number;
  outboundLength: number;
}

export interface QueuedVehicle {
  vehicleId: VehicleId;
  queuedAt: SimTime;
}

export interface ElevatorState {
  status: "IdleAtHome" | "Busy";
  currentFloor: number;
  deckCount: number;
  direction?: "up" | "down" | "stopped";
  decks?: ElevatorDeckState[];
  activeTrip?: ElevatorTripState;
  activeOperationId?: string;
}

export interface PreparationPositionState {
  id: string;
  direction: "inbound" | "outbound";
  doorState?: "open" | "closed" | "opening" | "closing";
  doorTransitionCompleteAt?: SimTime;
  occupiedBy?: VehicleId;
  readyAt?: SimTime;
}

export interface VmrState {
  id: string;
  deckId: string;
  status: "Idle" | "Busy";
  homeDeckId?: string;
  currentTask?: VmrTaskState;
  distanceMovedMeters: number;
}

export interface ElevatorDeckState {
  id: string;
  index: number;
  alignedFloor: number;
  orientation: "garage" | "street";
  vehicleId?: VehicleId;
  vehicleRole?: "inbound" | "outbound" | "blocker";
  vmrId: string;
}

export interface VmrTaskState {
  type: GarageOperationType;
  startedAt: SimTime;
  completesAt: SimTime;
  from?: LocationId;
  to?: LocationId;
  vehicleId?: VehicleId;
  path?: VmrPath;
}

export interface VmrPath {
  floor: number;
  locations: LocationId[];
  cells: CellId[];
  distanceMeters: number;
}

export interface ElevatorTripState {
  id: string;
  phase: string;
  startedAt: SimTime;
  route: number[];
  routeIndex: number;
  inboundVehicleIds: VehicleId[];
  outboundVehicleIds: VehicleId[];
}

export interface GarageOperation {
  id: string;
  type: GarageOperationType;
  vehicleId?: VehicleId;
  startedAt: SimTime;
  completesAt: SimTime;
  from?: LocationId;
  to?: LocationId;
  path?: VmrPath;
}

export interface GarageCumulativeCounters {
  inboundAccepted: number;
  outboundAccepted: number;
  inboundBalked: number;
  inboundCompleted: number;
  outboundCompleted: number;
  rejectedEvents: number;
  maxInboundQueueLength: number;
  maxOutboundQueueLength: number;
  elevatorFloorsPassed: number;
  vmrDistanceMeters: number;
  inducedInboundTrips: number;
  inducedInboundVehicles: number;
  idleUnblockingActions: number;
  idleUnblockedVehicles: number;
  downwardTripPlacements: number;
}

export interface CapacityInfo {
  totalParkingCells: number;
  occupiedParkingCells: number;
  availableParkingCells: number;
}

export interface GarageLayout {
  getParkingCells(): CellId[];
  getCellFloor(cellId: CellId): number;
  getCellGeometry(cellId: CellId): CellGeometry;
  getBlockingCells(cellId: CellId, occupancy: OccupancyState): CellId[];
  wouldCreateBlockedEmptyCell(cellId: CellId, occupancy: OccupancyState): boolean;
  classifyBlockage(cellId: CellId, occupancy: OccupancyState): BlockageType;
  estimateAccessCost(cellId: CellId, occupancy: OccupancyState): DurationSeconds;
}

export interface CellGeometry {
  floor: number;
  row: number;
  column: number;
}

export interface PlacementContext {
  time: SimTime;
  layout: GarageLayout;
  occupancy: OccupancyState;
}

export interface RankedCell {
  cellId: CellId;
  score: number;
  reason: string;
}

export interface PlacementStrategy {
  rankCandidateCells(context: PlacementContext): RankedCell[];
  chooseCell(vehicleId: VehicleId, context: PlacementContext, rng: RandomSource): CellId | null;
}

export interface RetrievalContext {
  time: SimTime;
  vehicleId: VehicleId;
  layout: GarageLayout;
  occupancy: OccupancyState;
}

export interface RetrievalClass {
  blockage: BlockageType;
  estimatedSeconds: DurationSeconds;
}

export interface RetrievalPlan {
  vehicleId: VehicleId;
  blockers: VehicleId[];
  estimatedSeconds: DurationSeconds;
}

export interface RetrievalStrategy {
  classifyRequest(vehicleId: VehicleId, context: RetrievalContext): RetrievalClass;
  buildRetrievalPlan(vehicleId: VehicleId, context: RetrievalContext): RetrievalPlan;
}

export interface VmrPathPlanner {
  findAccessPlan(
    cellId: CellId,
    occupancy: OccupancyState,
  ): { path: VmrPath; blockerCells: CellId[] } | null;
  findClearPathFromElevator(cellId: CellId, occupancy: OccupancyState): VmrPath | null;
  findClearPathToElevator(cellId: CellId, occupancy: OccupancyState): VmrPath | null;
  isClear(
    path: VmrPath,
    occupancy: OccupancyState,
    endpointCell: CellId,
    endpointMayBeOccupied: boolean,
  ): boolean;
  pathsConflict(a: VmrPath, b: VmrPath): boolean;
}

export interface TripPlanningContext {
  time: SimTime;
  snapshot: GarageStateSnapshot;
  config: GarageConfig;
  layout: GarageLayout;
  pathPlanner: VmrPathPlanner;
  placementStrategy: PlacementStrategy;
  idleSeconds: number;
  idleUnblockingAllowed: boolean;
}

export interface ElevatorTripPlan {
  id: string;
  phase: "planned" | "idle-unblocking";
  stops: number[];
  inboundVehicleIds: VehicleId[];
  outboundVehicleIds: VehicleId[];
  selectedOutboundVehicleIds: VehicleId[];
  inducedInboundVehicles: number;
  groups: ElevatorTripActionGroup[];
}

export interface ElevatorTripActionGroup {
  name: string;
  actions: ElevatorTripAction[];
  elevatorDirection?: "up" | "down" | "stopped";
}

export interface ElevatorTripAction {
  type: GarageOperationType;
  durationSeconds: number;
  vehicleId?: VehicleId;
  from?: LocationId;
  to?: LocationId;
  path?: VmrPath;
  deckIndex?: number;
  preparationPositionId?: string;
  doorFinalState?: "open" | "closed";
  setDriverReady?: boolean;
}

export interface ElevatorTripPlanner {
  planNextTrip(context: TripPlanningContext): ElevatorTripPlan | null;
}

export interface PreparationPositionContext {
  time: SimTime;
  snapshot: GarageStateSnapshot;
}

export interface PreparationPositionAssignment {
  inboundPositionIds: string[];
  outboundPositionIds: string[];
}

export interface PreparationPositionPolicy {
  chooseAssignments(context: PreparationPositionContext): PreparationPositionAssignment;
}

export interface UnblockingContext {
  time: SimTime;
  snapshot: GarageStateSnapshot;
  idleSeconds: number;
}

export interface UnblockingPlan {
  operations: GarageOperation[];
}

export interface UnblockingStrategy {
  shouldStartIdleUnblocking(context: UnblockingContext): boolean;
  planUnblocking(context: UnblockingContext): UnblockingPlan | null;
}

export interface SimulationSession {
  id: string;
  config: SimulationConfig;
  garage: GarageTowerSystem;
  demandGenerator: DemandGenerator;
  recorder: SimulationStateRecorder;
  intakeRandomSource: RandomSource;
  garageRandomSource: RandomSource;
}

export interface SimulationRunner {
  initialize(configPath: string): Promise<SimulationSession>;
  run(session: SimulationSession): Promise<SimulationResult>;
  runOneSecond(session: SimulationSession, time: SimTime): Promise<TickResult>;
}

export interface DemandGenerator {
  initialize(params: DemandGenerationConfig, runtime: SimulationRuntimeConfig, seed: number): void;
  generateEventsAt(time: SimTime, garageState: GarageStateSnapshot): SimulationEvent[];
  recordIntakeResults(results: EventAcceptanceResult[]): void;
}

export interface SimulationStateRecorder {
  open(session: SimulationSession): Promise<void>;
  recordSecond(record: SimulationSecondRecord): Promise<void>;
  close(): Promise<void>;
  getOutputRef(): RawSimulationOutputRef;
}

export interface SimulationSecondRecord {
  sessionId: string;
  time: SimTime;
  generatedEvents: SimulationEvent[];
  intakeResults: EventAcceptanceResult[];
  tickResult: GarageTickResult;
  beforeSnapshot: GarageStateSnapshot;
  afterSnapshot: GarageStateSnapshot;
  telemetry: GarageTelemetryRecord[];
}

export type GarageTelemetryRecord =
  | { kind: "operation"; value: GarageOperationRecord }
  | { kind: "metric"; value: GarageMetricRecord }
  | { kind: "warning"; value: GarageWarningRecord };

export interface TickResult {
  record: SimulationSecondRecord;
}

export interface RawSimulationOutputRef {
  path: string;
}

export interface SimulationResult {
  sessionId: string;
  rawOutput: RawSimulationOutputRef;
  startedAt: SimTime;
  endedAt: SimTime;
  finalSnapshot: GarageStateSnapshot;
}

export interface ReportConfig {
  destinationPath: string;
}

export interface SimulationReport {
  sessionId: string;
  generatedAt: string;
  source: RawSimulationOutputRef;
  simulationStartTime: string;
  timezone: string;
  daily: DailyReportMetrics[];
  thirtyDaySummary: ThirtyDayReportSummary;
}

export interface DailyReportMetrics {
  dayIndex: number;
  dateOfMonth: number;
  date: string;
  dayOfWeek: string;
  successfulActivities: number;
  vehiclesStayingUntilMidnight: number;
  averageInboundDriverWaitingSeconds: number;
  averageInboundWaitSeconds: number;
  averageOutboundWaitSeconds: number;
  averageInboundDriverWaitingSecondsDuringMorningPeak: number;
  averageInboundWaitSecondsDuringMorningPeak: number;
  averageOutboundWaitSecondsDuringEveningPeak: number;
  longestInboundDriverWaitingSeconds: number;
  longestInboundWaitSeconds: number;
  longestOutboundWaitSeconds: number;
  biggestInboundQueueLength: number;
  biggestOutboundQueueLength: number;
  inboundBalkingVehicles: number;
  balkingOverSuccessfulInboundPercent: number;
  maximumOccupancyPercent: number;
  elevatorTripsCarryingInducedInboundVehicles: number;
  totalInducedInboundVehicles: number;
  idleUnblockingActions: number;
  idleUnblockedVehicles: number;
  downwardTripPlacements: number;
  totalParkingHours: number;
  totalCollectableParkingHours: number;
  totalElevatorFloorsPassed: number;
  totalVmrDistanceMeters: number;
  totalRevenue: number;
}

export interface ThirtyDayReportSummary {
  sum: Omit<DailyReportMetrics, "dayIndex" | "dateOfMonth" | "date" | "dayOfWeek">;
  average: Omit<DailyReportMetrics, "dayIndex" | "dateOfMonth" | "date" | "dayOfWeek">;
}

export interface ReportGenerator {
  generate(rawOutput: RawSimulationOutputRef, config: ReportConfig): Promise<SimulationReport>;
  write(report: SimulationReport, destination: string): Promise<void>;
}

export interface RawSimulationReader {
  readMetadata(): Promise<RawSimulationMetadata>;
  readRecords(): Promise<RawSimulationDataRecord[]>;
}

export interface MetricsAggregator {
  consumeRecord(record: RawSimulationDataRecord): void;
  finalize(): DailyReportMetrics[];
}

export interface RawSimulationMetadata {
  kind: "metadata";
  sessionId: string;
  config: SimulationConfig;
  recording?: {
    schema: "verbose-second-v1" | "compact-jsonl-v1";
    checkpointIntervalSeconds?: number;
  };
}

export type RawSimulationDataRecord =
  | RawSimulationSecondDataRecord
  | RawSimulationEventsRecord
  | RawSimulationOperationsRecord
  | RawSimulationStateRecord
  | RawSimulationCheckpointRecord;

export interface RawSimulationSecondDataRecord {
  kind: "second";
  record: SimulationSecondRecord;
}

export interface RawSimulationEventsRecord {
  kind: "events";
  t: SimTime;
  generated: SimulationEvent[];
  intake: EventAcceptanceResult[];
}

export interface RawSimulationOperationsRecord {
  kind: "operations";
  t: SimTime;
  started?: GarageOperation[];
  completed?: GarageCompletedOperation[];
  telemetry?: GarageTelemetryRecord[];
}

export interface RawSimulationStateRecord {
  kind: "state";
  t: SimTime;
  occupancy: {
    occupiedCount: number;
    totalParkingCells: number;
    occupancyPercent: number;
  };
  queues: {
    inboundLength: number;
    outboundLength: number;
  };
  counters: GarageCumulativeCounters;
}

export interface RawSimulationCheckpointRecord {
  kind: "checkpoint";
  t: SimTime;
  snapshot: GarageStateSnapshot;
}
