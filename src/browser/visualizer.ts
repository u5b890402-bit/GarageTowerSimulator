import type {
  CellId,
  CellOccupancy,
  CellReservation,
  ElevatorDeckState,
  GarageCompletedOperation,
  GarageConfig,
  GarageOperation,
  GarageOperationType,
  GarageStateSnapshot,
  LayoutConfig,
  PreparationPositionState,
  QueuedVehicle,
  RawSimulationCheckpointRecord,
  RawSimulationDataRecord,
  RawSimulationEventsRecord,
  RawSimulationMetadata,
  RawSimulationOperationsRecord,
  RawSimulationStateRecord,
  SimTime,
  SimulationConfig,
  VmrPath,
  VmrState,
} from "../domain/types.js";

type RawOutputLine = RawSimulationMetadata | RawSimulationDataRecord;

interface VisualizerDataSet {
  metadata: RawSimulationMetadata;
  records: RawSimulationDataRecord[];
  checkpoints: RawSimulationCheckpointRecord[];
  durationSeconds: number;
}

interface InterpolatedOperation {
  operation: GarageOperation;
  progress: number;
  currentLocation?: string;
  destination?: string;
}

interface VisualizerFrame {
  time: SimTime;
  snapshot: GarageStateSnapshot;
  interpolatedOperations: InterpolatedOperation[];
  elevatorDestination?: number;
}

interface FloorCellView {
  cellId: CellId;
  cellNumber: number;
  row: number;
  column: number;
  isElevator: boolean;
  isUnavailable: boolean;
  occupancy?: CellOccupancy;
  pathLabels: string[];
  currentLabels: string[];
  destinationLabels: string[];
}

interface Point {
  x: number;
  y: number;
}

interface Rect extends Point {
  width: number;
  height: number;
}

interface CanvasGarageGeometry {
  width: number;
  height: number;
  scale: number;
  vehicleSize: { width: number; height: number };
  perpendicularVehicleSize: { width: number; height: number };
  vmrSize: { width: number; height: number };
  floorWidth: number;
  floorHeight: number;
  cellsById: Map<CellId, Rect>;
  elevatorByFloor: Map<number, Rect>;
  floors: Map<number, Rect>;
  street: Rect;
  inboundQueue: Rect;
  preparationPositions: Map<string, Rect>;
}

interface PolylineSample {
  point: Point;
  previous: Point;
  next: Point;
}

const playbackSecondsPerSecond = 20;
const frameCacheMaxEntries = 360;
const parkingCellLengthMeters = 6;
const parkingCellWidthMeters = 3;
const vehicleLengthMeters = 5;
const vehicleWidthMeters = 2;
const vmrLengthMeters = 5.5;
const vmrWidthMeters = 2.5;

export function startVisualizer(): void {
  const root = document.querySelector<HTMLElement>("[data-visualizer-root]");
  if (!root) return;
  new BrowserVisualizerApp(root).start();
}

class BrowserVisualizerApp {
  private dataSet: VisualizerDataSet | null = null;
  private replayEngine: CheckpointReplayEngine | null = null;
  private isPlaying = false;
  private lastAnimationTime = 0;
  private currentTime = 0;
  private animationHandle = 0;

  private readonly loader = new JsonlVisualizerRawOutputLoader();
  private readonly physicalRenderer = new CanvasPhysicalStateRenderer();
  private readonly computationalRenderer = new HtmlComputationalStateRenderer();

