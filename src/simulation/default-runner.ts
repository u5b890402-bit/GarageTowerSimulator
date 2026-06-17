import type {
  GarageFactory,
  GarageStrategySet,
  GarageTickContext,
  SimulationResult,
  SimulationRunner,
  SimulationSecondRecord,
  SimulationSession,
  SimTime,
  TickResult,
} from "../domain/types.js";
import { JsonConfigLoader } from "../config/json-config-loader.js";
import { SimpleGarageTowerSystem } from "../garage/simple-garage.js";
import { createBaselineStrategies } from "../garage/strategies.js";
import { SeededDemandGenerator } from "./demand-generator.js";
import { JsonlSimulationStateRecorder } from "./jsonl-recorder.js";
import { SeededRandomSource } from "./random.js";
import { BufferedGarageTelemetrySink } from "./telemetry.js";

class SimpleGarageFactory implements GarageFactory {
  createGarage(config: SimulationSession["config"]["garage"], strategies: GarageStrategySet) {
    const garage = new SimpleGarageTowerSystem(strategies);
    garage.initialize(config);
    return garage;
  }
}

export class DefaultSimulationRunner implements SimulationRunner {
  private readonly configLoader = new JsonConfigLoader();
  private readonly garageFactory = new SimpleGarageFactory();

  async initialize(configPath: string): Promise<SimulationSession> {
    const config = await this.configLoader.load(configPath);
    const strategies = createBaselineStrategies();
    const garage = this.garageFactory.createGarage(config.garage, strategies);
    const demandGenerator = new SeededDemandGenerator();
    demandGenerator.initialize(config.demand, config.simulation.seed);

    return {
      id: `${config.simulation.sessionName}-${config.simulation.seed}`,
      config,
      garage,
      demandGenerator,
      recorder: new JsonlSimulationStateRecorder(),
      intakeRandomSource: new SeededRandomSource(config.simulation.seed + 1),
      garageRandomSource: new SeededRandomSource(config.simulation.seed + 2),
    };
  }

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
