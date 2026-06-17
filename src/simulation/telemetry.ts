import type {
  GarageMetricRecord,
  GarageOperationRecord,
  GarageTelemetryRecord,
  GarageTelemetrySink,
  GarageWarningRecord,
} from "../domain/types.js";

export class BufferedGarageTelemetrySink implements GarageTelemetrySink {
  private readonly records: GarageTelemetryRecord[] = [];

  recordOperation(operation: GarageOperationRecord): void {
    this.records.push({ kind: "operation", value: operation });
  }

  recordMetric(metric: GarageMetricRecord): void {
    this.records.push({ kind: "metric", value: metric });
  }

  recordWarning(warning: GarageWarningRecord): void {
    this.records.push({ kind: "warning", value: warning });
  }

  flush(): GarageTelemetryRecord[] {
    const flushed = [...this.records];
    this.records.length = 0;
    return flushed;
  }
}
