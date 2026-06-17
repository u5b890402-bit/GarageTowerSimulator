import type { SimulationConfig, SimulationResult, SimulationSession, SimTime, ThirtyDayReportSummary } from "../domain/types.js";
import { validateSimulationConfig } from "../config/validate-config.js";
import { buildReportFromRecords } from "../report/report-builder.js";
import { InMemorySimulationStateRecorder } from "../simulation/in-memory-recorder.js";
import { createSimulationSession } from "../simulation/session-factory.js";
import { SimulationEngine } from "../simulation/simulation-engine.js";

const exampleConfig: SimulationConfig = {
  simulation: {
    sessionName: "browser-3x3-baseline",
    startTime: "2026-06-01T00:00:00-07:00",
    durationSeconds: 3600,
    tickSeconds: 1,
    timezone: "America/Los_Angeles",
    seed: 12345,
    outputDir: "output",
    rawOutputFile: "browser-3x3-baseline.jsonl",
    revenuePolicy: {
      chargePerBillingBlock: 30,
      billingBlockMinutes: 30,
    },
    balkingPolicy: {
      startsAtQueueLength: 13,
      initialProbability: 0.5,
      probabilityStep: 0.1,
      certainAtQueueLength: 18,
    },
  },
  demand: {
    averageInboundPerDay: 1200,
    weekendMultiplier: 0.5,
    peakHour: 9,
    peakWindowHours: 2,
    peakShare: 0.5,
    parkingDuration: {
      minHours: 0.05,
      maxHours: 0.4,
      modeHours: 0.15,
    },
  },
  garage: {
    layout: {
      rows: 3,
      columns: 3,
      floors: 10,
      elevatorCell: 5,
      unavailableCells: [],
      streetFacing: "longSide",
    },
    elevator: {
      deckCount: 2,
      verticalSpeedMetersPerSecond: 0.9,
      floorHeightMeters: 2.7,
      deckRotationSeconds: 6,
    },
    vmr: {
      speedMetersPerSecond: 1.5,
      gripReleaseSeconds: 10,
    },
    preparationPositions: {
      inboundCount: 2,
      outboundCount: 2,
      kind: "parallel",
      mode: "designated",
      parallelClearSeconds: 60,
      sequentialClearSeconds: 80,
      doorSeconds: 5,
    },
  },
};

interface BrowserRunResult {
  rawJsonl: string;
  reportJson: string;
  result: SimulationResult;
  summary: ThirtyDayReportSummary["sum"];
}

let latestRun: BrowserRunResult | null = null;

export function startApp(): void {
  const configInput = getElement<HTMLTextAreaElement>("config-input");
  const runButton = getElement<HTMLButtonElement>("run-button");
  const loadExampleButton = getElement<HTMLButtonElement>("load-example-button");
  const rawDownloadButton = getElement<HTMLButtonElement>("download-raw-button");
  const reportDownloadButton = getElement<HTMLButtonElement>("download-report-button");

  configInput.value = JSON.stringify(exampleConfig, null, 2);

  loadExampleButton.addEventListener("click", () => {
    configInput.value = JSON.stringify(exampleConfig, null, 2);
    setStatus("Example configuration loaded.");
  });

  runButton.addEventListener("click", () => {
    void runFromConfig(configInput.value);
  });

  rawDownloadButton.addEventListener("click", () => {
    if (latestRun) downloadText("parking-tower-raw-output.jsonl", latestRun.rawJsonl, "application/x-ndjson");
  });

  reportDownloadButton.addEventListener("click", () => {
    if (latestRun) downloadText("parking-tower-report.json", latestRun.reportJson, "application/json");
  });
}

async function runFromConfig(configText: string): Promise<void> {
  setControlsDisabled(true);
  setStatus("Parsing configuration...");
  clearSummary();

  try {
    const config = JSON.parse(configText) as SimulationConfig;
    const validation = validateSimulationConfig(config);
    if (!validation.valid) {
      throw new Error(validation.errors.join("\n"));
    }

    const recorder = new InMemorySimulationStateRecorder();
    const session = createSimulationSession(config, recorder);
    const runner = new SimulationEngine();
    const result = await runWithProgress(runner, session);
    const report = buildReportFromRecords(recorder.getMetadata(), recorder.getRecords(), recorder.getOutputRef());

    const run: BrowserRunResult = {
      rawJsonl: recorder.toJsonl(),
      reportJson: JSON.stringify(report, null, 2),
      result,
      summary: report.thirtyDaySummary.sum,
    };
    latestRun = run;

    renderSummary(run);
    setStatus(`Simulation complete. ${report.daily.length} day row(s), ${report.thirtyDaySummary.sum.successfulActivities} successful activities.`);
    setDownloadButtonsEnabled(true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setControlsDisabled(false);
  }
}

async function runWithProgress(runner: SimulationEngine, session: SimulationSession): Promise<SimulationResult> {
  await session.recorder.open(session);
  let time: SimTime = 0;
  const endTime = session.config.simulation.durationSeconds;
  const tickSeconds = session.config.simulation.tickSeconds;
  let ticksSinceYield = 0;

  while (time <= endTime) {
    await runner.runOneSecond(session, time);
    time += tickSeconds;
    ticksSinceYield += 1;

    if (ticksSinceYield >= 1000) {
      ticksSinceYield = 0;
      setProgress(Math.min(100, Math.round((time / endTime) * 100)));
      await yieldToBrowser();
    }
  }

  await session.recorder.close();
  setProgress(100);

  return {
    sessionId: session.id,
    rawOutput: session.recorder.getOutputRef(),
    startedAt: 0,
    endedAt: endTime,
    finalSnapshot: session.garage.getSnapshot(),
  };
}

function renderSummary(run: BrowserRunResult): void {
  const summary = run.summary;
  const finalSnapshot = run.result.finalSnapshot;
  setText("metric-activities", String(summary.successfulActivities));
  setText("metric-occupancy", `${finalSnapshot.occupancy.occupiedCount}/${finalSnapshot.occupancy.totalParkingCells}`);
  setText("metric-inbound-wait", `${Math.round(summary.averageInboundWaitSeconds)}s`);
  setText("metric-outbound-wait", `${Math.round(summary.averageOutboundWaitSeconds)}s`);
  setText("metric-revenue", String(summary.totalRevenue));
  setText("metric-raw-size", `${Math.round(run.rawJsonl.length / 1024)} KB`);
}

function clearSummary(): void {
  for (const id of ["metric-activities", "metric-occupancy", "metric-inbound-wait", "metric-outbound-wait", "metric-revenue", "metric-raw-size"]) {
    setText(id, "-");
  }
  setProgress(0);
  setDownloadButtonsEnabled(false);
}

function setControlsDisabled(disabled: boolean): void {
  for (const id of ["run-button", "load-example-button", "config-input"]) {
    getElement<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>(id).disabled = disabled;
  }
}

function setDownloadButtonsEnabled(enabled: boolean): void {
  getElement<HTMLButtonElement>("download-raw-button").disabled = !enabled;
  getElement<HTMLButtonElement>("download-report-button").disabled = !enabled;
}

function setProgress(percent: number): void {
  getElement<HTMLProgressElement>("progress").value = percent;
  setText("progress-label", `${percent}%`);
}

function setStatus(message: string, isError = false): void {
  const element = getElement<HTMLElement>("status");
  element.textContent = message;
  element.dataset["state"] = isError ? "error" : "normal";
}

function setText(id: string, text: string): void {
  getElement<HTMLElement>(id).textContent = text;
}

function downloadText(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}
