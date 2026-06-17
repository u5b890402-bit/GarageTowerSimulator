import type {
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

    const record: SimulationSecondRecord = {
      sessionId: session.id,
      time,
      generatedEvents,
      intakeResults,
      tickResult,
      beforeSnapshot,
      afterSnapshot,
      telemetry: telemetry.flush(),
    };

    await session.recorder.recordSecond(record);
    return { record };
  }
}
