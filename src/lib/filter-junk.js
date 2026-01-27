/**
 * filter-junk.js
 *
 * Filters out junk entities using multiple heuristics:
 * 1. Sentence-start ratio (>50% = likely common word, not entity)
 * 2. Truncated phrase detection (first word appears in 3+ other two-word entities)
 * 3. List-separated names (comma/and/or patterns indicate separate entities)
 */

/**
 * Filter entity groups, returning clean groups and excluded items with reasons
 * @param {Array} entityGroups - Array of entity groups from groupVariants
 * @param {Object} extractionResult - Raw extraction result with sentenceStartCounts
 * @param {string} fullText - Original document text for context analysis
 * @param {Object} options - Filter options
 * @returns {Object} { clean: Array, excluded: Array }
 */
function filterJunk(entityGroups, extractionResult, fullText, options = {}) {
  const { verbose = false } = options;
  const { sentenceStartCounts = {}, mentionCounts = {} } = extractionResult;

  const clean = [];
  const excluded = [];

  // Pre-compute two-word entity first words for truncated phrase detection
  const twoWordFirstWords = buildTwoWordFirstWordMap(entityGroups);

  for (const group of entityGroups) {
    const exclusion = checkForExclusion(
      group,
      sentenceStartCounts,
      mentionCounts,
      twoWordFirstWords,
      fullText,
      verbose
    );

    if (exclusion) {
      excluded.push({
        text: group.canonicalName,
        mentions: group.totalMentions,
        reason: exclusion.reason,
        evidence: exclusion.evidence,
        sentenceStartRatio: exclusion.sentenceStartRatio
      });
    } else {
      // Add sentence-start ratio to clean groups for downstream use
      const totalMentions = group.totalMentions || 0;
      const ssCount = getSentenceStartCount(group, sentenceStartCounts);
      const ratio = totalMentions > 0 ? ssCount / totalMentions : 0;
      group.sentenceStartRatio = Math.round(ratio * 100) / 100;
      clean.push(group);
    }
  }

  if (verbose) {
    console.log(`[Filter] ${clean.length} clean, ${excluded.length} excluded`);
  }

  return { clean, excluded };
}

/**
 * Check if an entity group should be excluded
 * Returns exclusion reason or null if clean
 */
function checkForExclusion(group, sentenceStartCounts, mentionCounts, twoWordFirstWords, fullText, verbose) {
  const name = group.canonicalName;
  const totalMentions = group.totalMentions || 0;

  // 1. Sentence-start ratio filter
  const ssCount = getSentenceStartCount(group, sentenceStartCounts);
  const ssRatio = totalMentions > 0 ? ssCount / totalMentions : 0;

  if (ssRatio > 0.5 && totalMentions >= 5) {
    if (verbose) console.log(`[Filter] Excluding "${name}" - sentence start ratio ${(ssRatio * 100).toFixed(0)}%`);
    return {
      reason: 'sentence_start_ratio_high',
      evidence: `${(ssRatio * 100).toFixed(0)}% of mentions at sentence start`,
      sentenceStartRatio: Math.round(ssRatio * 100) / 100
    };
  }

  // 2. Truncated phrase detection (for two-word entities)
  const words = name.split(/\s+/);
  if (words.length === 2) {
    const firstWord = words[0];
    const otherTwoWordCount = twoWordFirstWords.get(firstWord) || 0;

    // If this first word appears in 3+ OTHER two-word entities, it's likely truncated
    if (otherTwoWordCount >= 3) {
      if (verbose) console.log(`[Filter] Excluding "${name}" - truncated phrase (${firstWord} in ${otherTwoWordCount + 1} two-word entities)`);
      return {
        reason: 'truncated_phrase',
        evidence: `"${firstWord}" appears as first word in ${otherTwoWordCount + 1} two-word entities`,
        sentenceStartRatio: Math.round(ssRatio * 100) / 100
      };
    }
  }

  // 3. List-separated names detection (for two-word entities)
  // Only apply to RARE two-word names (<10 occurrences) - frequent ones are legitimate
  if (words.length === 2 && totalMentions < 10) {
    const listSeparation = detectListSeparation(name, words, fullText);
    if (listSeparation.isListSeparated) {
      if (verbose) console.log(`[Filter] Excluding "${name}" - list separated (${listSeparation.evidence})`);
      return {
        reason: 'list_separated_names',
        evidence: listSeparation.evidence,
        sentenceStartRatio: Math.round(ssRatio * 100) / 100
      };
    }
  }

  // 4. High-frequency both words filter (for two-word entities)
  // If BOTH words appear as high-frequency single-word entities (>40 each),
  // it's probably two separate characters, not one name (e.g., "Malfoy Crabbe")
  // EXCEPTION: If the full two-word name itself appears frequently (>30 times),
  // it's a real full name like "Harry Potter", not a false concatenation.
  if (words.length === 2 && totalMentions < 30) {
    const word1Count = mentionCounts[words[0]] || 0;
    const word2Count = mentionCounts[words[1]] || 0;
    const minHighFreq = 40;

    if (word1Count >= minHighFreq && word2Count >= minHighFreq) {
      if (verbose) console.log(`[Filter] Excluding "${name}" - both words high-frequency: ${words[0]} (${word1Count}), ${words[1]} (${word2Count})`);
      return {
        reason: 'both_words_high_frequency',
        evidence: `Both "${words[0]}" (${word1Count}) and "${words[1]}" (${word2Count}) are high-frequency standalone entities`,
        sentenceStartRatio: Math.round(ssRatio * 100) / 100
      };
    }
  }

  return null;
}

