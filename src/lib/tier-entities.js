/**
 * tier-entities.js
 *
 * Splits filtered entities into two tiers:
 * - Tier 1: Confirmed characters (high confidence, minimal review needed)
 * - Tier 2: Candidates (needs human review, no type assigned)
 */

const fs = require('fs');
const path = require('path');

const configDir = path.join(__dirname, '..', 'config');
const titlePatterns = JSON.parse(fs.readFileSync(path.join(configDir, 'title-patterns.json'), 'utf8'));
const titlePrefixes = new Set(titlePatterns.patterns.map(p => p.pattern.toLowerCase()));

/**
 * Split entities into confirmed characters and candidates
 * @param {Array} cleanGroups - Filtered entity groups from filterJunk
 * @param {Object} extractionResult - Raw extraction result with mentionCounts
 * @param {Object} options - Tier options
 * @returns {Object} { confirmedCharacters: Array, candidates: Array }
 */
function tierEntities(cleanGroups, extractionResult, options = {}) {
  const {
    verbose = false,
    minCandidateMentions = 8,
    minPossessiveForConfirm = 5,
    minMentionsForPossessiveConfirm = 20,
    minIndependentPartMentions = 10
  } = options;

  const { mentionCounts = {}, possessiveCounts = {} } = extractionResult;

  // Build single-word entity mention counts for two-word name validation
  const singleWordCounts = buildSingleWordCounts(cleanGroups, mentionCounts);

  const confirmedCharacters = [];
  const candidates = [];

  for (const group of cleanGroups) {
    const qualification = checkTier1Qualification(
      group,
      singleWordCounts,
      mentionCounts,
      possessiveCounts,
      minPossessiveForConfirm,
      minMentionsForPossessiveConfirm,
      minIndependentPartMentions
    );

    if (qualification) {
      // Tier 1: Confirmed Character
      confirmedCharacters.push({
        id: generateEntityId(group.canonicalName),
        canonicalName: group.canonicalName,
        mentions: group.totalMentions,
        variants: group.variants.map(v => ({ form: v.form, count: v.count })),
        qualifiedBy: qualification.reason,
        firstAppearance: group.firstAppearance
      });
    } else if (group.totalMentions >= minCandidateMentions) {
      // Tier 2: Candidate
      candidates.push({
        id: generateEntityId(group.canonicalName),
        canonicalName: group.canonicalName,
        mentions: group.totalMentions,
        variants: group.variants.map(v => ({ form: v.form, count: v.count })),
        sentenceStartRatio: group.sentenceStartRatio || 0,
        notes: generateCandidateNotes(group),
        firstAppearance: group.firstAppearance
      });
    }
    // Entities with < minCandidateMentions are dropped entirely
  }

  // Sort by mention count
  confirmedCharacters.sort((a, b) => b.mentions - a.mentions);
  candidates.sort((a, b) => b.mentions - a.mentions);

  if (verbose) {
    console.log(`[Tier] ${confirmedCharacters.length} confirmed characters, ${candidates.length} candidates`);
  }

  return { confirmedCharacters, candidates };
}

/**
 * Check if entity qualifies for Tier 1 (Confirmed Character)
 * Criteria (ANY of):
 * 1. Has title pattern (Professor X, Mr/Mrs X, etc.)
 * 2. Two-word name where BOTH words appear 10+ times independently
 * 3. Single name 20+ mentions WITH possessive form 5+ times
 */
function checkTier1Qualification(group, singleWordCounts, mentionCounts, possessiveCounts, minPossessive, minMentions, minPartMentions) {
  const name = group.canonicalName;
  const words = name.split(/\s+/);

  // DISQUALIFICATION: Bare titles without names (e.g., "Mr", "Mrs", "Madam", "Aunt")
  if (/^(Mr|Mrs|Ms|Miss|Madam|Uncle|Aunt|Sir|Lord|Lady|Professor|Dr)\.?$/i.test(name)) {
    return null; // Disqualified - bare title
  }

  // DISQUALIFICATION: Single-letter name portions (e.g., "Mr H", "Mrs P")
  if (/^(Mr|Mrs|Ms|Miss|Madam|Uncle|Aunt|Sir|Lord|Lady|Professor|Dr)\.?\s+[A-Z]$/i.test(name)) {
    return null; // Disqualified - title + single letter
  }

  // Check 1: Has title pattern
  if (group.evidence?.titlePatterns?.length > 0 || group.evidence?.isTitledName) {
    return { reason: 'title_pattern' };
  }

  // Check for title as first word
  if (words.length >= 1) {
    const firstWordLower = words[0].toLowerCase().replace(/\.$/, '');
    if (titlePrefixes.has(firstWordLower)) {
      return { reason: 'title_pattern' };
    }
  }

  // Check 2: Two-word name with both parts appearing independently 10+ times
  if (words.length === 2) {
    const part1Count = singleWordCounts.get(words[0]) || 0;
    const part2Count = singleWordCounts.get(words[1]) || 0;

    if (part1Count >= minPartMentions && part2Count >= minPartMentions) {
      return { reason: 'full_name_both_parts_independent' };
    }
  }

  // Check 3: Single name 20+ mentions with possessive 5+ times
  // Use possessiveCounts which tracks how many times the possessive form appeared
  if (words.length === 1 && group.totalMentions >= minMentions) {
    const possessiveCount = possessiveCounts[name] || 0;

    if (possessiveCount >= minPossessive) {
      return { reason: 'single_name_with_possessive' };
    }
  }

  // Check 4: For two-word names, check if the most frequent variant qualifies
  // e.g., "Albus Dumbledore" where "Dumbledore" has 146 mentions and 15 possessives
  if (words.length === 2) {
    for (const variant of group.variants || []) {
      const variantWords = variant.form.split(/\s+/);
      if (variantWords.length === 1 && variant.count >= minMentions) {
        const possessiveCount = possessiveCounts[variant.form] || 0;
        if (possessiveCount >= minPossessive) {
          return { reason: 'variant_with_possessive' };
        }
      }
    }
  }

  return null;
}

/**
 * Build map of single-word entity names to their mention counts
 * Used for checking if both parts of a two-word name appear independently
 */
function buildSingleWordCounts(groups, mentionCounts) {
  const counts = new Map();

  for (const group of groups) {
    const words = group.canonicalName.split(/\s+/);
    if (words.length === 1) {
      // It's a single-word entity
      counts.set(group.canonicalName, group.totalMentions);
    }
  }

  return counts;
}

/**
 * Generate helpful notes for candidate entities
 */
function generateCandidateNotes(group) {
  const notes = [];
  const words = group.canonicalName.split(/\s+/);

  if (words.length === 1) {
    // Check for possessive
    const hasPossessive = (group.variants || []).some(v =>
      v.form.endsWith("'s") || v.form.endsWith("'s")
    );

    if (hasPossessive) {
      notes.push('Has possessive form');
    } else {
      notes.push('No possessive form');
    }

    if (group.totalMentions >= 50) {
      notes.push('High frequency single word');
    }
  } else {
    notes.push(`${words.length}-word name`);
  }

  // Check for plural form
  const hasPlural = (group.variants || []).some(v =>
    v.form.endsWith('s') && !v.form.endsWith("'s") && v.form !== group.canonicalName
  );
  if (hasPlural) {
    notes.push('Has plural form');
  }

  return notes.join(', ') || 'Needs review';
}

/**
 * Generate entity ID from canonical name
 */
function generateEntityId(canonicalName) {
  return canonicalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

module.exports = {
  tierEntities,
  generateEntityId
};
