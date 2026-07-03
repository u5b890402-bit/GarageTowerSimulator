import type {
  CellId,
  CellReservation,
  ElevatorDeckState,
  GarageCompletedOperation,
  GarageOperation,
  GarageOperationType,
  GarageStateSnapshot,
  PreparationPositionState,
  RawSimulationDataRecord,
  SimTime,
  VmrPath,
} from "../../domain/types.js";
import type { InterpolatedOperation } from "./types.js";

export function buildActivePathIndex(
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

export function groupDecksByFloor(decks: ElevatorDeckState[]): Map<number, ElevatorDeckState[]> {
  const result = new Map<number, ElevatorDeckState[]>();
  for (const deck of decks) {
    const list = result.get(deck.alignedFloor) ?? [];
    list.push(deck);
    result.set(deck.alignedFloor, list);
  }
  return result;
}

export function ensurePathEntry(
  map: Map<CellId, { path: string[]; current: string[]; destination: string[] }>,
  cellId: CellId,
): { path: string[]; current: string[]; destination: string[] } {
  const existing = map.get(cellId);
  if (existing) return existing;
  const entry = { path: [], current: [], destination: [] };
  map.set(cellId, entry);
  return entry;
}

export function interpolateOperation(operation: GarageOperation, time: SimTime): InterpolatedOperation {
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

export function pathLocationAt(path: VmrPath | undefined, progress: number): { current?: string; destination?: string } {
  if (!path || path.locations.length === 0) return {};
  const lastIndex = path.locations.length - 1;
  const index = Math.min(lastIndex, Math.max(0, Math.floor(progress * lastIndex)));
  return {
    ...(path.locations[index] ? { current: path.locations[index] } : {}),
    ...(path.locations[lastIndex] ? { destination: path.locations[lastIndex] } : {}),
  };
}

export function physicalPreparationPositionLabel(position: PreparationPositionState): string {
  const number = Number(/\d+$/.exec(position.id)?.[0] ?? 1);
  if (position.id.startsWith("IPP")) return `PP${5 - number}`;
  if (position.id.startsWith("OPP")) return `PP${3 - number}`;
  return position.id.replace(/^P/, "PP");
}

export function carriesVehicle(type: GarageOperationType): boolean {
  return (
    type === "ParkInbound" ||
    type === "LoadOutbound" ||
    type === "MoveBlocker" ||
    type === "RelocateBlocker" ||
    type === "IdleUnblock"
  );
}

export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

export function formatMeters(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function operationDeckIndex(operation: GarageOperation): number | null {
  return parseDeckIndex(operation.from) ?? parseDeckIndex(operation.to);
}

export function deckByLocation(decks: ElevatorDeckState[], location: string | undefined): ElevatorDeckState | undefined {
  const index = parseDeckIndex(location);
  return index === null ? undefined : decks[index];
}

export function parseDeckIndex(location: string | undefined): number | null {
  if (!location?.startsWith("D")) return null;
  const value = Number(location.slice(1));
  return Number.isFinite(value) && value >= 1 ? value - 1 : null;
}

export function deckLabel(operation: GarageOperation): string {
  const index = operationDeckIndex(operation);
  return index === null ? "VMR" : `D${index + 1}`;
}

export function elevatorPosition(location: string | undefined): number | null {
  if (!location?.startsWith("elevator-position-")) return null;
  const value = Number(location.slice("elevator-position-".length));
  return Number.isFinite(value) ? value : null;
}

export function inferDeckFromRotateGroup(
  decks: ElevatorDeckState[],
  group: string | undefined,
): ElevatorDeckState | undefined {
  if (!group) return undefined;
  const match = group.match(/D(\d+)/i);
  if (!match?.[1]) return undefined;
  const index = Number(match[1]) - 1;
  return decks[index];
}

export function reserveDestinationForOperation(
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

export function releaseReservationForCompletedOperation(
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

export function isCellReservationPurpose(
  type: GarageOperationType,
): type is CellReservation["purpose"] {
  return (
    type === "ParkInbound" ||
    type === "RelocateBlocker" ||
    type === "IdleUnblock"
  );
}

export function recordTime(record: RawSimulationDataRecord): SimTime {
  return record.kind === "second" ? record.record.time : record.t;
}

export function stringDetail(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
}

export function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  const clock = [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `day ${days + 1}, ${clock}` : clock;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
