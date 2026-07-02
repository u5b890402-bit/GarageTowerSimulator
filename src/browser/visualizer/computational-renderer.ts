import type { SimulationConfig } from "../../domain/types.js";
import { escapeHtml, formatDuration } from "./operations.js";
import type { InterpolatedOperation, VisualizerFrame } from "./types.js";

export class HtmlComputationalStateRenderer {
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
