# Parking Tower Simulation

TypeScript simulation framework for experimenting with automated parking garage tower configurations.

The current implementation is intentionally simple. The main goal is to make the simulation runner, raw output format, and report generator stable enough that future garage implementations can be swapped in and compared against the same demand patterns.

## What Is Here

- A configurable simulation runner that advances the system one simulated second at a time.
- A seeded demand generator for inbound arrivals and outbound requests.
- A physical garage state machine with queues, preparation positions, elevator decks, VMRs, blocker buffering, and timed trips.
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
The user-friendly configuration and report guide is available at [public/documentation.html](public/documentation.html).

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

Run the physical-system smoke tests:

```bash
npm run test:physical
```

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

The browser app also links to:

```text
public/documentation.html
public/visualizer.html
```

The browser app lets the user:

- Load the example configuration.
- Save the current configuration as a JSON file.
- Load a saved configuration JSON file.
- Select registered garage strategies from dropdowns.
- Edit configuration JSON directly.
- Run a simulation.
- See a summary of key report metrics.
- Download the compact raw JSONL output.
- Download the generated JSON report.
- Open the visualizer and load a raw JSONL output file to inspect the simulated garage state tick by tick.

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
- `garage`: layout, elevator, VMR, preparation-position, and strategy configuration.

The simulation uses a seeded random source. Given the same config and seed, the same demand pattern should be generated.

Demand generation applies `weekendMultiplier` to the expected inbound total on Saturdays and Sundays, using `simulation.startTime` and `simulation.timezone` to determine the calendar day.

Each accepted inbound arrival is assigned a scheduled outbound time. If that time arrives before the vehicle has reached a parking cell, the outbound request remains pending and is emitted as soon as the vehicle is parked. Scheduled outbound requests are canceled when the corresponding inbound arrival balks or is rejected because the garage is full.

### Diagnostics

Planning diagnostics can be enabled from the same configuration file in both runtimes:

```json
{
  "simulation": {
    "diagnostics": {
      "enabled": true,
      "console": true,
      "planningSampleIntervalSeconds": 60
    }
  }
}
```

When enabled, the simulator writes `PlanningDiagnostics` telemetry into the raw JSONL output. With `console: true`, the same summaries are also printed to the Node terminal or the browser developer console. The diagnostics summarize trip-planning attempts, no-plan attempts, idle-unblocking attempts, failed idle-unblock cache hits, full-occupancy attempts, and average/max planning time for each sampling window.

### Strategy Selection

Garage strategy implementations are selected with stable IDs under `garage.strategies`:

```json
{
  "garage": {
    "strategies": {
      "placement": {
        "type": "lowest-access-cost"
      },
      "retrieval": {
        "type": "simple-retrieval"
      },
      "tripPlanner": {
        "type": "baseline-physical"
      },
      "preparationPositions": {
        "type": "fixed-assignment"
      },
      "unblocking": {
        "type": "idle-after-10-minutes"
      }
    }
  }
}
```

Available strategy IDs:

| Category | ID | Behavior |
| --- | --- | --- |
| Placement | `lowest-access-cost` | Chooses the empty cell with the lowest estimated access cost. |
| Placement | `first-available` | Chooses the first empty cell in layout order. |
| Retrieval | `simple-retrieval` | Baseline retrieval classification and cost estimate. |
| Trip planner | `baseline-physical` | Builds complete physical trips with deck assignments, blocker relocation, explicit VMR paths, elevator stops, and PP transfers. |
| Preparation positions | `fixed-assignment` | Keeps configured inbound/outbound assignments fixed. |
| Unblocking | `idle-after-10-minutes` | Relocates blockers after ten minutes without normal demand. |
| Unblocking | `disabled` | Does not initiate idle unblocking. |

The `strategies` section is optional for backward compatibility. When omitted, the defaults shown above are used.

