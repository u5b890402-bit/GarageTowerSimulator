import { writeFile } from "node:fs/promises";
import type { RawSimulationOutputRef, ReportConfig, ReportGenerator, SimulationReport } from "../domain/types.js";
import { JsonlRawSimulationReader } from "./jsonl-raw-simulation-reader.js";
import { buildReportFromRecords } from "./report-builder.js";

export class JsonReportGenerator implements ReportGenerator {
  async generate(rawOutput: RawSimulationOutputRef, _config: ReportConfig): Promise<SimulationReport> {
    const reader = new JsonlRawSimulationReader(rawOutput);
    const metadata = await reader.readMetadata();
    const records = await reader.readRecords();
    return buildReportFromRecords(metadata, records, rawOutput);
  }

  async write(report: SimulationReport, destination: string): Promise<void> {
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}
