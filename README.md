# Parking Tower Simulation

TypeScript simulation framework for experimenting with automated parking garage tower configurations.

The current implementation is intentionally simple. The main goal is to make the simulation runner, raw output format, and report generator stable enough that future garage implementations can be swapped in and compared against the same demand patterns.

## What Is Here

- A configurable simulation runner that advances the system one simulated second at a time.
- A seeded demand generator for inbound arrivals and outbound requests.
- A baseline garage implementation with inbound/outbound queues, preparation positions, parking/retrieval operations, elevator/VMR counters, and snapshots.
- A compact JSONL raw output format for long runs.
- A report generator that answers the metrics requested in `Requirements.docx`.

## Project Layout

```text
config/
  example-3x3.json          Example simulation configuration

src/
  browser/                  Browser UI entrypoint
  config/                   Config loading and validation
  domain/                   Core interfaces and shared types
  garage/                   Baseline garage implementation and strategies
  report/                   Raw output reader, metrics aggregator, report generator
  simulation/               Runner, demand generator, recorder, RNG, telemetry
  run-simulation.ts         Simulation CLI entrypoint
  run-report.ts             Report CLI entrypoint

output/                     Generated raw outputs and reports
public/                     Static browser UI
dist/                       Compiled JavaScript output
```

## Commands

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Build the static browser app:

```bash
npm run build:browser
```

Then open [public/index.html](public/index.html) in a browser.

Run the example simulation:

```bash
npm run simulate
```

Run a simulation with a specific configuration file:

```bash
npm run build
node dist/run-simulation.js path/to/config.json
```

Or pass the config path through npm with `--`:

```bash
npm run simulate -- path/to/config.json
```

Generate the example report from the simulation output:

```bash
npm run report
```

Generate a report from a specific raw output file:

```bash
npm run build
node dist/run-report.js output/raw-output.jsonl output/report.json
```

Or pass those paths through npm with `--`:

```bash
npm run report -- output/raw-output.jsonl output/report.json
```

Run the full integration path:

```bash
npm run test:integration
```

That command builds the project, runs the example simulation, and generates a report.

Check the browser bundle build:

```bash
npm run test:browser-build
```

## Browser App

The browser app is intended for non-developer use. It runs the TypeScript simulation engine in the browser and does not require the user to run CLI commands after the static files have been prepared.

Build it:

```bash
npm run build:browser
```

Open:

```text
public/index.html
```

The browser app lets the user:

- Load the example configuration.
- Edit configuration JSON directly.
- Run a simulation.
- See a summary of key report metrics.
- Download the compact raw JSONL output.
- Download the generated JSON report.

The browser build emits:

```text
public/simulator.bundle.js
```

That bundle is compiled from the same TypeScript core used by the Node CLI. The browser path uses an in-memory recorder instead of filesystem writes, then downloads raw output and report files through the browser.

## Configuration

The example config is [config/example-3x3.json](config/example-3x3.json).

The simulation CLI accepts the config path as its first argument:

```bash
node dist/run-simulation.js config/example-3x3.json
```

If no config path is provided, it defaults to:

```text
config/example-3x3.json
```

The npm script `npm run simulate` is a convenience wrapper around the simulation CLI:

```bash
npm run build && node dist/run-simulation.js
```

To pass arguments through an npm script, put them after `--`:

```bash
npm run simulate -- config/my-scenario.json
```

For a new configuration, copy the example file, edit it, build, and pass the new path:

```bash
cp config/example-3x3.json config/my-scenario.json
npm run build
node dist/run-simulation.js config/my-scenario.json
```

The raw output destination is controlled by the config itself:

```json
{
  "simulation": {
    "outputDir": "output",
    "rawOutputFile": "example-3x3-baseline.jsonl"
  }
}
```

So two configs should usually use different `rawOutputFile` values if you want to keep both results.

Top-level sections:

- `simulation`: session timing, seed, output file, revenue policy, balking policy.
- `demand`: random inbound/outbound demand assumptions.
- `garage`: layout, elevator, VMR, and preparation-position configuration.

The simulation uses a seeded random source. Given the same config and seed, the same demand pattern should be generated.

## Raw Output Format

Simulation raw output is written as compact JSONL.

Record types:

- `metadata`: session id, full config, raw schema details.
- `events`: generated events and intake results when inbound/outbound demand occurs.
- `operations`: started/completed garage operations and telemetry when mechanical work changes.
- `state`: compact state summary when occupancy, queues, or counters change.
- `checkpoint`: full garage snapshot every 300 simulated seconds.

This avoids writing a full before/after snapshot every simulated second. In the current one-hour example, raw output is about 119 KB instead of about 11 MB.

## Reports

The report generator reads the raw JSONL output and writes JSON containing:

```bash
node dist/run-report.js <raw-output-path> <report-output-path>
```

If no paths are provided, it defaults to:

```text
Raw output: output/example-3x3-baseline.jsonl
Report:     output/example-3x3-report.json
```

You can also use npm argument forwarding:

```bash
npm run report -- output/my-scenario.jsonl output/my-scenario-report.json
```

- Daily rows.
- A 30-day sum and average summary.
- Successful activities.
- Vehicles still parked at day end.
- Inbound and outbound wait times.
- Morning/evening peak wait times.
- Longest wait times.
- Largest queue lengths.
- Balking counts and rates.
- Maximum occupancy.
- Induced inbound and idle unblocking counters.
- Parking hours, billable hours, revenue.
- Elevator floors passed and VMR distance moved.

Some advanced fields are currently zero because the baseline garage does not yet implement induced inbound vehicles, idle unblocking, or downward-trip placement logic.

## Design Direction

The simulator should remain independent from garage implementation details. The important boundary is:

```ts
garage.submitEvents(...);
garage.updateOneSecond(...);
garage.getSnapshot();
```

The simulation owns time, random demand, and raw output. The garage owns queues, physical state, planning, and mechanical progress. Future work can improve placement, retrieval, elevator-trip planning, PP assignment, and unblocking strategies without rewriting the runner or report generator.

## Current Limitations

- The garage implementation is a baseline, not the final operating algorithm.
- Elevator and VMR motion are simplified into one active operation at a time.
- The report generator is JSON-only.
- The example config runs one simulated hour, not the full 30-day requirement.
- Generated `dist/` and `output/` files are build/run artifacts.