  private readonly fileInput: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly timeReadout: HTMLElement;
  private readonly physicalView: HTMLElement;
  private readonly computationalView: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    this.fileInput = requiredElement(root, "#raw-output-input", HTMLInputElement);
    this.status = requiredElement(root, "#visualizer-status", HTMLElement);
    this.playButton = requiredElement(root, "#play-button", HTMLButtonElement);
    this.pauseButton = requiredElement(root, "#pause-button", HTMLButtonElement);
    this.slider = requiredElement(root, "#time-slider", HTMLInputElement);
    this.timeReadout = requiredElement(root, "#time-readout", HTMLElement);
    this.physicalView = requiredElement(root, "#physical-state-view", HTMLElement);
    this.computationalView = requiredElement(root, "#computational-state-view", HTMLElement);
  }

  start(): void {
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

  private async loadSelectedFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (!file) return;

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
      this.setStatus(
        `Loaded ${file.name}. ${this.dataSet.records.length.toLocaleString()} records, ${this.dataSet.checkpoints.length.toLocaleString()} checkpoints.`,
        "normal",
      );
    } catch (error) {
      this.dataSet = null;
      this.replayEngine = null;
      this.setControls(false);
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private play(): void {
    if (!this.replayEngine || this.isPlaying) return;
    this.isPlaying = true;
    this.lastAnimationTime = performance.now();
    this.animationHandle = requestAnimationFrame((timestamp) => this.advance(timestamp));
    this.setControls(true);
  }

  private pause(): void {
    if (this.animationHandle) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = 0;
    }
    this.isPlaying = false;
    this.setControls(Boolean(this.replayEngine));
  }

  private advance(timestamp: number): void {
    if (!this.isPlaying || !this.dataSet) return;
    const elapsedSeconds = (timestamp - this.lastAnimationTime) / 1000;
    this.lastAnimationTime = timestamp;
    const nextTime = Math.min(
      this.dataSet.durationSeconds,
      this.currentTime + elapsedSeconds * playbackSecondsPerSecond,
    );
    this.seek(nextTime);
    if (nextTime >= this.dataSet.durationSeconds) {
      this.pause();
      return;
    }
    this.animationHandle = requestAnimationFrame((nextTimestamp) => this.advance(nextTimestamp));
  }

  private seek(time: number): void {
    if (!this.dataSet) return;
    this.currentTime = clamp(time, 0, this.dataSet.durationSeconds);
    this.slider.value = String(Math.round(this.currentTime));
    this.renderCurrentFrame();
  }

  private renderCurrentFrame(): void {
    if (!this.replayEngine || !this.dataSet) return;
    const frame = this.replayEngine.getFrameAt(Math.round(this.currentTime));
    this.timeReadout.textContent = formatDuration(frame.time);
    this.physicalRenderer.render(this.physicalView, frame, this.dataSet.metadata.config.garage);
    this.computationalRenderer.render(this.computationalView, frame, this.dataSet.metadata.config);
  }

  private setControls(enabled: boolean): void {
    this.playButton.disabled = !enabled || this.isPlaying;
    this.pauseButton.disabled = !enabled || !this.isPlaying;
    this.slider.disabled = !enabled;
  }

  private setStatus(message: string, state: "normal" | "error"): void {
    this.status.textContent = message;
    this.status.dataset.state = state;
  }
}

