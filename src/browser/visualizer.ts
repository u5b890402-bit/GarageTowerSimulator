import { HtmlComputationalStateRenderer } from "./visualizer/computational-renderer.js";
import { clamp, formatDuration } from "./visualizer/operations.js";
import { CanvasPhysicalStateRenderer } from "./visualizer/physical-renderer.js";
import { JsonlVisualizerRawOutputLoader } from "./visualizer/raw-output-loader.js";
import { CheckpointReplayEngine } from "./visualizer/replay-engine.js";
import { playbackSecondsPerSecond } from "./visualizer/types.js";
import type { VisualizerDataSet } from "./visualizer/types.js";

export function startVisualizer(): void {
  const root = document.querySelector<HTMLElement>("[data-visualizer-root]");
  if (!root) return;
  new BrowserVisualizerApp(root).start();
}

class BrowserVisualizerApp {
  private dataSet: VisualizerDataSet | null = null;
  private replayEngine: CheckpointReplayEngine | null = null;
  private isPlaying = false;
  private lastAnimationTime = 0;
  private currentTime = 0;
  private animationHandle = 0;

  private readonly loader = new JsonlVisualizerRawOutputLoader();
  private readonly physicalRenderer = new CanvasPhysicalStateRenderer();
  private readonly computationalRenderer = new HtmlComputationalStateRenderer();

  private readonly fileInput: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly timeReadout: HTMLElement;
  private readonly physicalView: HTMLElement;
  private readonly computationalView: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    this.fileInput = requiredElement(root, "#raw-output-input", HTMLInputElement);
    this.status = requiredElement(root, "#visualizer-status", HTMLElement);
    this.playButton = requiredElement(root, "#play-button", HTMLButtonElement);
    this.pauseButton = requiredElement(root, "#pause-button", HTMLButtonElement);
    this.slider = requiredElement(root, "#time-slider", HTMLInputElement);
    this.timeReadout = requiredElement(root, "#time-readout", HTMLElement);
    this.physicalView = requiredElement(root, "#physical-state-view", HTMLElement);
    this.computationalView = requiredElement(root, "#computational-state-view", HTMLElement);
  }

  start(): void {
    this.fileInput.addEventListener("change", () => void this.loadSelectedFile());
    this.playButton.addEventListener("click", () => this.play());
    this.pauseButton.addEventListener("click", () => this.pause());
    this.slider.addEventListener("input", () => {
      this.pause();
      this.seek(Number(this.slider.value));
    });
    this.setControls(false);
    this.setStatus("Select a raw JSONL output file to inspect.", "normal");
  }

  private async loadSelectedFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (!file) return;

    this.pause();
    this.setStatus(`Loading ${file.name}...`, "normal");

    try {
      this.dataSet = await this.loader.load(file);
      this.replayEngine = new CheckpointReplayEngine(this.dataSet);
      this.currentTime = 0;
      this.slider.min = "0";
      this.slider.max = String(this.dataSet.durationSeconds);
      this.slider.step = "1";
      this.slider.value = "0";
      this.setControls(true);
      this.renderCurrentFrame();
      this.setStatus(
        `Loaded ${file.name}. ${this.dataSet.records.length.toLocaleString()} records, ${this.dataSet.checkpoints.length.toLocaleString()} checkpoints.`,
        "normal",
      );
    } catch (error) {
      this.dataSet = null;
      this.replayEngine = null;
      this.setControls(false);
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private play(): void {
    if (!this.replayEngine || this.isPlaying) return;
    this.isPlaying = true;
    this.lastAnimationTime = performance.now();
    this.animationHandle = requestAnimationFrame((timestamp) => this.advance(timestamp));
    this.setControls(true);
  }

  private pause(): void {
    if (this.animationHandle) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = 0;
    }
    this.isPlaying = false;
    this.setControls(Boolean(this.replayEngine));
  }

  private advance(timestamp: number): void {
    if (!this.isPlaying || !this.dataSet) return;
    const elapsedSeconds = (timestamp - this.lastAnimationTime) / 1000;
    this.lastAnimationTime = timestamp;
    const nextTime = Math.min(
      this.dataSet.durationSeconds,
      this.currentTime + elapsedSeconds * playbackSecondsPerSecond,
    );
    this.seek(nextTime);
    if (nextTime >= this.dataSet.durationSeconds) {
      this.pause();
      return;
    }
    this.animationHandle = requestAnimationFrame((nextTimestamp) => this.advance(nextTimestamp));
  }

  private seek(time: number): void {
    if (!this.dataSet) return;
    this.currentTime = clamp(time, 0, this.dataSet.durationSeconds);
    this.slider.value = String(Math.round(this.currentTime));
    this.renderCurrentFrame();
  }

  private renderCurrentFrame(): void {
    if (!this.replayEngine || !this.dataSet) return;
    const frame = this.replayEngine.getFrameAt(Math.round(this.currentTime));
    this.timeReadout.textContent = formatDuration(frame.time);
    this.physicalRenderer.render(this.physicalView, frame, this.dataSet.metadata.config.garage);
    this.computationalRenderer.render(this.computationalView, frame, this.dataSet.metadata.config);
  }

  private setControls(enabled: boolean): void {
    this.playButton.disabled = !enabled || this.isPlaying;
    this.pauseButton.disabled = !enabled || !this.isPlaying;
    this.slider.disabled = !enabled;
  }

  private setStatus(message: string, state: "normal" | "error"): void {
    this.status.textContent = message;
    this.status.dataset.state = state;
  }
}

function requiredElement<T extends HTMLElement>(
  root: ParentNode,
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing required visualizer element: ${selector}`);
  }
  return element;
}
