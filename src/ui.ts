/**
 * UI Manager for OpenCode TPS Meter Extension
 * Handles display of token processing statistics with throttling and dual-mode support
 */

import type { Config, OpenCodeClient, DisplayState, UIManager as IUIManager } from "./types.js";
import { MIN_TOAST_INTERVAL_MS, DEFAULT_TOAST_DURATION_MS, FINAL_STATS_DURATION_MS } from "./constants.js";

/**
 * Creates a UIManager instance
 * 
 * Handles display of token processing statistics with throttling and dual-mode support
 * (status bar primary, toast fallback)
 *
 * @param client - OpenCode client object with TUI and toast capabilities
 * @param config - Configuration options
 * @returns UIManager instance
 */
export function createUIManager(
  client: OpenCodeClient,
  config: Config
): IUIManager {
  // Private state - with safe defaults
  const uiConfig: Pick<
    Config,
    "updateIntervalMs" | "format" | "showAverage" | "showInstant" | "showTotalTokens" | "showElapsed" | "enableColorCoding" | "slowTpsThreshold" | "fastTpsThreshold"
  > = {
    updateIntervalMs: config?.updateIntervalMs ?? 50,
    format: config?.format ?? "compact",
    showAverage: config?.showAverage ?? true,
    showInstant: config?.showInstant ?? true,
    showTotalTokens: config?.showTotalTokens ?? true,
    showElapsed: config?.showElapsed ?? false,
    enableColorCoding: config?.enableColorCoding ?? false,
    slowTpsThreshold: config?.slowTpsThreshold ?? 10,
    fastTpsThreshold: config?.fastTpsThreshold ?? 50,
  };

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let lastToastAt = 0;
  let lastToastMessage = "";
  let pendingState: DisplayState | null = null;
  let lastDisplayedState: DisplayState | null = null;

  /**
   * Formats milliseconds to MM:SS display
   * @param ms - Milliseconds to format
   * @returns Formatted string like "00:23"
   */
  function formatElapsedTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  /**
   * Formats a number with commas as thousands separators
   * @param num - Number to format
   * @returns Formatted string like "1,842"
   */
  function formatNumberWithCommas(num: number): string {
    return num.toLocaleString("en-US");
  }

  /**
   * Formats the display string according to spec
   * "TPS: {instant} (avg {average}) | tokens: {total} | {elapsed}"
   */
  function formatDisplay(state: DisplayState): string {
    const parts: string[] = [];

    // TPS display
    if (uiConfig.showInstant || uiConfig.showAverage) {
      const tpsParts: string[] = [];
      if (uiConfig.showInstant) {
        tpsParts.push(`TPS: ${state.instantTps.toFixed(1)}`);
      }
      if (uiConfig.showAverage) {
        tpsParts.push(`(avg ${state.avgTps.toFixed(1)})`);
      }
      parts.push(tpsParts.join(" "));
    }

    // Token count
    if (uiConfig.showTotalTokens) {
      parts.push(`tokens: ${formatNumberWithCommas(state.totalTokens)}`);
    }

    // Elapsed time
    if (uiConfig.showElapsed) {
      parts.push(formatElapsedTime(state.elapsedMs));
    }

    return parts.join(" | ");
  }

  /**
   * Determines the color variant based on TPS value when color coding is enabled
   * @param instantTps - Current instantaneous TPS value
   * @param isFinal - Whether this is a final stats message
   * @returns Color variant for the toast
   */
  function getColorVariant(instantTps: number, isFinal: boolean): "info" | "success" | "warning" | "error" {
    if (isFinal) {
      return "success";
    }
    if (!uiConfig.enableColorCoding) {
      return "info";
    }
    if (instantTps < uiConfig.slowTpsThreshold) {
      return "error"; // Red for slow
    }
    if (instantTps > uiConfig.fastTpsThreshold) {
      return "success"; // Green for fast
    }
    return "warning"; // Yellow for medium
  }

  /**
   * Displays message using available methods
   * @param message - Message to display
   * @param isFinal - Whether this is a final stats message
   * @param instantTps - Current instantaneous TPS value (for color coding)
   */
  function display(message: string, isFinal: boolean = false, instantTps: number = 0): void {
    const minToastIntervalMs = Math.max(MIN_TOAST_INTERVAL_MS, uiConfig.updateIntervalMs * 3);
    const toastDuration = Math.max(DEFAULT_TOAST_DURATION_MS, minToastIntervalMs * 20);
    const now = Date.now();

    if (!isFinal) {
      // Skip if same message OR if within the minimum interval
      if (message === lastToastMessage || now - lastToastAt < minToastIntervalMs) {
        return;
      }
    }

    const variant = getColorVariant(instantTps, isFinal);
    let displayed = false;

    if (client.tui?.showToast) {
      try {
        const result = client.tui.showToast({
          body: {
            title: "TPS Meter",
            message,
            variant,
            duration: isFinal ? 2000 : toastDuration,
          },
        });
        if (result && typeof (result as { catch?: unknown }).catch === "function") {
          void (result as { catch: (handler: (reason: unknown) => void) => void }).catch(
            () => {}
          );
        }
        displayed = true;
      } catch {
        // Fall through to next display method
      }
    }

    if (!displayed && client.tui?.publish) {
      try {
        const result = client.tui.publish({
          body: {
            type: "tui.toast.show",
            properties: {
              title: "TPS Meter",
              message,
              variant,
            duration: isFinal ? FINAL_STATS_DURATION_MS : toastDuration,
            },
          },
        });
        if (result && typeof (result as { catch?: unknown }).catch === "function") {
          void (result as { catch: (handler: (reason: unknown) => void) => void }).catch(
            () => {}
          );
        }
        displayed = true;
      } catch {
        // Fall through to next display method
      }
    }

    if (!displayed && client.toast?.success && client.toast?.info) {
      try {
        if (isFinal) {
          client.toast.success(message, { duration: FINAL_STATS_DURATION_MS });
        } else {
          // Note: client.toast fallback only supports info/success
          // Color coding variants (error/warning) require TUI methods
          client.toast.info(message, { duration: toastDuration });
        }
        displayed = true;
      } catch {
        // All display methods failed
      }
    }

    // Only update state if display succeeded (prevents race conditions)
    if (displayed) {
      lastToastAt = now;
      lastToastMessage = message;
    }
  }

  /**
   * Flushes any pending display update
   */
  function flushPendingUpdate(): void {
    if (pendingState) {
      const formatted = formatDisplay(pendingState);
      display(formatted, false, pendingState.instantTps);
      lastDisplayedState = { ...pendingState };
      pendingState = null;
    }
  }

  /**
   * Starts the update timer for throttled display updates
   */
  function scheduleFlush(): void {
    if (flushTimer) {
      return;
    }
    const now = Date.now();
    const delay = lastFlushAt === 0
      ? 0
      : Math.max(0, uiConfig.updateIntervalMs - (now - lastFlushAt));
    flushTimer = setTimeout(() => {
      flushTimer = null;
      lastFlushAt = Date.now();
      flushPendingUpdate();
    }, delay);
  }

  // Return public interface
  return {
    /**
     * Updates the display with current TPS statistics
     * Changes are batched and throttled according to update interval
     * @param instantTps - Instantaneous TPS value
     * @param avgTps - Average TPS value
     * @param totalTokens - Total token count
     * @param elapsedMs - Elapsed time in milliseconds
     */
    updateDisplay(
      instantTps: number,
      avgTps: number,
      totalTokens: number,
      elapsedMs: number
    ): void {
      pendingState = {
        instantTps,
        avgTps,
        totalTokens,
        elapsedMs,
      };
      scheduleFlush();
    },

    /**
     * Displays final statistics immediately (bypasses throttling)
     * @param totalTokens - Total token count
     * @param avgTps - Average TPS value
     * @param elapsedMs - Elapsed time in milliseconds
     */
    showFinalStats(totalTokens: number, avgTps: number, elapsedMs: number): void {
      // Flush any pending updates first to ensure latest state is captured
      flushPendingUpdate();

      // Clear lastToastMessage to ensure final stats always displays
      // This prevents duplicate toast suppression when flushPendingUpdate just showed an update
      lastToastMessage = "";

      const state: DisplayState = {
        instantTps: 0, // No instant TPS for final stats
        avgTps,
        totalTokens,
        elapsedMs,
      };

      const formatted = formatDisplay(state);
      display(formatted, true);
    },

    /**
     * Clears the display and cleans up resources
     */
    clear(): void {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      // Flush any pending updates
      flushPendingUpdate();

      // Reset state
      pendingState = null;
      lastDisplayedState = null;

    },

    /**
     * Changes the update interval for display throttling
     * @param ms - New interval in milliseconds
     */
    setUpdateInterval(ms: number): void {
      uiConfig.updateIntervalMs = ms;
      lastFlushAt = 0;
    }
  };
}

export default createUIManager;
