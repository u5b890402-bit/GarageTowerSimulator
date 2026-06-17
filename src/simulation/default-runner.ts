import type { SimulationSession } from "../domain/types.js";
import { JsonConfigLoader } from "../config/json-config-loader.js";
import { JsonlSimulationStateRecorder } from "./jsonl-recorder.js";
import { createSimulationSession } from "./session-factory.js";
import { SimulationEngine } from "./simulation-engine.js";

export class DefaultSimulationRunner extends SimulationEngine {
  private readonly configLoader = new JsonConfigLoader();

  async initialize(configPath: string): Promise<SimulationSession> {
    const config = await this.configLoader.load(configPath);
    return createSimulationSession(config, new JsonlSimulationStateRecorder());
  }
}
