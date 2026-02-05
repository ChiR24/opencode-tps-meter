/**
 * Configuration management for OpenCode TPS Meter Plugin
 *
 * Handles loading configuration from multiple sources in priority order:
 * 1. Project-level config (.opencode/tps-meter.json)
 * 2. Global config (~/.config/opencode/tps-meter.json)
 * 3. Environment variables (TPS_METER_*)
 *
 * @module config
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Config } from "./types.js";
import {
  DEFAULT_UPDATE_INTERVAL_MS,
  DEFAULT_ROLLING_WINDOW_MS,
  DEFAULT_SLOW_TPS_THRESHOLD,
  DEFAULT_FAST_TPS_THRESHOLD,
} from "./constants.js";

/**
 * Default configuration values
 * Used when no config file is found or values are missing
 *
 * @constant {Config}
 */
export const defaultConfig: Config = {
  enabled: true,
  updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
  rollingWindowMs: DEFAULT_ROLLING_WINDOW_MS,
  showAverage: true,
  showInstant: true,
  showTotalTokens: true,
  showElapsed: false,
  format: "compact",
  minVisibleTPS: 0,
  fallbackTokenHeuristic: "chars_div_4",
  enableColorCoding: false,
  slowTpsThreshold: DEFAULT_SLOW_TPS_THRESHOLD,
  fastTpsThreshold: DEFAULT_FAST_TPS_THRESHOLD,
};

/**
 * Validates that a value is a boolean
 *
 * @param {unknown} value - Value to check
 * @returns {boolean} - Whether the value is a boolean
 */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Validates that a value is a valid finite number
 * Rejects NaN, Infinity, -Infinity, and negative values for configuration
 *
 * @param {unknown} value - Value to check
 * @returns {boolean} - Whether the value is a valid finite number
 */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value) && isFinite(value) && value >= 0;
}

/**
 * Validates that a value is a string
 *
 * @param {unknown} value - Value to check
 * @returns {boolean} - Whether the value is a string
 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Clamps a number to a valid range
 *
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} - Clamped value
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Merges partial config with defaults, validating each value
 *
 * @param {Partial<Config>} partial - Partial configuration to merge
 * @param {Config} defaults - Default configuration values
 * @returns {Config} - Merged configuration with defaults
 */
function mergeConfig(partial: Partial<Config>, defaults: Config): Config {
  // Validate and clamp numeric values with bounds
  const updateIntervalMs = isNumber(partial.updateIntervalMs)
    ? clamp(partial.updateIntervalMs, 10, 5000)
    : defaults.updateIntervalMs;

  const rollingWindowMs = isNumber(partial.rollingWindowMs)
    ? clamp(partial.rollingWindowMs, 100, 30000)
    : defaults.rollingWindowMs;

  const minVisibleTPS = isNumber(partial.minVisibleTPS)
    ? clamp(partial.minVisibleTPS, 0, 10000)
    : defaults.minVisibleTPS;

  let slowTpsThreshold = isNumber(partial.slowTpsThreshold)
    ? clamp(partial.slowTpsThreshold, 0, 10000)
    : defaults.slowTpsThreshold;

  let fastTpsThreshold = isNumber(partial.fastTpsThreshold)
    ? clamp(partial.fastTpsThreshold, 0, 10000)
    : defaults.fastTpsThreshold;

  // Validate threshold ordering: slow must be less than fast
  if (slowTpsThreshold >= fastTpsThreshold) {
    slowTpsThreshold = defaults.slowTpsThreshold;
    fastTpsThreshold = defaults.fastTpsThreshold;
  }

  return {
    enabled: isBoolean(partial.enabled) ? partial.enabled : defaults.enabled,
    updateIntervalMs,
    rollingWindowMs,
    showAverage: isBoolean(partial.showAverage)
      ? partial.showAverage
      : defaults.showAverage,
    showInstant: isBoolean(partial.showInstant)
      ? partial.showInstant
      : defaults.showInstant,
    showTotalTokens: isBoolean(partial.showTotalTokens)
      ? partial.showTotalTokens
      : defaults.showTotalTokens,
    showElapsed: isBoolean(partial.showElapsed)
      ? partial.showElapsed
      : defaults.showElapsed,
    format:
      isString(partial.format) &&
      ["compact", "verbose", "minimal"].includes(partial.format)
        ? partial.format
        : defaults.format,
    minVisibleTPS,
    fallbackTokenHeuristic:
      isString(partial.fallbackTokenHeuristic) &&
      ["chars_div_4", "chars_div_3", "words_div_0_75"].includes(
        partial.fallbackTokenHeuristic
      )
        ? partial.fallbackTokenHeuristic
        : defaults.fallbackTokenHeuristic,
    enableColorCoding: isBoolean(partial.enableColorCoding)
      ? partial.enableColorCoding
      : defaults.enableColorCoding,
    slowTpsThreshold,
    fastTpsThreshold,
  };
}

