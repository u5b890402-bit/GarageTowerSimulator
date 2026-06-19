import type { GarageFactory, GarageStrategySet, SimulationConfig, SimulationSession, SimulationStateRecorder } from "../domain/types.js";
import { SimpleGarageTowerSystem } from "../garage/simple-garage.js";
import { createGarageStrategies } from "../garage/strategy-registry.js";
import { SeededDemandGenerator } from "./demand-generator.js";
import { SeededRandomSource } from "./random.js";

class SimpleGarageFactory implements GarageFactory {
  createGarage(config: SimulationConfig["garage"], strategies: GarageStrategySet) {
    const garage = new SimpleGarageTowerSystem(strategies);
    garage.initialize(config);
    return garage;
  }
}

export function createSimulationSession(config: SimulationConfig, recorder: SimulationStateRecorder): SimulationSession {
  const strategies = createGarageStrategies(config.garage.strategies);
  const garage = new SimpleGarageFactory().createGarage(config.garage, strategies);
  const demandGenerator = new SeededDemandGenerator();
  demandGenerator.initialize(config.demand, config.simulation.seed);

  return {
    id: `${config.simulation.sessionName}-${config.simulation.seed}`,
    config,
    garage,
    demandGenerator,
    recorder,
    intakeRandomSource: new SeededRandomSource(config.simulation.seed + 1),
    garageRandomSource: new SeededRandomSource(config.simulation.seed + 2),
  };
}
