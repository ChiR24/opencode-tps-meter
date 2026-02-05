/**
 * End-to-End Tests for OpenCode TPS Meter Plugin
 *
 * Verifies the complete plugin functionality:
 * - Default export is available
 * - Configuration loading works
 * - Plugin integrates correctly with mock OpenCode environment
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("E2E: Module Exports", () => {
  it("should export the main plugin function as default", async () => {
    const module = await import("../index.js");
    expect(module.default).toBeDefined();
    expect(typeof module.default).toBe("function");
    expect(Object.keys(module)).toEqual(["default"]);
  });
});

describe("E2E: Plugin Loading", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tps-meter-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should load with default configuration when no config files exist", async () => {
    const { loadConfigSync } = await import("../config.js");

    const config = loadConfigSync();
    expect(config).toBeDefined();
    expect(config.enabled).toBe(true);
    expect(config.updateIntervalMs).toBe(50);
    expect(config.rollingWindowMs).toBe(1000);
    expect(config.format).toBe("compact");
  });

  it("should load successfully with a mock OpenCode context", async () => {
    const { default: TpsMeterPlugin } = await import("../index.js");

    const mockContext = {
      client: {
        tui: {
          showToast: (_: unknown) => {},
          publish: (_: unknown) => {},
        },
        toast: {
          info: (_: string, _opts?: object) => {},
          success: (_: string, _opts?: object) => {},
        },
      },
      plugin: {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    };

    const handlers = TpsMeterPlugin(mockContext as never);
    expect(handlers).toBeDefined();
    expect(handlers.event).toBeDefined();
    expect(typeof handlers.event).toBe("function");
  });

  it("should return empty handlers when plugin is disabled", async () => {
    process.env.TPS_METER_ENABLED = "false";

    const { default: TpsMeterPlugin } = await import("../index.js");

    const mockContext = {
      client: {},
      plugin: {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    };

    const handlers = TpsMeterPlugin(mockContext as never);
    expect(handlers).toBeDefined();
    expect(handlers.event).toBeUndefined();
  });
});

describe("E2E: Configuration Loading", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tps-meter-config-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should load project-level configuration", async () => {
    const { loadConfigSync } = await import("../config.js");

    const opencodeDir = path.join(tempDir, ".opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, "tps-meter.json"),
      JSON.stringify({
        enabled: false,
        updateIntervalMs: 500,
        format: "verbose",
      })
    );

    const config = loadConfigSync();
    expect(config.enabled).toBe(false);
    expect(config.updateIntervalMs).toBe(500);
    expect(config.format).toBe("verbose");
    expect(config.rollingWindowMs).toBe(1000);
  });
});

describe("E2E: Config Validation Edge Cases", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tps-meter-validation-test-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should reject NaN values and fall back to defaults", async () => {
    const { loadConfigSync } = await import("../config.js");

    process.env.TPS_METER_UPDATE_INTERVAL_MS = "NaN";
    process.env.TPS_METER_ROLLING_WINDOW_MS = "not-a-number";
    process.env.TPS_METER_MIN_VISIBLE_TPS = "invalid";

    const config = loadConfigSync();
    expect(config.updateIntervalMs).toBe(50); // Default
    expect(config.rollingWindowMs).toBe(1000); // Default
    expect(config.minVisibleTPS).toBe(0); // Default
  });

  it("should reject Infinity values and fall back to defaults", async () => {
    const { loadConfigSync } = await import("../config.js");

    process.env.TPS_METER_UPDATE_INTERVAL_MS = "Infinity";
    process.env.TPS_METER_ROLLING_WINDOW_MS = "-Infinity";

    const config = loadConfigSync();
    expect(config.updateIntervalMs).toBe(50); // Default
    expect(config.rollingWindowMs).toBe(1000); // Default
  });

  it("should reject negative numbers and fall back to defaults", async () => {
    const { loadConfigSync } = await import("../config.js");

    process.env.TPS_METER_UPDATE_INTERVAL_MS = "-100";
    process.env.TPS_METER_ROLLING_WINDOW_MS = "-500";
    process.env.TPS_METER_MIN_VISIBLE_TPS = "-10";

    const config = loadConfigSync();
    expect(config.updateIntervalMs).toBe(50); // Default
    expect(config.rollingWindowMs).toBe(1000); // Default
    expect(config.minVisibleTPS).toBe(0); // Default
  });

  it("should clamp out-of-bounds values to valid ranges", async () => {
    const { loadConfigSync } = await import("../config.js");

    process.env.TPS_METER_UPDATE_INTERVAL_MS = "1"; // Below min (10)
    process.env.TPS_METER_ROLLING_WINDOW_MS = "50000"; // Above max (30000)
    process.env.TPS_METER_MIN_VISIBLE_TPS = "50000"; // Above max (10000)

    const config = loadConfigSync();
    expect(config.updateIntervalMs).toBe(10); // Clamped to min
    expect(config.rollingWindowMs).toBe(30000); // Clamped to max
    expect(config.minVisibleTPS).toBe(10000); // Clamped to max
  });

  it("should reset thresholds to defaults when slow >= fast", async () => {
    const { loadConfigSync } = await import("../config.js");

    process.env.TPS_METER_SLOW_TPS_THRESHOLD = "60";
    process.env.TPS_METER_FAST_TPS_THRESHOLD = "50";

    const config = loadConfigSync();
    expect(config.slowTpsThreshold).toBe(10); // Default
    expect(config.fastTpsThreshold).toBe(50); // Default
  });

  it("should accept valid threshold configuration", async () => {
    const { loadConfigSync } = await import("../config.js");

    process.env.TPS_METER_SLOW_TPS_THRESHOLD = "5";
    process.env.TPS_METER_FAST_TPS_THRESHOLD = "100";

    const config = loadConfigSync();
    expect(config.slowTpsThreshold).toBe(5);
    expect(config.fastTpsThreshold).toBe(100);
  });
});
