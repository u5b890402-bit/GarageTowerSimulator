import { resolve } from "node:path";
import { DefaultSimulationRunner } from "./simulation/default-runner.js";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "config/example-3x3.json";
  const runner = new DefaultSimulationRunner();
  const session = await runner.initialize(resolve(configPath));
  const result = await runner.run(session);

  console.log(`Simulation complete: ${result.sessionId}`);
  console.log(`Raw output: ${result.rawOutput.path}`);
  console.log(`Final occupancy: ${result.finalSnapshot.occupancy.occupiedCount}/${result.finalSnapshot.occupancy.totalParkingCells}`);
  console.log(`Inbound completed: ${result.finalSnapshot.counters.inboundCompleted}`);
  console.log(`Outbound completed: ${result.finalSnapshot.counters.outboundCompleted}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
