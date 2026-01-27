/**
 * find-mentions.js
 *
 * Builds variant lookup from entities and finds all entity mentions in text.
 */

// Common title abbreviations that may appear with or without periods
const TITLE_ABBREVS = ['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sr', 'jr', 'st'];

/**
 * Normalize text for matching (lowercase, normalize apostrophes, normalize title periods)
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  let normalized = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC']/g, "'"); // Normalize apostrophes

  // Normalize title abbreviations: "mr." -> "mr", "mrs." -> "mrs"
  for (const title of TITLE_ABBREVS) {
    const withPeriod = new RegExp(`\\b${title}\\.`, 'gi');
    normalized = normalized.replace(withPeriod, title);
  }

  return normalized;
}

/**
 * Build variant lookup from entities
 * @param {Array} entities - Array of entity objects with canonicalName and variants
 * @returns {Map} Map of normalized variant -> { entityId, variant }
 */
function buildVariantLookup(entities) {
  const lookup = new Map();

  for (const entity of entities) {
    const entityId = entity.id;

    // Add canonical name
    const canonicalNorm = normalizeForMatch(entity.canonicalName);
    if (!lookup.has(canonicalNorm)) {
      lookup.set(canonicalNorm, { entityId, variant: entity.canonicalName });
    }

    // Add all variants
    for (const v of entity.variants || []) {
      const variantNorm = normalizeForMatch(v.form);

      // Skip very short variants (single letters, etc.)
      if (variantNorm.length < 2) continue;

      // Skip possessive-only forms - use base form instead
      const baseName = v.form.replace(/'s$/i, '').replace(/'s$/i, '');
      const baseNorm = normalizeForMatch(baseName);

      if (!lookup.has(baseNorm)) {
        lookup.set(baseNorm, { entityId, variant: baseName });
      }

      // Also add the full form including possessive
      if (!lookup.has(variantNorm)) {
        lookup.set(variantNorm, { entityId, variant: v.form });
      }
    }
  }

  return lookup;
}

/**
 * Build regex patterns for efficient matching
 * @param {Map} variantLookup - Map from buildVariantLookup
 * @returns {Object} { patterns: Array, variantMap: Map }
 */
function buildMatchPatterns(variantLookup) {
  // Sort variants by length (longest first) to match longer phrases first
  const variants = Array.from(variantLookup.keys())
    .sort((a, b) => b.length - a.length);

  // Escape regex special characters
  const escaped = variants.map(v =>
    v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );

  // Build pattern that matches any variant as a whole word
  // Use word boundaries, but handle possessives
  const pattern = new RegExp(
    `\\b(${escaped.join('|')})(?:'s|'s)?\\b`,
    'gi'
  );

  return { pattern, variantLookup };
}

/**
 * Find all entity mentions in text
 * @param {string} text - Text to search
 * @param {Map} variantLookup - Map from buildVariantLookup
 * @param {RegExp} pattern - Optional pre-built pattern
 * @returns {Array} Array of { entity, variant }
 */
function findMentions(text, variantLookup, pattern = null) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  // Normalize the text to handle title abbreviations with periods
  const normalizedText = normalizeForMatch(text);

  const mentions = [];
  const seen = new Set(); // Track entities already found in this text

  // Build pattern if not provided
  if (!pattern) {
    const variants = Array.from(variantLookup.keys())
      .sort((a, b) => b.length - a.length);
    const escaped = variants.map(v =>
      v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    pattern = new RegExp(
      `\\b(${escaped.join('|')})(?:'s|'s)?\\b`,
      'gi'
    );
  }

  let match;
  while ((match = pattern.exec(normalizedText)) !== null) {
    const matchedText = match[1]; // The captured group (without possessive)
    const normalized = normalizeForMatch(matchedText);

    const entry = variantLookup.get(normalized);
    if (entry && !seen.has(entry.entityId)) {
      mentions.push({
        entity: entry.entityId,
        variant: entry.variant // Use the canonical variant form
      });
      seen.add(entry.entityId);
    }
  }

  return mentions;
}

module.exports = {
  buildVariantLookup,
  buildMatchPatterns,
  findMentions,
  normalizeForMatch
};