/**
 * Get sentence-start count for an entity group (sum across all variants)
 */
function getSentenceStartCount(group, sentenceStartCounts) {
  let count = 0;
  for (const variant of group.variants || []) {
    count += sentenceStartCounts[variant.form] || 0;
  }
  return count;
}

/**
 * Build map of first words -> count of OTHER two-word entities using that first word
 * Used for truncated phrase detection
 */
function buildTwoWordFirstWordMap(entityGroups) {
  const firstWordCounts = new Map();

  // First pass: count how many two-word entities use each first word
  for (const group of entityGroups) {
    const words = group.canonicalName.split(/\s+/);
    if (words.length === 2) {
      const firstWord = words[0];
      firstWordCounts.set(firstWord, (firstWordCounts.get(firstWord) || 0) + 1);
    }
  }

  // Convert to "other" counts (subtract 1 for each entity, since we want OTHER entities)
  const result = new Map();
  for (const [word, count] of firstWordCounts) {
    result.set(word, count - 1); // -1 because we exclude the current entity
  }

  return result;
}

/**
 * Detect if a two-word "name" is actually two separate names from a list
 * e.g., "Malfoy Crabbe" from "Malfoy, Crabbe, and Goyle"
 *
 * Conservative approach: Only detect clear list patterns like "word1 and word2"
 * The comma-based check was too aggressive (e.g., "Gryffindor," is common
 * but "Gryffindor House" is still a valid location).
 */
function detectListSeparation(fullName, words, fullText) {
  const [word1, word2] = words;

  // Count how many times the full name appears as a unit
  const fullNameCount = countPattern(fullText, new RegExp(`\\b${escapeRegex(fullName)}\\b`, 'gi'));

  // Count how many times we see "word1 and word2" or "word1, word2, and"
  // This catches "Malfoy, Crabbe, and Goyle" type patterns
  const andPatternCount = countPattern(
    fullText,
    new RegExp(`\\b${escapeRegex(word1)}\\s*,?\\s+(and|or)\\s+${escapeRegex(word2)}\\b`, 'gi')
  );

  // Also count explicit list pattern: "word1, word2," (both in a comma list)
  const commaListCount = countPattern(
    fullText,
    new RegExp(`\\b${escapeRegex(word1)}\\s*,\\s*${escapeRegex(word2)}\\s*,`, 'gi')
  );

  // If "word1 and word2" appears often and more than the "full name", it's a list
  if (andPatternCount >= 3 && andPatternCount > fullNameCount) {
    return {
      isListSeparated: true,
      evidence: `"${word1} and ${word2}" pattern appears ${andPatternCount} times vs "${fullName}" ${fullNameCount} times`
    };
  }

  // If we see "word1, word2," (both in comma lists) frequently
  if (commaListCount >= 3 && commaListCount > fullNameCount) {
    return {
      isListSeparated: true,
      evidence: `"${word1}, ${word2}," list pattern appears ${commaListCount} times`
    };
  }

  return { isListSeparated: false };
}

/**
 * Count regex pattern matches in text
 */
function countPattern(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  filterJunk
};
