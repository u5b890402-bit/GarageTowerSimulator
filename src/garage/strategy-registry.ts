import type {
  ElevatorTripPlanner,
  GarageStrategyConfig,
  GarageStrategySet,
  PlacementStrategy,
  PreparationPositionPolicy,
  RetrievalStrategy,
  StrategyCategory,
  StrategyDescriptor,
  StrategySelection,
  UnblockingStrategy,
} from "../domain/types.js";
import {
  FirstAvailablePlacementStrategy,
  FixedPreparationPositionPolicy,
  IdleAfterTenMinutesUnblockingStrategy,
  LowestCostPlacementStrategy,
  NoopUnblockingStrategy,
  SimpleRetrievalStrategy,
} from "./strategies.js";
import { BaselineElevatorTripPlanner } from "./elevator-trip-planner.js";

type StrategyFactory<T> = (options: Record<string, unknown>) => T;

interface StrategyRegistry<T> {
  factories: Record<string, StrategyFactory<T>>;
  descriptors: StrategyDescriptor[];
}

export const defaultGarageStrategyConfig: GarageStrategyConfig = {
  placement: { type: "lowest-access-cost" },
  retrieval: { type: "simple-retrieval" },
  tripPlanner: { type: "baseline-physical" },
  preparationPositions: { type: "fixed-assignment" },
  unblocking: { type: "idle-after-10-minutes" },
};

const placementRegistry: StrategyRegistry<PlacementStrategy> = {
  factories: {
    "lowest-access-cost": (options) => {
      requireNoOptions("lowest-access-cost", options);
      return new LowestCostPlacementStrategy();
    },
    "first-available": (options) => {
      requireNoOptions("first-available", options);
      return new FirstAvailablePlacementStrategy();
    },
  },
  descriptors: [
    {
      category: "placement",
      type: "lowest-access-cost",
      label: "Lowest Access Cost",
      description: "Chooses the empty cell with the lowest estimated elevator, movement, and blockage cost.",
    },
    {
      category: "placement",
      type: "first-available",
      label: "First Available",
      description: "Chooses the first empty parking cell in layout order.",
    },
  ],
};

const retrievalRegistry: StrategyRegistry<RetrievalStrategy> = {
  factories: {
    "simple-retrieval": (options) => {
      requireNoOptions("simple-retrieval", options);
      return new SimpleRetrievalStrategy();
    },
  },
  descriptors: [
    {
      category: "retrieval",
      type: "simple-retrieval",
      label: "Simple Retrieval",
      description: "Classifies blockage and estimates retrieval cost without moving blockers.",
    },
  ],
};

const tripPlannerRegistry: StrategyRegistry<ElevatorTripPlanner> = {
  factories: {
    "baseline-physical": (options) => {
      requireNoOptions("baseline-physical", options);
      return new BaselineElevatorTripPlanner();
    },
    "single-operation": (options) => {
      requireNoOptions("single-operation", options);
      return new BaselineElevatorTripPlanner();
    },
  },
  descriptors: [
    {
      category: "tripPlanner",
      type: "baseline-physical",
      label: "Baseline Physical Planner",
      description: "Builds elevator trips with deck assignments, blocker moves, explicit VMR paths, and PP transfers.",
    },
  ],
};

const preparationPositionRegistry: StrategyRegistry<PreparationPositionPolicy> = {
  factories: {
    "fixed-assignment": (options) => {
      requireNoOptions("fixed-assignment", options);
      return new FixedPreparationPositionPolicy();
    },
  },
  descriptors: [
    {
      category: "preparationPositions",
      type: "fixed-assignment",
      label: "Fixed Assignment",
      description: "Keeps preparation positions assigned to their configured inbound or outbound direction.",
    },
  ],
};

const unblockingRegistry: StrategyRegistry<UnblockingStrategy> = {
  factories: {
    "idle-after-10-minutes": (options) => {
      requireNoOptions("idle-after-10-minutes", options);
      return new IdleAfterTenMinutesUnblockingStrategy();
    },
    disabled: (options) => {
      requireNoOptions("disabled", options);
      return new NoopUnblockingStrategy();
    },
  },
  descriptors: [
    {
      category: "unblocking",
      type: "idle-after-10-minutes",
      label: "Idle After 10 Minutes",
      description: "Relocates blocking vehicles after ten minutes without normal demand.",
    },
    {
      category: "unblocking",
      type: "disabled",
      label: "Disabled",
      description: "Does not initiate idle unblocking operations.",
    },
  ],
};

