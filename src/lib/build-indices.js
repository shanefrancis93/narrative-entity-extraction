/**
 * build-indices.js
 *
 * Builds entity index and co-occurrence index from extracted snippets.
 */

/**
 * Build entity index: entity ID -> [snippet IDs]
 * @param {Array} snippets - Array of snippet objects
 * @returns {Object} Entity index
 */
function buildEntityIndex(snippets) {
  const index = {};

  for (const snippet of snippets) {
    for (const entityId of snippet.entities) {
      if (!index[entityId]) {
        index[entityId] = [];
      }
      index[entityId].push(snippet.id);
    }
  }

  // Sort snippet IDs for consistency
  for (const entityId of Object.keys(index)) {
    index[entityId].sort();
  }

  return index;
}

/**
 * Build co-occurrence index: "entity1+entity2" -> [snippet IDs]
 * Only includes snippets where both entities appear
 * @param {Array} snippets - Array of snippet objects
 * @returns {Object} Co-occurrence index
 */
function buildCooccurrenceIndex(snippets) {
  const index = {};

  for (const snippet of snippets) {
    const entities = [...snippet.entities].sort(); // Sort for consistent key order

    // Generate all pairs
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const key = `${entities[i]}+${entities[j]}`;
        if (!index[key]) {
          index[key] = [];
        }
        index[key].push(snippet.id);
      }
    }
  }

  // Sort snippet IDs for consistency
  for (const key of Object.keys(index)) {
    index[key].sort();
  }

  return index;
}

/**
 * Get top co-occurring entity pairs
 * @param {Object} cooccurrenceIndex - From buildCooccurrenceIndex
 * @param {number} limit - Max pairs to return
 * @returns {Array} Array of { pair, count, snippets }
 */
function getTopCooccurrences(cooccurrenceIndex, limit = 20) {
  const pairs = Object.entries(cooccurrenceIndex)
    .map(([pair, snippets]) => ({
      pair,
      count: snippets.length,
      snippets
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return pairs;
}

/**
 * Build chapter index: chapter number -> [snippet IDs]
 * @param {Array} snippets - Array of snippet objects
 * @returns {Object} Chapter index
 */
function buildChapterIndex(snippets) {
  const index = {};

  for (const snippet of snippets) {
    const chapter = snippet.chapter;
    if (!index[chapter]) {
      index[chapter] = [];
    }
    index[chapter].push(snippet.id);
  }

  return index;
}

module.exports = {
  buildEntityIndex,
  buildCooccurrenceIndex,
  getTopCooccurrences,
  buildChapterIndex
};
