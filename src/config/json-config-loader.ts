import { readFile } from "node:fs/promises";
import type { ConfigLoader, SimulationConfig, ValidationResult } from "../domain/types.js";
import { validateSimulationConfig } from "./validate-config.js";

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
    return validateSimulationConfig(config);
  }
}