export function createGarageStrategies(config?: GarageStrategyConfig): GarageStrategySet {
  const normalized = normalizeGarageStrategyConfig(config);
  return {
    placementStrategy: createFromRegistry(placementRegistry, normalized.placement),
    retrievalStrategy: createFromRegistry(retrievalRegistry, normalized.retrieval),
    tripPlanner: createFromRegistry(tripPlannerRegistry, normalized.tripPlanner),
    ppAssignmentPolicy: createFromRegistry(preparationPositionRegistry, normalized.preparationPositions),
    unblockingStrategy: createFromRegistry(unblockingRegistry, normalized.unblocking),
  };
}

export function normalizeGarageStrategyConfig(config?: GarageStrategyConfig): GarageStrategyConfig {
  if (!config) {
    return cloneDefaultConfig();
  }

  return {
    placement: config.placement ?? { ...defaultGarageStrategyConfig.placement },
    retrieval: config.retrieval ?? { ...defaultGarageStrategyConfig.retrieval },
    tripPlanner: config.tripPlanner ?? { ...defaultGarageStrategyConfig.tripPlanner },
    preparationPositions:
      config.preparationPositions ?? { ...defaultGarageStrategyConfig.preparationPositions },
    unblocking: config.unblocking ?? { ...defaultGarageStrategyConfig.unblocking },
  };
}

export function validateGarageStrategyConfig(config?: GarageStrategyConfig): string[] {
  if (!config) return [];
  const normalized = normalizeGarageStrategyConfig(config);
  return [
    ...validateSelection("placement", placementRegistry, normalized.placement),
    ...validateSelection("retrieval", retrievalRegistry, normalized.retrieval),
    ...validateSelection("tripPlanner", tripPlannerRegistry, normalized.tripPlanner),
    ...validateSelection(
      "preparationPositions",
      preparationPositionRegistry,
      normalized.preparationPositions,
    ),
    ...validateSelection("unblocking", unblockingRegistry, normalized.unblocking),
  ];
}

export function getStrategyDescriptors(): StrategyDescriptor[] {
  return [
    ...placementRegistry.descriptors,
    ...retrievalRegistry.descriptors,
    ...tripPlannerRegistry.descriptors,
    ...preparationPositionRegistry.descriptors,
    ...unblockingRegistry.descriptors,
  ];
}

function createFromRegistry<T>(registry: StrategyRegistry<T>, selection: StrategySelection): T {
  const factory = registry.factories[selection.type];
  if (!factory) {
    throw new Error(unknownStrategyMessage(selection.type, registry));
  }
  return factory(selection.options ?? {});
}

function validateSelection<T>(
  category: StrategyCategory,
  registry: StrategyRegistry<T>,
  selection: StrategySelection,
): string[] {
  if (!selection || typeof selection.type !== "string" || selection.type.length === 0) {
    return [`garage.strategies.${category}.type is required.`];
  }

  const factory = registry.factories[selection.type];
  if (!factory) {
    return [`garage.strategies.${category}: ${unknownStrategyMessage(selection.type, registry)}`];
  }

  try {
    factory(selection.options ?? {});
    return [];
  } catch (error) {
    return [
      `garage.strategies.${category}.${selection.type}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

function unknownStrategyMessage<T>(type: string, registry: StrategyRegistry<T>): string {
  return `Unknown strategy '${type}'. Available strategies: ${Object.keys(registry.factories).join(", ")}.`;
}

function requireNoOptions(type: string, options: Record<string, unknown>): void {
  const keys = Object.keys(options);
  if (keys.length > 0) {
    throw new Error(`Strategy '${type}' does not accept options. Unexpected: ${keys.join(", ")}.`);
  }
}

function cloneDefaultConfig(): GarageStrategyConfig {
  return {
    placement: { ...defaultGarageStrategyConfig.placement },
    retrieval: { ...defaultGarageStrategyConfig.retrieval },
    tripPlanner: { ...defaultGarageStrategyConfig.tripPlanner },
    preparationPositions: { ...defaultGarageStrategyConfig.preparationPositions },
    unblocking: { ...defaultGarageStrategyConfig.unblocking },
  };
}