class JsonlVisualizerRawOutputLoader {
  async load(file: File): Promise<VisualizerDataSet> {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new Error("The selected file is empty.");

    let metadata: RawSimulationMetadata | null = null;
    const records: RawSimulationDataRecord[] = [];
    const checkpoints: RawSimulationCheckpointRecord[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let parsed: RawOutputLine;
      try {
        parsed = JSON.parse(line) as RawOutputLine;
      } catch (error) {
        throw new Error(`Line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed.kind === "metadata") {
        metadata = parsed;
        continue;
      }
      records.push(parsed);
      if (parsed.kind === "checkpoint") checkpoints.push(parsed);
    }

    if (!metadata) throw new Error("The raw output does not contain a metadata record.");
    const loadedMetadata = metadata;
    if (checkpoints.length === 0) throw new Error("The raw output does not contain checkpoints, so it cannot be replayed.");

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

class CanvasPhysicalStateRenderer {
  private canvas: HTMLCanvasElement | null = null;

  render(container: HTMLElement, frame: VisualizerFrame, garage: GarageConfig): void {
    const geometry = this.buildGeometry(
      Math.max(720, Math.floor(container.clientWidth || 960)),
      garage.layout,
      frame.snapshot.preparationPositions,
    );
    const canvas = this.ensureCanvas(container);
    const context = canvas.getContext("2d");
    if (!context) return;

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

  private ensureCanvas(container: HTMLElement): HTMLCanvasElement {
    if (this.canvas && container.contains(this.canvas)) return this.canvas;
    const existingCanvas = container.querySelector<HTMLCanvasElement>("canvas.garage-canvas");
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

  private sizeCanvas(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
  ): void {
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.ceil(geometry.width * ratio);
    canvas.height = Math.ceil(geometry.height * ratio);
    canvas.style.width = `${geometry.width}px`;
    canvas.style.height = `${geometry.height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private buildGeometry(
    availableWidth: number,
    layout: LayoutConfig,
    preparationPositions: PreparationPositionState[],
  ): CanvasGarageGeometry {
    const margin = 24;
    const labelHeight = 28;
    const floorGap = 34;
    const streetGap = 14;
    const cellWidthMeters =
      layout.streetFacing === "longSide" ? parkingCellLengthMeters : parkingCellWidthMeters;
    const cellHeightMeters =
      layout.streetFacing === "longSide" ? parkingCellWidthMeters : parkingCellLengthMeters;
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
    const cellsById = new Map<CellId, Rect>();
    const elevatorByFloor = new Map<number, Rect>();
    const floors = new Map<number, Rect>();

    let y = margin;
    let street: Rect = { x: margin, y: margin, width: floorWidth, height: streetHeight };
    for (let floor = layout.floors; floor >= 1; floor -= 1) {
      const floorRect: Rect = {
        x: margin,
        y: y + labelHeight,
        width: floorWidth,
        height: floorHeight,
      };
      floors.set(floor, floorRect);
      for (let cellNumber = 1; cellNumber <= layout.rows * layout.columns; cellNumber += 1) {
        const row = Math.floor((cellNumber - 1) / layout.columns);
        const column = (cellNumber - 1) % layout.columns;
        const rect: Rect = {
          x: floorRect.x + column * cellWidthMeters * scale,
          y: floorRect.y + row * cellHeightMeters * scale,
          width: cellWidthMeters * scale,
          height: cellHeightMeters * scale,
        };
        const cellId = `f${floor}c${cellNumber}`;
        cellsById.set(cellId, rect);
        if (cellNumber === layout.elevatorCell) elevatorByFloor.set(floor, rect);
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

    const inboundQueue: Rect = {
      x: street.x + 12,
      y: street.y + 36,
      width: Math.max(180, street.width * 0.42),
      height: street.height - 50,
    };
    const preparationRects = this.buildPreparationPositionRects(
      layout,
      cellsById,
      street,
      inboundQueue,
      preparationPositions,
    );

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

  private buildPreparationPositionRects(
    layout: LayoutConfig,
    cellsById: Map<CellId, Rect>,
    street: Rect,
    inboundQueue: Rect,
    positions: PreparationPositionState[],
  ): Map<string, Rect> {
    const result = new Map<string, Rect>();
    const firstFloorSlots = this.firstFloorPreparationPositionSlots(layout, cellsById);
    if (firstFloorSlots.length > 0) {
      positions.forEach((position, index) => {
        const slot = firstFloorSlots[index % firstFloorSlots.length];
        if (slot) result.set(position.id, slot);
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

  private firstFloorPreparationPositionSlots(
    layout: LayoutConfig,
    cellsById: Map<CellId, Rect>,
  ): Rect[] {
    if (layout.streetFacing !== "longSide" || layout.rows < 3 || layout.columns < 3) {
      return [];
    }
    const left = unionRects(cellsById.get("f1c4"), cellsById.get("f1c7"));
    const right = unionRects(cellsById.get("f1c6"), cellsById.get("f1c9"));
    if (!left || !right) return [];
    return [leftHalf(left), rightHalf(left), leftHalf(right), rightHalf(right)];
  }

  private drawBackground(context: CanvasRenderingContext2D, geometry: CanvasGarageGeometry): void {
    context.clearRect(0, 0, geometry.width, geometry.height);
    context.fillStyle = "#ffffff";
    this.fillRoundedRect(context, 0, 0, geometry.width, geometry.height, 8);
  }

  private drawFloors(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    layout: LayoutConfig,
  ): void {
    const unavailable = new Set([layout.elevatorCell, ...layout.unavailableCells]);
    for (const [floor, floorRect] of geometry.floors) {
      context.fillStyle = "#1f2a2e";
      context.font = "700 15px Arial, Helvetica, sans-serif";
      context.fillText(`Floor ${floor}`, floorRect.x, floorRect.y - 9);
      context.fillStyle = "#627178";
      context.font = "12px Arial, Helvetica, sans-serif";
      context.fillText(
        `${formatMeters(geometry.floorWidth / geometry.scale)}m x ${formatMeters(geometry.floorHeight / geometry.scale)}m`,
        floorRect.x + 78,
        floorRect.y - 9,
      );

      context.strokeStyle = "#ccd7d4";
      context.lineWidth = 1;
      context.strokeRect(floorRect.x, floorRect.y, floorRect.width, floorRect.height);

      for (let cellNumber = 1; cellNumber <= layout.rows * layout.columns; cellNumber += 1) {
        const rect = geometry.cellsById.get(`f${floor}c${cellNumber}`);
        if (!rect) continue;
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

  private drawStreet(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    snapshot: GarageStateSnapshot,
  ): void {
    context.fillStyle = "#f6f8f7";
    this.fillRoundedRect(
      context,
      geometry.street.x,
      geometry.street.y,
      geometry.street.width,
      geometry.street.height,
      8,
    );
    context.strokeStyle = "#d7dfdc";
    context.strokeRect(
      geometry.street.x,
      geometry.street.y,
      geometry.street.width,
      geometry.street.height,
    );
    context.fillStyle = "#1f2a2e";
    context.font = "700 14px Arial, Helvetica, sans-serif";
    context.fillText("Street Level", geometry.street.x + 12, geometry.street.y + 22);

    this.drawLabeledBox(context, geometry.inboundQueue, "Inbound Queue", "#eef4f2");
    const vehicleStepX = geometry.vehicleSize.width + 10;
    const vehicleStepY = geometry.vehicleSize.height + 10;
    const queueColumns = Math.max(
      1,
      Math.floor((geometry.inboundQueue.width - 20) / vehicleStepX),
    );
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
      context.fillText(
        `+${snapshot.queues.inbound.length - 12} more`,
        geometry.inboundQueue.x + 10,
        geometry.inboundQueue.y + geometry.inboundQueue.height - 10,
      );
    }

  }

  private drawPreparationPositionFrames(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    snapshot: GarageStateSnapshot,
  ): void {
    for (const position of snapshot.preparationPositions) {
      const rect = geometry.preparationPositions.get(position.id);
      if (!rect) continue;
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

  private drawPreparationPositionVehicles(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    snapshot: GarageStateSnapshot,
  ): void {
    for (const position of snapshot.preparationPositions) {
      if (!position.occupiedBy) continue;
      const rect = geometry.preparationPositions.get(position.id);
      if (!rect) continue;
      this.drawVehicle(
        context,
        this.vehicleRectAt(rectCenter(rect), geometry, "perpendicular"),
        position.occupiedBy,
        "#14343d",
      );
    }
  }

  private drawPlannedPaths(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    frame: VisualizerFrame,
  ): void {
    frame.interpolatedOperations.forEach((item, index) => {
      const points = this.polylineForOperation(geometry, item.operation);
      if (points.length < 2) return;
      const color = index % 2 === 0 ? "#c18622" : "#0f7a6c";
      context.save();
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 3;
      context.setLineDash([8, 6]);
      context.beginPath();
      context.moveTo(points[0]?.x ?? 0, points[0]?.y ?? 0);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
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

  private drawParkedVehicles(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    frame: VisualizerFrame,
  ): void {
    const movingVehicles = this.movingVehicleIds(frame);
    for (const occupancy of frame.snapshot.occupancy.occupied) {
      if (movingVehicles.has(occupancy.vehicleId)) continue;
      const rect = geometry.cellsById.get(occupancy.cellId);
      if (!rect) continue;
      this.drawVehicle(context, this.vehicleRectAt(rectCenter(rect), geometry), occupancy.vehicleId, "#14343d");
    }
  }

  private drawReservedDestinations(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    frame: VisualizerFrame,
  ): void {
    const occupied = new Set(frame.snapshot.occupancy.occupied.map((cell) => cell.cellId));
    for (const reservation of frame.snapshot.occupancy.reservations ?? []) {
      if (occupied.has(reservation.cellId)) continue;
      const rect = geometry.cellsById.get(reservation.cellId);
      if (!rect) continue;
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

  private drawElevatorDecks(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    frame: VisualizerFrame,
  ): void {
    const movingVehicles = this.movingVehicleIds(frame);
    const activeVmrDeckIndexes = this.activeVmrDeckIndexes(frame);
    const decksByFloor = groupDecksByFloor(frame.snapshot.elevator.decks ?? []);
    for (const [floor, decks] of decksByFloor) {
      const shaft = geometry.elevatorByFloor.get(floor);
      if (!shaft) continue;
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
          this.drawVehicle(
            context,
            this.vehicleRectAt(rectCenter(shaft), geometry),
            deck.vehicleId,
            deck.vehicleRole === "outbound" ? "#87352f" : "#14343d",
          );
        }
      });
    }
  }

  private drawMovingVmrs(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    frame: VisualizerFrame,
  ): void {
    for (const item of frame.interpolatedOperations) {
      const points = this.polylineForOperation(geometry, item.operation);
      if (points.length < 2) continue;
      const sample = samplePolyline(points, item.progress);
      const deck = deckLabel(item.operation);
      this.drawVmr(context, this.vmrRectAt(sample.point, geometry), deck);
      context.fillStyle = "#1f2a2e";
      context.font = "700 11px Arial, Helvetica, sans-serif";
      context.fillText(
        `${deck} ${Math.round(item.progress * 100)}%`,
        sample.point.x + 12,
        sample.point.y - 12,
      );
    }
  }

  private drawMovingVehicles(
    context: CanvasRenderingContext2D,
    geometry: CanvasGarageGeometry,
    frame: VisualizerFrame,
  ): void {
    for (const item of frame.interpolatedOperations) {
      const points = this.polylineForOperation(geometry, item.operation);
      if (points.length < 2) continue;
      const sample = samplePolyline(points, item.progress);
      if (item.operation.vehicleId && carriesVehicle(item.operation.type)) {
        this.drawVehicle(
          context,
          this.vehicleRectAt({
            x: sample.point.x,
            y: sample.point.y - geometry.vmrSize.height * 0.18,
          }, geometry),
          item.operation.vehicleId,
          "#87352f",
        );
      }
    }
  }

  private polylineForOperation(
    geometry: CanvasGarageGeometry,
    operation: GarageOperation,
  ): Point[] {
    const rawLocations =
      operation.path && operation.path.locations.length > 0
        ? operation.path.locations
        : operation.path?.cells ?? [];
    const points: Point[] = [];
    for (const location of rawLocations) {
      const point = this.pointForLocation(geometry, location);
      if (!point) continue;
      const previous = points[points.length - 1];
      if (previous && previous.x === point.x && previous.y === point.y) continue;
      points.push(point);
    }
    return points;
  }

  private pointForLocation(
    geometry: CanvasGarageGeometry,
    location: string,
  ): Point | null {
    const cell = geometry.cellsById.get(location);
    if (cell) return rectCenter(cell);
    const elevatorMatch = location.match(/^f(\d+):elevator$/);
    if (elevatorMatch?.[1]) {
      const elevator = geometry.elevatorByFloor.get(Number(elevatorMatch[1]));
      return elevator ? rectCenter(elevator) : null;
    }
    return null;
  }

  private movingVehicleIds(frame: VisualizerFrame): Set<string> {
    const result = new Set<string>();
    for (const item of frame.interpolatedOperations) {
      if (item.operation.vehicleId && item.operation.path && carriesVehicle(item.operation.type)) {
        result.add(item.operation.vehicleId);
      }
    }
    return result;
  }

  private activeVmrDeckIndexes(frame: VisualizerFrame): Set<number> {
    const result = new Set<number>();
    for (const item of frame.interpolatedOperations) {
      const deckIndex = operationDeckIndex(item.operation);
      if (deckIndex !== null && item.operation.path && item.operation.type !== "RotateDeck") {
        result.add(deckIndex);
      }
    }
    return result;
  }

  private drawLabeledBox(
    context: CanvasRenderingContext2D,
    rect: Rect,
    label: string,
    fill: string,
  ): void {
    context.fillStyle = fill;
    this.fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 6);
    context.strokeStyle = "#d7dfdc";
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    context.fillStyle = "#1f2a2e";
    context.font = "700 12px Arial, Helvetica, sans-serif";
    context.fillText(label, rect.x + 8, rect.y + 15);
  }

  private drawVehicle(
    context: CanvasRenderingContext2D,
    rect: Rect,
    vehicleId: string,
    color: string,
  ): void {
    context.fillStyle = color;
    this.fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
    context.fillStyle = "#ffffff";
    context.font = "700 10px Arial, Helvetica, sans-serif";
    context.fillText(`V ${shortId(vehicleId)}`, rect.x + 5, rect.y + Math.min(rect.height - 5, 14));
  }

  private drawVmr(context: CanvasRenderingContext2D, rect: Rect, label: string): void {
    context.fillStyle = "#0f7a6c";
    this.fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    context.fillStyle = "#ffffff";
    context.font = "700 10px Arial, Helvetica, sans-serif";
    context.fillText(label, rect.x + 5, rect.y + Math.min(rect.height - 5, 14));
  }

  private vehicleRectAt(
    center: Point,
    geometry: CanvasGarageGeometry,
    orientation: "parking" | "perpendicular" = "parking",
  ): Rect {
    const size =
      orientation === "perpendicular"
        ? geometry.perpendicularVehicleSize
        : geometry.vehicleSize;
    return rectFromCenter(center, size.width, size.height);
  }

  private vmrRectAt(center: Point, geometry: CanvasGarageGeometry): Rect {
    return rectFromCenter(center, geometry.vmrSize.width, geometry.vmrSize.height);
  }

  private drawArrowHead(
    context: CanvasRenderingContext2D,
    from: Point | undefined,
    to: Point | undefined,
    color: string,
  ): void {
    if (!from || !to) return;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 9;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(
      to.x - size * Math.cos(angle - Math.PI / 6),
      to.y - size * Math.sin(angle - Math.PI / 6),
    );
    context.lineTo(
      to.x - size * Math.cos(angle + Math.PI / 6),
      to.y - size * Math.sin(angle + Math.PI / 6),
    );
    context.closePath();
    context.fill();
  }

  private fillRoundedRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
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

  private drawStackedText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    lineHeight: number,
  ): void {
    [...text].forEach((char, index) => {
      context.fillText(char, x, y + index * lineHeight);
    });
  }
}

class HtmlComputationalStateRenderer {
  render(container: HTMLElement, frame: VisualizerFrame, config: SimulationConfig): void {
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

  private renderOperation(item: InterpolatedOperation): string {
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

function buildActivePathIndex(
  operations: InterpolatedOperation[],
): Map<CellId, { path: string[]; current: string[]; destination: string[] }> {
  const result = new Map<CellId, { path: string[]; current: string[]; destination: string[] }>();
  for (const item of operations) {
    const path = item.operation.path;
    if (!path) continue;
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

function groupDecksByFloor(decks: ElevatorDeckState[]): Map<number, ElevatorDeckState[]> {
  const result = new Map<number, ElevatorDeckState[]>();
  for (const deck of decks) {
    const list = result.get(deck.alignedFloor) ?? [];
    list.push(deck);
    result.set(deck.alignedFloor, list);
  }
  return result;
}

function ensurePathEntry(
  map: Map<CellId, { path: string[]; current: string[]; destination: string[] }>,
  cellId: CellId,
): { path: string[]; current: string[]; destination: string[] } {
  const existing = map.get(cellId);
  if (existing) return existing;
  const entry = { path: [], current: [], destination: [] };
  map.set(cellId, entry);
  return entry;
}

function interpolateOperation(operation: GarageOperation, time: SimTime): InterpolatedOperation {
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

function pathLocationAt(path: VmrPath | undefined, progress: number): { current?: string; destination?: string } {
  if (!path || path.locations.length === 0) return {};
  const lastIndex = path.locations.length - 1;
  const index = Math.min(lastIndex, Math.max(0, Math.floor(progress * lastIndex)));
  return {
    ...(path.locations[index] ? { current: path.locations[index] } : {}),
    ...(path.locations[lastIndex] ? { destination: path.locations[lastIndex] } : {}),
  };
}

function samplePolyline(points: Point[], progress: number): PolylineSample {
  if (points.length === 0) {
    const origin = { x: 0, y: 0 };
    return { point: origin, previous: origin, next: origin };
  }
  if (points.length === 1) {
    const only = points[0] ?? { x: 0, y: 0 };
    return { point: only, previous: only, next: only };
  }

  const segmentLengths: number[] = [];
  let totalLength = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) continue;
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
    if (!from || !to) continue;
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

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function rectCenter(rect: Rect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function rectFromCenter(center: Point, width: number, height: number): Rect {
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

function insetRectByPixels(rect: Rect, xInset: number, yInset: number): Rect {
  return {
    x: rect.x + xInset,
    y: rect.y + yInset,
    width: Math.max(8, rect.width - xInset * 2),
    height: Math.max(8, rect.height - yInset * 2),
  };
}

function unionRects(a: Rect | undefined, b: Rect | undefined): Rect | null {
  if (!a || !b) return null;
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

function leftHalf(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width / 2,
    height: rect.height,
  };
}

function rightHalf(rect: Rect): Rect {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y,
    width: rect.width / 2,
    height: rect.height,
  };
}

function physicalPreparationPositionLabel(position: PreparationPositionState): string {
  const number = Number(/\d+$/.exec(position.id)?.[0] ?? 1);
  if (position.id.startsWith("IPP")) return `PP${5 - number}`;
  if (position.id.startsWith("OPP")) return `PP${3 - number}`;
  return position.id.replace(/^P/, "PP");
}

function carriesVehicle(type: GarageOperationType): boolean {
  return (
    type === "ParkInbound" ||
    type === "LoadOutbound" ||
    type === "MoveBlocker" ||
    type === "RelocateBlocker" ||
    type === "IdleUnblock"
  );
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

function formatMeters(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function operationDeckIndex(operation: GarageOperation): number | null {
  return parseDeckIndex(operation.from) ?? parseDeckIndex(operation.to);
}

function deckByLocation(decks: ElevatorDeckState[], location: string | undefined): ElevatorDeckState | undefined {
  const index = parseDeckIndex(location);
  return index === null ? undefined : decks[index];
}

function parseDeckIndex(location: string | undefined): number | null {
  if (!location?.startsWith("D")) return null;
  const value = Number(location.slice(1));
  return Number.isFinite(value) && value >= 1 ? value - 1 : null;
}

function deckLabel(operation: GarageOperation): string {
  const index = operationDeckIndex(operation);
  return index === null ? "VMR" : `D${index + 1}`;
}

function elevatorPosition(location: string | undefined): number | null {
  if (!location?.startsWith("elevator-position-")) return null;
  const value = Number(location.slice("elevator-position-".length));
  return Number.isFinite(value) ? value : null;
}

function inferDeckFromRotateGroup(
  decks: ElevatorDeckState[],
  group: string | undefined,
): ElevatorDeckState | undefined {
  if (!group) return undefined;
  const match = group.match(/D(\d+)/i);
  if (!match?.[1]) return undefined;
  const index = Number(match[1]) - 1;
  return decks[index];
}

function reserveDestinationForOperation(
  snapshot: GarageStateSnapshot,
  operation: GarageOperation,
): void {
  if (!isCellReservationPurpose(operation.type) || !operation.vehicleId || !operation.to?.startsWith("f")) {
    return;
  }
  const reservation: CellReservation = {
    cellId: operation.to,
    vehicleId: operation.vehicleId,
    operationId: operation.id,
    reservedAt: operation.startedAt,
    expectedOccupiedAt: operation.completesAt,
    purpose: operation.type,
  };
  const existing = snapshot.occupancy.reservations ?? [];
  snapshot.occupancy.reservations = [
    ...existing.filter(
      (candidate) =>
        candidate.cellId !== reservation.cellId &&
        candidate.operationId !== reservation.operationId,
    ),
    reservation,
  ];
}

function releaseReservationForCompletedOperation(
  snapshot: GarageStateSnapshot,
  operation: GarageCompletedOperation,
): void {
  if (!isCellReservationPurpose(operation.type)) return;
  const to = stringDetail(operation.detail, "to");
  snapshot.occupancy.reservations = (snapshot.occupancy.reservations ?? []).filter(
    (reservation) =>
      reservation.cellId !== to &&
      (!operation.vehicleId || reservation.vehicleId !== operation.vehicleId),
  );
}

function isCellReservationPurpose(
  type: GarageOperationType,
): type is CellReservation["purpose"] {
  return (
    type === "ParkInbound" ||
    type === "RelocateBlocker" ||
    type === "IdleUnblock"
  );
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

function recordTime(record: RawSimulationDataRecord): SimTime {
  return record.kind === "second" ? record.record.time : record.t;
}

function stringDetail(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredElement<T extends HTMLElement>(
  root: ParentNode,
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing required visualizer element: ${selector}`);
  }
  return element;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  const clock = [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `day ${days + 1}, ${clock}` : clock;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
