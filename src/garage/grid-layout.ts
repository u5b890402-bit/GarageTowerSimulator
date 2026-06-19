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

  getBlockingCells(cellId: CellId, occupancy: OccupancyState): CellId[] {
    const target = this.getCellGeometry(cellId);
    const centerRow = Math.ceil(this.config.rows / 2);
    const centerColumn = Math.ceil(this.config.columns / 2);
    const occupied = new Set(occupancy.occupied.map((cell) => cell.cellId));
    const horizontalFirst = this.buildPath(
      target.floor,
      centerRow,
      centerColumn,
      target.row,
      target.column,
      true,
    );
    const verticalFirst = this.buildPath(
      target.floor,
      centerRow,
      centerColumn,
      target.row,
      target.column,
      false,
    );
    const candidates = [horizontalFirst, verticalFirst]
      .map((path) => path.filter((pathCell) => pathCell !== cellId && occupied.has(pathCell)))
      .sort((a, b) => a.length - b.length || a.join(",").localeCompare(b.join(",")));
    return candidates[0] ?? [];
  }

  wouldCreateBlockedEmptyCell(cellId: CellId, occupancy: OccupancyState): boolean {
    const candidateOccupancy: OccupancyState = {
      ...occupancy,
      occupied: [
        ...occupancy.occupied,
        { cellId, vehicleId: "__candidate__", parkedAt: 0 },
      ],
      occupiedCount: occupancy.occupiedCount + 1,
    };
    const occupied = new Set(candidateOccupancy.occupied.map((cell) => cell.cellId));
    return this.parkingCells.some(
      (parkingCell) =>
        !occupied.has(parkingCell) &&
        this.getBlockingCells(parkingCell, candidateOccupancy).length > 0,
    );
  }

  classifyBlockage(cellId: CellId, occupancy: OccupancyState): BlockageType {
    const blockerCount = this.getBlockingCells(cellId, occupancy).length;
    if (blockerCount === 0) return "none";
    return blockerCount === 1 ? "shallow" : "deep";
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

  private buildPath(
    floor: number,
    startRow: number,
    startColumn: number,
    targetRow: number,
    targetColumn: number,
    horizontalFirst: boolean,
  ): CellId[] {
    const coordinates: Array<[number, number]> = [];
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
    } else {
      moveVertical();
      moveHorizontal();
    }
    return coordinates
      .map(([pathRow, pathColumn]) => this.cellIdAt(floor, pathRow, pathColumn))
      .filter((pathCell): pathCell is CellId => pathCell !== null);
  }

  private cellIdAt(floor: number, row: number, column: number): CellId | null {
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