/**
 * Loads and parses a JSON config file
 *
 * @param {string} filePath - Path to the config file
 * @returns {Partial<Config> | null} - Parsed config or null if file doesn't exist/invalid
 */
function loadConfigFile(filePath: string): Partial<Config> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
      // Silently ignore invalid config files to prevent TUI log leak during resize
      // The SDK spawns TUI with stdio: "inherit" causing console output to bypass TUI
      return null;
    }

    return parsed as Partial<Config>;
  } catch (error) {
    // Silently ignore config load errors to prevent TUI log leak during resize
    // The SDK spawns TUI with stdio: "inherit" causing console output to bypass TUI
    return null;
  }
}

/**
 * Loads configuration from environment variables
 * Environment variables take precedence over config files
 *
 * Supported environment variables:
 * - TPS_METER_ENABLED (boolean: true/false)
 * - TPS_METER_UPDATE_INTERVAL_MS (number)
 * - TPS_METER_ROLLING_WINDOW_MS (number)
 * - TPS_METER_SHOW_AVERAGE (boolean)
 * - TPS_METER_SHOW_INSTANT (boolean)
 * - TPS_METER_SHOW_TOTAL_TOKENS (boolean)
 * - TPS_METER_SHOW_ELAPSED (boolean)
 * - TPS_METER_FORMAT (string: compact/verbose/minimal)
 * - TPS_METER_MIN_VISIBLE_TPS (number)
 * - TPS_METER_FALLBACK_HEURISTIC (string: chars_div_4/chars_div_3/words_div_0_75)
 * - TPS_METER_ENABLE_COLOR_CODING (boolean: true/false)
 * - TPS_METER_SLOW_TPS_THRESHOLD (number)
 * - TPS_METER_FAST_TPS_THRESHOLD (number)
 *
 * @returns {Partial<Config>} - Configuration values from environment
 */
