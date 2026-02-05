/**
 * Token Counter Module for OpenCode TPS Meter
 *
 * Provides token counting implementations using heuristics.
 * No external dependencies - pure JavaScript implementation.
 *
 * @module tokenCounter
 */

import type { TokenCounter } from "./types.js";
import { CHARS_DIV_4, CHARS_DIV_3, WORDS_DIV_0_75 } from "./constants.js";

/** Type for token counting algorithms */
export type TokenizerAlgorithm = "heuristic" | "word" | "code";

/**
 * Counts tokens using character-based heuristic.
 * @param text - Text to count
 * @param divisor - Character divisor (typically 3 or 4)
 * @returns Token count
 */
function countByChars(text: string, divisor: number): number {
  if (!text || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / divisor);
}

/**
 * Counts tokens using word-based heuristic.
 * @param text - Text to count
 * @param divisor - Word divisor (typically 0.75)
 * @returns Token count
 */
function countByWords(text: string, divisor: number): number {
  if (!text || text.length === 0) {
    return 0;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const wordCount = trimmed.split(/\s+/).length;
  return Math.ceil(wordCount / divisor);
}

/**
 * Creates a token counter with the specified algorithm.
 *
 * @param algorithm - The counting algorithm to use
 * @returns TokenCounter implementation
 */
function createCounter(algorithm: TokenizerAlgorithm): TokenCounter {
  const strategies: Record<TokenizerAlgorithm, (text: string) => number> = {
    heuristic: (text) => countByChars(text, CHARS_DIV_4),
    word: (text) => countByWords(text, WORDS_DIV_0_75),
    code: (text) => countByChars(text, CHARS_DIV_3),
  };

  return {
    count(text: string): number {
      return strategies[algorithm](text);
    },
  };
}

/**
 * Create a fast heuristic token counter.
 * Uses a simple approximation: Math.ceil(text.length / 4).
 *
 * This is useful for fast approximate token counting.
 *
 * Accuracy: ~75% for English text (tokens ≈ characters / 4)
 *
 * @returns {TokenCounter} - TokenCounter implementation
 * @deprecated Use createTokenizer('heuristic') instead
 */
export function createHeuristicCounter(): TokenCounter {
  return createCounter("heuristic");
}

/**
 * Create a word-based heuristic token counter.
 * Uses approximation: Math.ceil(wordCount / 0.75).
 *
 * Better for English prose than character-based heuristics.
 *
 * Accuracy: ~80% for English prose
 *
 * @returns {TokenCounter} - TokenCounter implementation
 * @deprecated Use createTokenizer('word') instead
 */
export function createWordHeuristicCounter(): TokenCounter {
  return createCounter("word");
}

/**
 * Create a code-optimized heuristic token counter.
 * Uses approximation: Math.ceil(text.length / 3).
 *
 * Code typically has more tokens per character than prose.
 *
 * @returns {TokenCounter} - TokenCounter implementation
 * @deprecated Use createTokenizer('code') instead
 */
export function createCodeHeuristicCounter(): TokenCounter {
  return createCounter("code");
}

/**
 * Factory function to create a token counter instance.
 *
 * @param {'heuristic' | 'word' | 'code'} [preferred='heuristic'] - The preferred tokenizer type
 *   - 'heuristic': Use char/4 approximation (default, recommended)
 *   - 'word': Use word/0.75 approximation, better for prose
 *   - 'code': Use char/3 approximation, better for code
 * @returns {TokenCounter} - An instance of the requested token counter
 *
 * @example
 * // Create default heuristic tokenizer
 * const tokenizer = createTokenizer();
 * const count = tokenizer.count("Hello, world!");
 *
 * @example
 * // Create word-based tokenizer for prose
 * const wordTokenizer = createTokenizer('word');
 * const approxCount = wordTokenizer.count("Hello, world!");
 */
export function createTokenizer(algorithm: TokenizerAlgorithm = "heuristic"): TokenCounter {
  return createCounter(algorithm);
}

/**
 * Convenience export for direct token counting using the default tokenizer.
 *
 * @param {string} text - The text to count tokens for
 * @returns {number} - The number of tokens
 *
 * @example
 * import { countTokens } from './tokenCounter';
 * const tokenCount = countTokens("Hello, world!");
 */
export function countTokens(text: string): number {
  return createCounter("heuristic").count(text);
}

/**
 * Simple text encoding function (returns empty array - placeholder for compatibility)
 *
 * @param {string} text - The text to encode
 * @returns {number[]} - Array of token IDs (always empty in this implementation)
 */
export function encodeText(text: string): number[] {
  // This is a placeholder - heuristic tokenizers don't provide actual token IDs
  return [];
}

// Re-export types
export type { TokenCounter } from "./types.js";
