import type {
  CellId,
  GarageConfig,
  GarageOperation,
  GarageStateSnapshot,
  LayoutConfig,
  PreparationPositionState,
} from "../../domain/types.js";
import { drawArrowHead, drawStackedText, fillRoundedRect } from "./canvas-drawing.js";
import {
  insetRectByPixels,
  leftHalf,
  rectCenter,
  rectFromCenter,
  rightHalf,
  samplePolyline,
  unionRects,
} from "./geometry.js";
import {
  carriesVehicle,
  deckLabel,
  formatMeters,
  groupDecksByFloor,
  operationDeckIndex,
  physicalPreparationPositionLabel,
  shortId,
} from "./operations.js";
import {
  parkingCellLengthMeters,
  parkingCellWidthMeters,
  vehicleLengthMeters,
  vehicleWidthMeters,
  vmrLengthMeters,
  vmrWidthMeters,
} from "./types.js";
import type { CanvasGarageGeometry, Point, Rect, VisualizerFrame } from "./types.js";

export class CanvasPhysicalStateRenderer {
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
    fillRoundedRect(context, 0, 0, geometry.width, geometry.height, 8);
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
    fillRoundedRect(
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
      drawStackedText(context, physicalPreparationPositionLabel(position), rect.x + 9, rect.y + 20, 15);
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
      drawArrowHead(context, points[points.length - 2], points[points.length - 1], color);
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
        fillRoundedRect(context, deckRect.x, deckRect.y, deckRect.width, deckRect.height, 5);
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
    fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 6);
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
    fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
    context.fillStyle = "#ffffff";
    context.font = "700 10px Arial, Helvetica, sans-serif";
    context.fillText(`V ${shortId(vehicleId)}`, rect.x + 5, rect.y + Math.min(rect.height - 5, 14));
  }

  private drawVmr(context: CanvasRenderingContext2D, rect: Rect, label: string): void {
    context.fillStyle = "#0f7a6c";
    fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
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
}
