import type {
  BlockageType,
  CellGeometry,
  CellId,
  GarageLayout,
  LayoutConfig,
  OccupancyState,
} from "../domain/types.js";

export class GridGarageLayout implements GarageLayout {
  private readonly parkingCells: CellId[];
  private readonly geometryByCell = new Map<CellId, CellGeometry>();

  constructor(private readonly config: LayoutConfig) {
    const unavailable = new Set([config.elevatorCell, ...config.unavailableCells]);
    const cellsPerFloor = config.rows * config.columns;
    const parkingCells: CellId[] = [];

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

  getParkingCells(): CellId[] {
    return [...this.parkingCells];
  }

  getCellFloor(cellId: CellId): number {
    return this.getCellGeometry(cellId).floor;
  }

  getCellGeometry(cellId: CellId): CellGeometry {
    const geometry = this.geometryByCell.get(cellId);
    if (!geometry) {
      throw new Error(`Unknown cell id: ${cellId}`);
    }
    return geometry;
  }

  classifyBlockage(cellId: CellId, _occupancy: OccupancyState): BlockageType {
    const { row, column } = this.getCellGeometry(cellId);
    const corner = (row === 1 || row === this.config.rows) && (column === 1 || column === this.config.columns);
    if (!corner) return "none";
    return this.config.rows >= 5 && this.config.columns >= 5 ? "deep" : "shallow";
  }

  estimateAccessCost(cellId: CellId, occupancy: OccupancyState): number {
    const geometry = this.getCellGeometry(cellId);
    const blockage = this.classifyBlockage(cellId, occupancy);
    const blockagePenalty = blockage === "deep" ? 120 : blockage === "shallow" ? 60 : 0;
    const manhattanFromElevator =
      Math.abs(geometry.row - Math.ceil(this.config.rows / 2)) +
      Math.abs(geometry.column - Math.ceil(this.config.columns / 2));
    return geometry.floor * 10 + manhattanFromElevator * 5 + blockagePenalty;
  }
}
