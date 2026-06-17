import { readFile } from "node:fs/promises";
import type { ConfigLoader, SimulationConfig, ValidationResult } from "../domain/types.js";

export class JsonConfigLoader implements ConfigLoader {
  async load(path: string): Promise<SimulationConfig> {
    const text = await readFile(path, "utf8");
    const config = JSON.parse(text) as SimulationConfig;
    const validation = this.validate(config);
    if (!validation.valid) {
      throw new Error(`Invalid simulation config:\n${validation.errors.join("\n")}`);
    }
    return config;
  }

  validate(config: SimulationConfig): ValidationResult {
    const errors: string[] = [];

    if (!config.simulation) errors.push("simulation is required.");
    if (!config.demand) errors.push("demand is required.");
    if (!config.garage) errors.push("garage is required.");

    if (config.simulation) {
      if (config.simulation.durationSeconds <= 0) errors.push("simulation.durationSeconds must be positive.");
      if (config.simulation.tickSeconds <= 0) errors.push("simulation.tickSeconds must be positive.");
      if (!config.simulation.outputDir) errors.push("simulation.outputDir is required.");
      if (!config.simulation.rawOutputFile) errors.push("simulation.rawOutputFile is required.");
    }

    if (config.garage) {
      const { layout, elevator, preparationPositions } = config.garage;
      if (layout.rows <= 0 || layout.columns <= 0 || layout.floors <= 0) {
        errors.push("garage.layout rows, columns, and floors must be positive.");
      }
      if (elevator.deckCount <= 0) errors.push("garage.elevator.deckCount must be positive.");
      if (preparationPositions.inboundCount < 0 || preparationPositions.outboundCount < 0) {
        errors.push("preparation position counts cannot be negative.");
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