Unknown strategy IDs and unsupported options are rejected before the simulation starts. Strategy implementations are selected from an explicit registry; config files cannot load arbitrary JavaScript files or class names.

## Physical Model

Garage work is executed as elevator trips composed of timed action groups:

- The configured `ElevatorTripPlanner` receives a read-only garage snapshot and returns a declarative trip plan.
- The garage validates and executes the plan; the planner never mutates physical garage state.
- Preparation-position doors close before loading and reopen for the next batch.
- Elevator decks rotate between street and garage orientation.
- Each deck has its own VMR and vehicle slot.
- VMRs on different decks can work concurrently when their decks align with the required floors.
- Every parking-cell transfer uses an explicit, occupancy-aware grid path from the elevator deck to the cell and back.
- The path planner chooses a route with the fewest blocking vehicles, then plans their removal before the requested transfer.
- A transfer cannot start if an intermediate cell is occupied. Concurrent VMR actions on the same floor are also rejected when their paths overlap.
- The elevator only moves after all VMR tasks finish and all VMRs are back on their home decks.
- Multi-deck alignment is explicit: lower decks align to consecutive lower floors.
- Blocked retrievals buffer blocking vehicles on decks, retrieve the requested vehicle, and relocate blockers to accessible cells.
- Outbound vehicles remain on decks until an outbound PP is available and unloading finishes.
- Every trip returns the elevator to its floor-1 home position with empty, garage-oriented decks.
- After ten quiet minutes, the default unblocking strategy relocates blockers one at a time.

Placement rejects choices that would create an inaccessible empty parking cell. The physical smoke tests check this invariant after parking, blocked retrieval, full-capacity retrieval, and idle unblocking.

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
- Inbound driver wait from generated arrival until the vehicle occupies an inbound PP.
- End-to-end inbound processing time from generated arrival until parking-cell placement.
- Outbound wait from generated request until the vehicle reaches an outbound PP.
- Morning/evening peak wait times.
- Longest wait times.
- Largest queue lengths.
- Balking counts and rates.
- Maximum occupancy.
- Induced inbound and idle unblocking counters.
- Parking hours, billable hours, revenue.
- Elevator floors passed and VMR distance moved.

## Design Direction

The simulator should remain independent from garage implementation details. The important boundary is:

```ts
garage.submitEvents(...);
garage.updateOneSecond(...);
garage.getSnapshot();
```

The simulation owns time, random demand, and raw output. The trip planner owns trip construction. The garage owns queues, physical state validation, and mechanical execution. Future planners can change deck assignment, stop ordering, blocker handling, and inbound/outbound batching without rewriting the runner, garage executor, or report generator.

## Remaining Gaps

The simulator now has explicit queues, preparation positions, doors, rotating elevator decks, deck-mounted VMRs, occupancy-aware VMR paths, blocker buffering, idle unblocking, configurable strategies, and compact raw output. The remaining work is primarily fidelity and optimization rather than basic physical feasibility.

### Garage Strategies

- Placement uses a local access-cost heuristic. It does not calculate the requirement's Minimize Total Retrieving Time (MTRT) objective over all parked vehicles after each candidate placement.
- The baseline trip planner is greedy. It does not search alternative trip combinations to minimize total trip time.
- Elevator stops are generated in operation order and can reverse direction more than required. The requirement calls for one upward sweep to the highest required position followed by one downward sweep to floor 1.
- Retrievals are considered mainly in queue order. The required `deep blocked > shallow blocked > direct` priority and special carry-over priority for postponed blocked requests are not implemented.
- Blockers are reserved and moved safely, but induced inbound vehicles are not modeled as occupying virtual deck capacity when the elevator leaves floor 1. The planner therefore cannot apply the requirement's induced-vehicle reduction rules.
- The planner usually executes parking-cell VMR actions sequentially. It does not yet group all compatible actions that could run concurrently on different aligned floors.
- Inbound vehicles are generally loaded before garage-floor work and placed after outbound retrieval work. The planner does not interleave inbound placement and outbound retrieval according to deck availability or upward/downward position.
- The `RetrievalStrategy`, `PreparationPositionPolicy`, and `UnblockingStrategy.planUnblocking()` interfaces exist, but the baseline trip planner does not yet delegate all corresponding decisions to them.

