/**
 * dedupe-snippets.js
 *
 * Merges overlapping snippets in same paragraph where sentence indices
 * are within 2 of each other.
 */

/**
 * Group items by a key function
 * @param {Array} items
 * @param {Function} keyFn
 * @returns {Object} Grouped items
 */
function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

/**
 * Split text into sentences (simple approach)
 * @param {string} text
 * @returns {Array} Array of sentences
 */
function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];

  // Split on sentence-ending punctuation followed by space and capital letter
  // Handle common abbreviations by not splitting after them
  const abbrevs = /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\./gi;
  const protected = text.replace(abbrevs, match => match.replace('.', '\x00'));

  // Split on . ! ? followed by space (or end)
  const sentences = protected
    .split(/(?<=[.!?])\s+/)
    .map(s => s.replace(/\x00/g, '.').trim())
    .filter(s => s.length > 0);

  return sentences;
}

/**
 * Combine text segments, removing duplicate sentences
 * @param {...string} texts - Text segments to combine
 * @returns {string} Combined text
 */
function combineText(...texts) {
  const nonEmpty = texts.filter(t => t && t.trim().length > 0);

  // Split all texts into sentences and dedupe
  const seen = new Set();
  const result = [];

  for (const text of nonEmpty) {
    const sentences = splitIntoSentences(text);
    for (const sentence of sentences) {
      if (!seen.has(sentence)) {
        seen.add(sentence);
        result.push(sentence);
      }
    }
  }

  return result.join(' ');
}

/**
 * Merge two overlapping snippets
 * @param {Object} a - First snippet
 * @param {Object} b - Second snippet (later in document)
 * @returns {Object} Merged snippet
 */
function mergeSnippets(a, b) {
  // Get sentence range
  const startSent = typeof a.location.sentenceIndex === 'number'
    ? a.location.sentenceIndex
    : a.location.sentenceRange[0];
  const endSent = typeof b.location.sentenceIndex === 'number'
    ? b.location.sentenceIndex
    : b.location.sentenceRange[1];

  return {
    ...a,
    text: {
      before: a.text.before,
      match: combineText(a.text.match, a.text.after, b.text.before, b.text.match),
      after: b.text.after
    },
    entities: [...new Set([...a.entities, ...b.entities])],
    mentions: [...a.mentions, ...b.mentions],
    location: {
      paragraphIndex: a.location.paragraphIndex,
      sentenceRange: [startSent, endSent]
    }
  };
}

/**
 * Deduplicate snippets by merging overlapping ones
 * @param {Array} snippets - Array of snippet objects
 * @returns {Array} Deduplicated snippets with new sequential IDs
 */
function dedupeSnippets(snippets) {
  if (snippets.length === 0) return [];

  // Group by chapter + paragraph
  const groups = groupBy(snippets, s => `${s.chapter}_${s.location.paragraphIndex}`);

  const deduped = [];

  for (const group of Object.values(groups)) {
    // Sort by sentence index
    group.sort((a, b) => {
      const aIdx = typeof a.location.sentenceIndex === 'number'
        ? a.location.sentenceIndex
        : a.location.sentenceRange[0];
      const bIdx = typeof b.location.sentenceIndex === 'number'
        ? b.location.sentenceIndex
        : b.location.sentenceRange[0];
      return aIdx - bIdx;
    });

    let current = group[0];

    for (let i = 1; i < group.length; i++) {
      const next = group[i];

      const currentEnd = typeof current.location.sentenceIndex === 'number'
        ? current.location.sentenceIndex
        : current.location.sentenceRange[1];
      const nextStart = typeof next.location.sentenceIndex === 'number'
        ? next.location.sentenceIndex
        : next.location.sentenceRange[0];

      const gap = nextStart - currentEnd;

      if (gap <= 2) {
        // Merge overlapping snippets
        current = mergeSnippets(current, next);
      } else {
        deduped.push(current);
        current = next;
      }
    }
    deduped.push(current);
  }

  // Sort by chapter, paragraph, sentence for consistent ordering
  deduped.sort((a, b) => {
    if (a.chapter !== b.chapter) return a.chapter - b.chapter;
    if (a.location.paragraphIndex !== b.location.paragraphIndex) {
      return a.location.paragraphIndex - b.location.paragraphIndex;
    }
    const aStart = typeof a.location.sentenceIndex === 'number'
      ? a.location.sentenceIndex
      : a.location.sentenceRange[0];
    const bStart = typeof b.location.sentenceIndex === 'number'
      ? b.location.sentenceIndex
      : b.location.sentenceRange[0];
    return aStart - bStart;
  });

  // Re-assign sequential IDs
  return deduped.map((s, i) => ({
    ...s,
    id: `s_${String(i).padStart(4, '0')}`
  }));
}

module.exports = {
  dedupeSnippets,
  mergeSnippets,
  groupBy
};
