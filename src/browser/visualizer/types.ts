import type {
  CellId,
  CellOccupancy,
  GarageOperation,
  GarageStateSnapshot,
  RawSimulationCheckpointRecord,
  RawSimulationDataRecord,
  RawSimulationMetadata,
  SimTime,
} from "../../domain/types.js";

export type RawOutputLine = RawSimulationMetadata | RawSimulationDataRecord;

export interface VisualizerDataSet {
  metadata: RawSimulationMetadata;
  records: RawSimulationDataRecord[];
  checkpoints: RawSimulationCheckpointRecord[];
  durationSeconds: number;
}

export interface InterpolatedOperation {
  operation: GarageOperation;
  progress: number;
  currentLocation?: string;
  destination?: string;
}

export interface VisualizerFrame {
  time: SimTime;
  snapshot: GarageStateSnapshot;
  interpolatedOperations: InterpolatedOperation[];
  elevatorDestination?: number;
}

export interface FloorCellView {
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

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface CanvasGarageGeometry {
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

export interface PolylineSample {
  point: Point;
  previous: Point;
  next: Point;
}

export const playbackSecondsPerSecond = 20;
export const frameCacheMaxEntries = 360;
export const parkingCellLengthMeters = 6;
export const parkingCellWidthMeters = 3;
export const vehicleLengthMeters = 5;
export const vehicleWidthMeters = 2;
export const vmrLengthMeters = 5.5;
export const vmrWidthMeters = 2.5;
