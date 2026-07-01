import type { CellId, OccupancyState } from "../domain/types.js";

export function effectiveOccupiedCellIds(occupancy: OccupancyState): Set<CellId> {
  return new Set(effectiveOccupiedCells(occupancy).map((cell) => cell.cellId));
}

export function effectiveOccupiedCells(
  occupancy: OccupancyState,
): Array<{ cellId: CellId; vehicleId: string }> {
  const byCell = new Map<CellId, { cellId: CellId; vehicleId: string }>();
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