function loadEnvConfig(): Partial<Config> {
  const envConfig: Partial<Config> = {};

  if (process.env.TPS_METER_ENABLED !== undefined) {
    envConfig.enabled = process.env.TPS_METER_ENABLED === "true";
  }

  if (process.env.TPS_METER_UPDATE_INTERVAL_MS !== undefined) {
    const val = parseInt(process.env.TPS_METER_UPDATE_INTERVAL_MS, 10);
    if (!isNaN(val)) envConfig.updateIntervalMs = val;
  }

  if (process.env.TPS_METER_ROLLING_WINDOW_MS !== undefined) {
    const val = parseInt(process.env.TPS_METER_ROLLING_WINDOW_MS, 10);
    if (!isNaN(val)) envConfig.rollingWindowMs = val;
  }

  if (process.env.TPS_METER_SHOW_AVERAGE !== undefined) {
    envConfig.showAverage = process.env.TPS_METER_SHOW_AVERAGE === "true";
  }

  if (process.env.TPS_METER_SHOW_INSTANT !== undefined) {
    envConfig.showInstant = process.env.TPS_METER_SHOW_INSTANT === "true";
  }

  if (process.env.TPS_METER_SHOW_TOTAL_TOKENS !== undefined) {
    envConfig.showTotalTokens =
      process.env.TPS_METER_SHOW_TOTAL_TOKENS === "true";
  }

  if (process.env.TPS_METER_SHOW_ELAPSED !== undefined) {
    envConfig.showElapsed = process.env.TPS_METER_SHOW_ELAPSED === "true";
  }

  if (process.env.TPS_METER_FORMAT !== undefined) {
    const val = process.env.TPS_METER_FORMAT;
    if (["compact", "verbose", "minimal"].includes(val)) {
      envConfig.format = val as Config["format"];
    }
  }

  if (process.env.TPS_METER_MIN_VISIBLE_TPS !== undefined) {
    const val = parseFloat(process.env.TPS_METER_MIN_VISIBLE_TPS);
    if (!isNaN(val)) envConfig.minVisibleTPS = val;
  }

  if (process.env.TPS_METER_FALLBACK_HEURISTIC !== undefined) {
    const val = process.env.TPS_METER_FALLBACK_HEURISTIC;
    if (["chars_div_4", "chars_div_3", "words_div_0_75"].includes(val)) {
      envConfig.fallbackTokenHeuristic = val as Config["fallbackTokenHeuristic"];
    }
  }

  if (process.env.TPS_METER_ENABLE_COLOR_CODING !== undefined) {
    envConfig.enableColorCoding = process.env.TPS_METER_ENABLE_COLOR_CODING === "true";
  }

  if (process.env.TPS_METER_SLOW_TPS_THRESHOLD !== undefined) {
    const val = parseFloat(process.env.TPS_METER_SLOW_TPS_THRESHOLD);
    if (!isNaN(val)) envConfig.slowTpsThreshold = val;
  }

  if (process.env.TPS_METER_FAST_TPS_THRESHOLD !== undefined) {
    const val = parseFloat(process.env.TPS_METER_FAST_TPS_THRESHOLD);
    if (!isNaN(val)) envConfig.fastTpsThreshold = val;
  }

  return envConfig;
}

/**
 * Loads configuration from multiple sources in priority order:
 * 1. .opencode/tps-meter.json (project-level)
 * 2. ~/.config/opencode/tps-meter.json (global)
 * 3. Environment variables (TPS_METER_*)
 *
 * Later sources override earlier ones.
 *
 * @returns {Config} - Resolved configuration with all defaults applied
 *
 * @example
 * const config = loadConfigSync();
 * if (config.enabled) {
 *   // Initialize plugin
 * }
 */
export function loadConfigSync(): Config {
  let mergedConfig: Partial<Config> = {};

  // Priority 1: Project-level config (.opencode/tps-meter.json)
  const projectConfigPath = path.join(
    process.cwd(),
    ".opencode",
    "tps-meter.json"
  );
  const projectConfig = loadConfigFile(projectConfigPath);
  if (projectConfig) {
    mergedConfig = { ...mergedConfig, ...projectConfig };
  }

  // Priority 2: Global config (~/.config/opencode/tps-meter.json)
  const homeDir = os.homedir();
  const globalConfigPath = path.join(
    homeDir,
    ".config",
    "opencode",
    "tps-meter.json"
  );
  const globalConfig = loadConfigFile(globalConfigPath);
  if (globalConfig) {
    mergedConfig = { ...mergedConfig, ...globalConfig };
  }

  // Priority 3: Environment variables (override config files)
  const envConfig = loadEnvConfig();
  mergedConfig = { ...mergedConfig, ...envConfig };

  // Merge with defaults and return
  return mergeConfig(mergedConfig, defaultConfig);
}

/**
 * Exports default config for external access
 * @deprecated Use loadConfigSync() to get resolved configuration
 */
export { defaultConfig as config };

/**
 * Backwards-compatible alias for loadConfigSync
 * @deprecated Use loadConfigSync() instead
 */
export { loadConfigSync as loadConfig };
