import { readFile } from "node:fs/promises";
import type {
  RawSimulationDataRecord,
  RawSimulationMetadata,
  RawSimulationOutputRef,
  RawSimulationReader,
} from "../domain/types.js";

type RawOutputLine = RawSimulationMetadata | RawSimulationDataRecord;

export class JsonlRawSimulationReader implements RawSimulationReader {
  private lines: RawOutputLine[] | null = null;

  constructor(private readonly rawOutput: RawSimulationOutputRef) {}

  async readMetadata(): Promise<RawSimulationMetadata> {
    const lines = await this.readLines();
    const metadata = lines.find((line): line is RawSimulationMetadata => line.kind === "metadata");
    if (!metadata) {
      throw new Error(`Raw output does not contain metadata: ${this.rawOutput.path}`);
    }
    return metadata;
  }

  async readRecords(): Promise<RawSimulationDataRecord[]> {
    const lines = await this.readLines();
    return lines.filter((line): line is RawSimulationDataRecord => line.kind !== "metadata");
  }

  private async readLines(): Promise<RawOutputLine[]> {
    if (this.lines) return this.lines;
    const text = await readFile(this.rawOutput.path, "utf8");
    this.lines = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RawOutputLine);
    return this.lines;
  }
}
