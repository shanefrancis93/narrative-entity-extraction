/**
 * group-variants.js
 *
 * Groups related name variants into entity candidates.
 * Conservative approach: false merges are worse than missed merges.
 *
 * Example grouping:
 *   "Harry Potter" (canonical)
 *     <- "Harry" (first name)
 *     <- "Potter" (last name)
 *     <- "Harry's" (possessive)
 *     <- "Mr. Potter" (title + last name)
 */

const fs = require('fs');
const path = require('path');

const configDir = path.join(__dirname, '..', 'config');
const titlePatterns = JSON.parse(fs.readFileSync(path.join(configDir, 'title-patterns.json'), 'utf8'));
const titlePrefixes = new Set(titlePatterns.patterns.map(p => p.pattern.toLowerCase()));

/**
 * Group proper noun mentions into entity candidates
 * @param {Object} extractionResult - Output from extractProperNouns
 * @param {Object} options - Grouping options
 * @returns {Array} Array of entity candidate objects
 */
function groupVariants(extractionResult, options = {}) {
  const { verbose = false, minMentions = 5 } = options;
  const { mentionCounts, firstAppearances, mentions } = extractionResult;

  // Step 1: Categorize all forms
  const forms = categorizeFormsFromMentions(mentions, mentionCounts);

  if (verbose) {
    console.log(`[Grouper] Found ${forms.fullNames.length} full names, ${forms.titledNames.length} titled names, ${forms.singleNames.length} single names`);
  }

  // Step 2: Build entity groups starting from full names
  const entityGroups = buildEntityGroups(forms, mentionCounts, firstAppearances, verbose);

  // Step 3: Filter by minimum mentions
  const filteredGroups = entityGroups.filter(group => {
    const totalMentions = group.variants.reduce((sum, v) => sum + v.count, 0);
    return totalMentions >= minMentions;
  });

  if (verbose) {
    console.log(`[Grouper] ${filteredGroups.length} groups with ${minMentions}+ mentions`);
  }

  return filteredGroups;
}

/**
 * Categorize forms into full names, titled names, and single names
 */