### Preparation Positions

- Only fixed inbound/outbound PP assignment is implemented. Dynamic reassignment for triple-deck 3x3 and 2x3 towers at outbound queue thresholds 3 and 6 is missing.
- Sequential PPs use simplified timing and inbound fill ordering. Physical blocking order for outbound sequential PPs is not modeled.
- PP placement is represented by numbered positions with estimated transfer distance, not explicit floor geometry and VMR paths.
- The shortcut in which a VMR moves directly from an outbound PP to an inbound PP is not implemented.
- The special 2x3 narrow-site behavior that uses `f1c8` as a potential outbound PP is not implemented.
- PP batching and doors are modeled, but batch waiting policy and door timing are simplified.

### Layout And Motion

- The generic grid can represent 2x3, 3x3, and 5x5 layouts, but there are no validated configuration presets enforcing required unavailable cells, deck counts, PP arrangements, or penthouse/basement clearance for each tower type.
- `streetFacing` is configuration metadata only; it does not currently change PP geometry, deck orientation requirements, or movement distance.
- VMR paths use a grid with a uniform 3-meter edge cost. Vehicle dimensions, acceleration, turning time, clearance, continuous-space geometry, and PP-to-deck paths are not modeled.
- VMR battery charging, wireless job delivery, maintenance facilities, and emergency spaces are outside the current simulation.
- Idle unblocking moves one blocker per trip and may repeat until no blocked route remains. A newly arriving request does not interrupt an unblocking trip already in progress.

### Demand Model

- Inbound arrivals use a per-second Poisson process with a configured daily mean. The requirement's explicit randomly selected daily volume of `250 +/- 50` or `450 +/- 50` is not implemented.
- Weekends apply `weekendMultiplier`, but still retain the weekday peak-hour profile. The requirement specifies half-volume weekends without an assigned peak.
- Non-peak arrivals are spread uniformly. The specified valley shares of 1% from 22:00-24:00 and 2% from 00:00-06:00 are not implemented.
- Parking duration uses a bounded triangular distribution with the configured mode, not a normal distribution centered near 8 hours.
- Comparable runs can share a seed, but the application does not yet generate and persist named demand datasets for reuse across every configuration in a tower family.

### Reports And Scale

- `averageInboundDriverWaitingSeconds` now matches the requirement: generated arrival until the vehicle occupies an inbound PP. The older `averageInboundWaitSeconds` remains as an additional end-to-end arrival-to-cell metric.
- `downwardTripPlacements` currently counts baseline inbound cell placements as downward-trip placements; it is not yet derived from a rigorously monotonic elevator route phase.
- Induced-inbound trip metrics count trips that handle blockers, but do not yet mean that those blockers occupied decks when the elevator left floor 1.
- Parking hours and revenue are recorded when a vehicle exits and attributed to its outbound-completion day. Time accumulated by vehicles still parked at midnight is not split across daily rows.
- The 30-day summary sums and averages daily metrics. Average-of-average fields are not weighted by the number of vehicles represented by each day.
- The JSONL writer is streaming, but the report reader currently loads and parses the complete raw file in memory. A full 30-day high-volume result should use a streaming report reader.
- Reports are JSON-only; CSV, spreadsheet, charts, and human-readable comparison reports are not implemented.

### Product And Validation

- The included example is a one-hour stress-friendly scenario, not the required June 2026 30-day baseline.
- Configuration validation covers basic positive values and known strategy IDs, but not every cross-field physical constraint.
- The browser application runs the simulation locally and downloads files, but it does not yet provide scenario comparison, saved projects, progress recovery, or packaged desktop installers.
