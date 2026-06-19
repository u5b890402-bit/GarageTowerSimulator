import type {
  CellId,
  GarageConfig,
  LocationId,
  OccupancyState,
  VmrPath,
} from "../domain/types.js";
import { GridGarageLayout } from "./grid-layout.js";

interface Coordinate {
  row: number;
  column: number;
}

export interface VmrAccessPlan {
  path: VmrPath;
  blockerCells: CellId[];
}

export class GridVmrPathPlanner {
  private readonly elevatorCoordinate: Coordinate;

  constructor(
    private readonly config: GarageConfig,
    private readonly layout: GridGarageLayout,
  ) {
    const cell = config.layout.elevatorCell;
    this.elevatorCoordinate = {
      row: Math.floor((cell - 1) / config.layout.columns) + 1,
      column: ((cell - 1) % config.layout.columns) + 1,
    };
  }

  findAccessPlan(cellId: CellId, occupancy: OccupancyState): VmrAccessPlan | null {
    const path = this.findPath(cellId, occupancy, true);
    if (!path) return null;
    const occupied = new Set(occupancy.occupied.map((cell) => cell.cellId));
    return {
      path,
      blockerCells: path.cells.filter(
        (pathCell) => pathCell !== cellId && occupied.has(pathCell),
      ),
    };
  }

  findClearPathFromElevator(
    cellId: CellId,
    occupancy: OccupancyState,
  ): VmrPath | null {
    const path = this.findPath(cellId, occupancy, false);
    if (!path) return null;
    return this.isClear(path, occupancy, cellId, false)
      ? this.roundTrip(path)
      : null;
  }

  findClearPathToElevator(
    cellId: CellId,
    occupancy: OccupancyState,
  ): VmrPath | null {
    const outward = this.findPath(cellId, occupancy, false);
    if (!outward || !this.isClear(outward, occupancy, cellId, true)) return null;
    return this.roundTrip(outward);
  }

  isClear(
    path: VmrPath,
    occupancy: OccupancyState,
    endpointCell: CellId,
    endpointMayBeOccupied: boolean,
  ): boolean {
    const occupied = new Set(occupancy.occupied.map((cell) => cell.cellId));
    return path.cells.every(
      (cellId) =>
        !occupied.has(cellId) ||
        (cellId === endpointCell && endpointMayBeOccupied),
    );
  }

  pathsConflict(a: VmrPath, b: VmrPath): boolean {
    if (a.floor !== b.floor) return false;
    const locations = new Set(a.locations);
    return b.locations.some((location) => locations.has(location));
  }

  private findPath(
    cellId: CellId,
    occupancy: OccupancyState,
    minimizeBlockers: boolean,
  ): VmrPath | null {
    const target = this.layout.getCellGeometry(cellId);
    const floor = target.floor;
    const startKey = this.coordinateKey(this.elevatorCoordinate);
    const targetKey = this.coordinateKey(target);
    const occupied = new Set(occupancy.occupied.map((cell) => cell.cellId));
    const frontier: Array<{ key: string; blockers: number; steps: number }> = [
      { key: startKey, blockers: 0, steps: 0 },
    ];
    const best = new Map<string, { blockers: number; steps: number }>([
      [startKey, { blockers: 0, steps: 0 }],
    ]);
    const previous = new Map<string, string>();

    while (frontier.length > 0) {
      frontier.sort(
        (a, b) =>
          a.blockers - b.blockers ||
          a.steps - b.steps ||
          a.key.localeCompare(b.key),
      );
      const current = frontier.shift();
      if (!current) break;
      if (current.key === targetKey) {
        return this.buildPath(floor, current.key, previous);
      }

      for (const neighbor of this.neighbors(current.key)) {
        const neighborCell = this.cellAt(floor, neighbor);
        if (neighbor !== targetKey && neighborCell === null) continue;
        if (
          !minimizeBlockers &&
          neighbor !== targetKey &&
          neighborCell &&
          occupied.has(neighborCell)
        ) {
          continue;
        }
        const blockerCost =
          minimizeBlockers && neighborCell && occupied.has(neighborCell) ? 1 : 0;
        const next = {
          blockers: current.blockers + blockerCost,
          steps: current.steps + 1,
        };
        const known = best.get(neighbor);
        if (
          known &&
          (known.blockers < next.blockers ||
            (known.blockers === next.blockers && known.steps <= next.steps))
        ) {
          continue;
        }
        best.set(neighbor, next);
        previous.set(neighbor, current.key);
        frontier.push({ key: neighbor, ...next });
      }
    }
    return null;
  }

  private buildPath(
    floor: number,
    targetKey: string,
    previous: Map<string, string>,
  ): VmrPath {
    const keys = [targetKey];
    let cursor = targetKey;
    while (previous.has(cursor)) {
      cursor = previous.get(cursor) as string;
      keys.push(cursor);
    }
    keys.reverse();
    const locations: LocationId[] = keys.map((key) =>
      key === this.coordinateKey(this.elevatorCoordinate)
        ? this.elevatorLocation(floor)
        : (this.cellAt(floor, key) as CellId),
    );
    const cells = locations.filter((location): location is CellId =>
      location.startsWith("f"),
    );
    return {
      floor,
      locations,
      cells,
      distanceMeters: Math.max(0, locations.length - 1) * 3,
    };
  }

  private roundTrip(path: VmrPath): VmrPath {
    const returnLocations = [...path.locations].reverse().slice(1);
    const locations = [...path.locations, ...returnLocations];
    return {
      ...path,
      locations,
      cells: locations.filter((location): location is CellId =>
        location.startsWith("f"),
      ),
      distanceMeters: path.distanceMeters * 2,
    };
  }

  private neighbors(key: string): string[] {
    const coordinate = this.parseCoordinate(key);
    return [
      { row: coordinate.row - 1, column: coordinate.column },
      { row: coordinate.row + 1, column: coordinate.column },
      { row: coordinate.row, column: coordinate.column - 1 },
      { row: coordinate.row, column: coordinate.column + 1 },
    ]
      .filter(
        (candidate) =>
          candidate.row >= 1 &&
          candidate.row <= this.config.layout.rows &&
          candidate.column >= 1 &&
          candidate.column <= this.config.layout.columns,
      )
      .map((candidate) => this.coordinateKey(candidate));
  }

  private cellAt(floor: number, key: string): CellId | null {
    const coordinate = this.parseCoordinate(key);
    const cellNumber =
      (coordinate.row - 1) * this.config.layout.columns + coordinate.column;
    if (cellNumber === this.config.layout.elevatorCell) return null;
    if (this.config.layout.unavailableCells.includes(cellNumber)) return null;
    return `f${floor}c${cellNumber}`;
  }

  private elevatorLocation(floor: number): LocationId {
    return `f${floor}:elevator`;
  }

  private coordinateKey(coordinate: Coordinate): string {
    return `${coordinate.row},${coordinate.column}`;
  }

  private parseCoordinate(key: string): Coordinate {
    const [row, column] = key.split(",").map(Number);
    return { row: row ?? 0, column: column ?? 0 };
  }
}
