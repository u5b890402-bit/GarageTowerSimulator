import type {
  GarageTelemetryRecord,
  GarageTickContext,
  SimulationResult,
  SimulationSecondRecord,
  SimulationSession,
  SimTime,
  TickResult,
} from "../domain/types.js";
import { BufferedGarageTelemetrySink } from "./telemetry.js";

export class SimulationEngine {
  async run(session: SimulationSession): Promise<SimulationResult> {
    await session.recorder.open(session);

    let time = 0;
    const endTime = session.config.simulation.durationSeconds;

    while (time <= endTime) {
      await this.runOneSecond(session, time);
      time += session.config.simulation.tickSeconds;
    }

    await session.recorder.close();

    return {
      sessionId: session.id,
      rawOutput: session.recorder.getOutputRef(),
      startedAt: 0,
      endedAt: endTime,
      finalSnapshot: session.garage.getSnapshot(),
    };
  }

  async runOneSecond(session: SimulationSession, time: SimTime): Promise<TickResult> {
    const beforeSnapshot = session.garage.getSnapshot();
    beforeSnapshot.time = time;

    const generatedEvents = session.demandGenerator.generateEventsAt(time, beforeSnapshot);
    const intakeResults = session.garage.submitEvents({
      time,
      events: generatedEvents,
      rng: session.intakeRandomSource,
    });
    session.demandGenerator.recordIntakeResults(intakeResults);

    const telemetry = new BufferedGarageTelemetrySink();
    const context: GarageTickContext = {
      time,
      deltaSeconds: session.config.simulation.tickSeconds,
      simulation: session.config.simulation,
      rng: session.garageRandomSource,
      telemetry,
    };

    const tickResult = session.garage.updateOneSecond(context);
    const afterSnapshot = session.garage.getSnapshot();
    afterSnapshot.time = time;
    const telemetryRecords = telemetry.flush();
    this.logDiagnostics(session, telemetryRecords);

    const record: SimulationSecondRecord = {
      sessionId: session.id,
      time,
      generatedEvents,
      intakeResults,
      tickResult,
      beforeSnapshot,
      afterSnapshot,
      telemetry: telemetryRecords,
    };

    await session.recorder.recordSecond(record);
    return { record };
  }

  private logDiagnostics(
    session: SimulationSession,
    telemetryRecords: GarageTelemetryRecord[],
  ): void {
    const diagnostics = session.config.simulation.diagnostics;
    if (diagnostics?.enabled !== true || diagnostics.console !== true) return;

    for (const record of telemetryRecords) {
      if (record.kind !== "warning") continue;
      if (record.value.message !== "PlanningDiagnostics") continue;
      const detail = record.value.detail ?? {};
      console.info("[parking-sim][diagnostics]", {
        time: record.value.time,
        ...detail,
      });
    }
  }
}