function categorizeFormsFromMentions(mentions, mentionCounts) {
  const fullNames = new Map();    // "Harry Potter" -> count
  const titledNames = new Map();  // "Professor Dumbledore" -> {title, name, count}
  const singleNames = new Map();  // "Harry" -> count
  const possessives = new Map();  // "Harry's" -> base form

  for (const mention of mentions) {
    const form = mention.normalized;
    const words = form.split(/\s+/);

    if (mention.hasTitle && words.length >= 2) {
      // Title + Name: "Professor Dumbledore", "Mr. Dursley"
      const title = words[0];
      const name = words.slice(1).join(' ');
      const key = form;

      if (!titledNames.has(key)) {
        titledNames.set(key, { title, name, count: 0, titleType: mention.titleType });
      }
      titledNames.get(key).count++;

    } else if (words.length >= 2) {
      // Full name: "Harry Potter", "Hermione Granger"
      if (!fullNames.has(form)) {
        fullNames.set(form, 0);
      }
      fullNames.set(form, fullNames.get(form) + 1);

    } else if (words.length === 1) {
      // Single name: "Harry", "Dumbledore"
      const base = form.replace(/'s$/i, '');
      const isPossessive = mention.isPossessive;

      if (isPossessive) {
        possessives.set(form, base);
      }

      if (!singleNames.has(base)) {
        singleNames.set(base, 0);
      }
      singleNames.set(base, singleNames.get(base) + (mentionCounts[form] || 1));
    }
  }

  // Convert to arrays
  return {
    fullNames: Array.from(fullNames.entries()).map(([form, count]) => ({ form, count })),
    titledNames: Array.from(titledNames.entries()).map(([form, data]) => ({ form, ...data })),
    singleNames: Array.from(singleNames.entries()).map(([form, count]) => ({ form, count })),
    possessives: possessives
  };
}

/**
 * Build entity groups by linking related forms
 */
function buildEntityGroups(forms, mentionCounts, firstAppearances, verbose) {
  const groups = [];
  const assignedForms = new Set(); // Track which forms are already grouped

  // Priority 1: Full names become group anchors (require 3+ occurrences to be valid)
  for (const fullName of forms.fullNames) {
    if (assignedForms.has(fullName.form)) continue;

    const count = mentionCounts[fullName.form] || fullName.count;

    // Skip rare "full names" that are likely extraction errors
    if (count < 3) continue;

    // Skip 3+ word names (almost always errors like "Harry Potter Ron")
    const parts = fullName.form.split(/\s+/);
    if (parts.length > 2) continue;

    // Skip if BOTH parts appear 10x more often than the full name
    // This indicates false extraction (e.g., "Harry Ron" = two separate characters)
    // If only ONE part is frequent, that's normal (short form like "Harry" for "Harry Potter")
    if (parts.length === 2) {
      const part1Count = (() => {
        const match = forms.singleNames.find(s => s.form === parts[0]);
        return match ? (mentionCounts[parts[0]] || match.count) : 0;
      })();
      const part2Count = (() => {
        const match = forms.singleNames.find(s => s.form === parts[1]);
        return match ? (mentionCounts[parts[1]] || match.count) : 0;
      })();

      // Both parts appear 10x more than full name = likely two separate characters
      if (part1Count > count * 10 && part2Count > count * 10) {
        if (verbose) console.log(`[Grouper] Skipping "${fullName.form}" (${count}) - both parts frequent: ${parts[0]} (${part1Count}), ${parts[1]} (${part2Count})`);
        continue;
      }
    }

    const group = {
      canonicalName: fullName.form,
      variants: [{ form: fullName.form, count }],
      evidence: {
        isFullName: true,
        parts: parts
      }
    };

    assignedForms.add(fullName.form);

    // Find matching single names (first/last name)
    // If we passed the "both parts frequent" check above, link all parts
    for (const part of parts) {
      if (assignedForms.has(part)) continue;

      const singleMatch = forms.singleNames.find(s => s.form === part);
      if (singleMatch && singleMatch.count >= 3) {
        const singleCount = mentionCounts[part] || singleMatch.count;
        group.variants.push({ form: part, count: singleCount });
        assignedForms.add(part);

        // Also check for possessive
        const possessiveForm = part + "'s";
        if (mentionCounts[possessiveForm]) {
          group.variants.push({ form: possessiveForm, count: mentionCounts[possessiveForm] });
          assignedForms.add(possessiveForm);
        }
      }
    }

    // Find titled versions (Mr. Potter -> Potter match)
    for (const titled of forms.titledNames) {
      if (assignedForms.has(titled.form)) continue;

      // Check if titled name matches last part of full name
      const titledParts = titled.name.split(/\s+/);
      const lastTitledPart = titledParts[titledParts.length - 1];

      if (parts.includes(lastTitledPart)) {
        group.variants.push({
          form: titled.form,
          count: mentionCounts[titled.form] || titled.count,
          hasTitle: true,
          titleType: titled.titleType
        });
        assignedForms.add(titled.form);
        group.evidence.titlePatterns = group.evidence.titlePatterns || [];
        group.evidence.titlePatterns.push(titled.title);
      }
    }

    groups.push(group);
  }

  // Priority 2: Titled names that weren't matched to full names
  for (const titled of forms.titledNames) {
    if (assignedForms.has(titled.form)) continue;

    const group = {
      canonicalName: titled.form, // Will use title form as canonical
      variants: [{ form: titled.form, count: mentionCounts[titled.form] || titled.count, hasTitle: true }],
      evidence: {
        isTitledName: true,
        title: titled.title,
        titleType: titled.titleType
      }
    };

    assignedForms.add(titled.form);

    // Check if the name part exists as single name
    const namePart = titled.name;
    if (!assignedForms.has(namePart)) {
      const singleMatch = forms.singleNames.find(s => s.form === namePart);
      if (singleMatch) {
        group.variants.push({ form: namePart, count: mentionCounts[namePart] || singleMatch.count });
        assignedForms.add(namePart);

        // Update canonical to just the name
        group.canonicalName = namePart;

        // Check possessive
        const possessiveForm = namePart + "'s";
        if (mentionCounts[possessiveForm]) {
          group.variants.push({ form: possessiveForm, count: mentionCounts[possessiveForm] });
          assignedForms.add(possessiveForm);
        }
      }
    }

    groups.push(group);
  }

  // Priority 3: Remaining single names with high frequency
  for (const single of forms.singleNames) {
    if (assignedForms.has(single.form)) continue;
    if (single.count < 3) continue; // Skip very low frequency

    const group = {
      canonicalName: single.form,
      variants: [{ form: single.form, count: mentionCounts[single.form] || single.count }],
      evidence: {
        isSingleName: true
      }
    };

    assignedForms.add(single.form);

    // Check for possessive
    const possessiveForm = single.form + "'s";
    if (mentionCounts[possessiveForm]) {
      group.variants.push({ form: possessiveForm, count: mentionCounts[possessiveForm] });
      assignedForms.add(possessiveForm);
      group.evidence.hasPossessive = true;
    }

    groups.push(group);
  }

  // Add first appearance data to each group
  for (const group of groups) {
    // Find earliest appearance across all variants
    let earliest = null;
    for (const variant of group.variants) {
      const appearance = firstAppearances[variant.form];
      if (appearance) {
        if (!earliest || appearance.chapter < earliest.chapter ||
            (appearance.chapter === earliest.chapter && appearance.paragraph < earliest.paragraph)) {
          earliest = appearance;
        }
      }
    }
    group.firstAppearance = earliest || { chapter: 0, paragraph: 0 };

    // Calculate total mentions
    group.totalMentions = group.variants.reduce((sum, v) => sum + v.count, 0);
  }

  // Sort by total mentions (most frequent first)
  groups.sort((a, b) => b.totalMentions - a.totalMentions);

  return groups;
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
  groupVariants,
  generateEntityId
};
