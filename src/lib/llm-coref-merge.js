/**
 * llm-coref-merge.js
 *
 * LLM-based co-reference resolution for entity merging.
 * Identifies entity names that refer to the same character/entity
 * and merges them into single entries.
 *
 * Uses a pluggable LLM provider. Default: Anthropic SDK (Claude 3.5 Haiku).
 * You can pass a custom provider for OpenRouter, OpenAI, or any other LLM.
 */

const Anthropic = require('@anthropic-ai/sdk');

/**
 * Default LLM provider using Anthropic SDK directly.
 * Requires ANTHROPIC_API_KEY environment variable.
 *
 * @param {Object} params - { system, messages, max_tokens, temperature }
 * @returns {Object} { content, usage: { prompt_tokens, completion_tokens } }
 */
async function defaultAnthropicProvider({ system, messages, max_tokens, temperature }) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens,
    temperature,
    system,
    messages
  });
  return {
    content: response.content[0].text,
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens
    }
  };
}

/**
 * Call LLM to identify which entity names refer to the same character
 * @param {Array} entityNames - Array of { name, mentions } objects
 * @param {Object} options - Options including verbose flag and llmProvider
 * @returns {Object} { merges: [[name1, name2], ...], tokens: { input, output } }
 */
async function llmCorefMerge(entityNames, options = {}) {
  const { verbose = false, llmProvider = defaultAnthropicProvider } = options;

  if (entityNames.length === 0) {
    return { merges: [], tokens: { input: 0, output: 0 } };
  }

  // Build the prompt with entity names and mention counts
  const namesList = entityNames
    .sort((a, b) => b.mentions - a.mentions) // Sort by mentions for better LLM context
    .map(e => `${e.name} (${e.mentions})`)
    .join('\n');

  const systemPrompt = `You are a strict entity resolution assistant for fiction text. You identify when multiple names refer to THE EXACT SAME individual person. Be conservative - only merge when certain.`;

  const userPrompt = `Identify which names refer to THE SAME INDIVIDUAL person.
Return only merge groups. Skip names that are unique or uncertain.

Names:
${namesList}

STRICT RULES - read carefully:
1. ONLY merge names that refer to the EXACT SAME individual person
2. DO NOT merge:
   - Family names with individuals (e.g., "Weasleys" is the family, not "Ron")
   - Pets/creatures with their owners (e.g., "Fang" is Hagrid's dog, not Hagrid)
   - Different siblings (e.g., Fred, George, Percy are DIFFERENT people)
   - House/group names with members (e.g., "Gryffindors" is the house, not Hermione)
   - Generic terms like "Mum", "Dad" with specific people
3. DO merge:
   - Title variations: "Vernon" = "Uncle Vernon" = "Mr Dursley" (same person)
   - Name + surname: "Neville" = "Longbottom" (same person)
   - Aliases: "Voldemort" = "You-Know-Who" (same entity)

When in doubt, DO NOT merge.

Respond in JSON only:
{"merges": [["name1", "name2"], ["name3", "name4", "name5"]]}`;

  if (verbose) {
    console.log('[LLM Coref] Sending request with', entityNames.length, 'entities');
  }

  try {
    const result = await llmProvider({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 1024,
      temperature: 0.3
    });

    const content = result.content;
    const tokens = {
      input: result.usage?.prompt_tokens || 0,
      output: result.usage?.completion_tokens || 0
    };

    if (verbose) {
      console.log('[LLM Coref] Response received, tokens:', tokens);
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate structure
    if (!Array.isArray(parsed.merges)) {
      throw new Error('Invalid response structure: missing merges array');
    }

    return {
      merges: parsed.merges,
      tokens,
      rawResponse: content
    };
  } catch (error) {
    if (verbose) {
      console.error('[LLM Coref] Error:', error.message);
    }
    throw error;
  }
}

/**
 * Apply merge groups to entity lists
 * @param {Array} entities - Array of entity objects with canonicalName, mentions, variants
 * @param {Array} merges - Array of merge groups [[name1, name2], ...]
 * @param {Object} options - Options including verbose flag
 * @returns {Object} { entities: Array, appliedMerges: number, skippedMerges: Array }
 */
function applyMerges(entities, merges, options = {}) {
  const { verbose = false } = options;

  const appliedMerges = [];
  const skippedMerges = [];

  // Create a map for quick entity lookup by canonical name
  const entityMap = new Map();
  for (const entity of entities) {
    entityMap.set(entity.canonicalName, entity);
  }

  for (const group of merges) {
    if (!Array.isArray(group) || group.length < 2) {
      skippedMerges.push({ group, reason: 'Invalid group structure' });
      continue;
    }

    // Find entities that match the names in this merge group
    const groupEntities = group
      .map(name => entityMap.get(name))
      .filter(Boolean);

    if (groupEntities.length < 2) {
      skippedMerges.push({
        group,
        reason: `Only ${groupEntities.length} of ${group.length} names found in entities`
      });
      continue;
    }

    // Sort by mentions descending - highest becomes primary
    groupEntities.sort((a, b) => b.mentions - a.mentions);
    const primary = groupEntities[0];
    const others = groupEntities.slice(1);

    if (verbose) {
      console.log(`[Merge] Merging into "${primary.canonicalName}":`, others.map(e => e.canonicalName));
    }

    // Merge variants and mentions into primary
    for (const other of others) {
      // Add other's variants to primary
      if (other.variants) {
        primary.variants = primary.variants || [];
        primary.variants.push(...other.variants);
      }

      // Add the other's canonical name as a variant if not already present
      const hasCanonicalVariant = (primary.variants || []).some(
        v => v.form === other.canonicalName
      );
      if (!hasCanonicalVariant) {
        primary.variants = primary.variants || [];
        primary.variants.push({ form: other.canonicalName, count: other.mentions });
      }

      // Accumulate mentions
      primary.mentions += other.mentions;

      // Track merged names
      primary.mergedFrom = primary.mergedFrom || [];
      primary.mergedFrom.push(other.canonicalName);

      // Remove merged entity from map
      entityMap.delete(other.canonicalName);
    }

    // Update firstAppearance to earliest
    for (const other of others) {
      if (other.firstAppearance && (!primary.firstAppearance || other.firstAppearance < primary.firstAppearance)) {
        primary.firstAppearance = other.firstAppearance;
      }
    }

    appliedMerges.push({
      primary: primary.canonicalName,
      merged: others.map(e => e.canonicalName),
      newMentionCount: primary.mentions
    });
  }

  // Return remaining entities (non-merged ones are still in the map)
  const remainingEntities = Array.from(entityMap.values());

  // Re-sort by mentions
  remainingEntities.sort((a, b) => b.mentions - a.mentions);

  return {
    entities: remainingEntities,
    appliedMerges,
    skippedMerges
  };
}

/**
 * Run full co-reference resolution on confirmed and candidate entities
 * @param {Array} confirmedCharacters - Confirmed character entities
 * @param {Array} candidates - Candidate entities
 * @param {Object} options - Options including verbose flag and llmProvider
 * @returns {Object} Result with merged entities and stats
 */
async function runCorefResolution(confirmedCharacters, candidates, options = {}) {
  const { verbose = false } = options;

  // Collect all entity names for LLM
  const allEntityNames = [
    ...confirmedCharacters.map(e => ({ name: e.canonicalName, mentions: e.mentions })),
    ...candidates.map(e => ({ name: e.canonicalName, mentions: e.mentions }))
  ];

  if (verbose) {
    console.log(`[Coref] Processing ${allEntityNames.length} total entities`);
  }

  let corefResult;
  try {
    corefResult = await llmCorefMerge(allEntityNames, options);
  } catch (error) {
    // Graceful degradation - return unmerged entities with error info
    console.error('[Coref] LLM call failed:', error.message);
    return {
      confirmedCharacters,
      candidates,
      corefStats: {
        error: `LLM call failed: ${error.message}`,
        groupsIdentified: 0,
        entitiesMerged: 0,
        appliedMerges: [],
        skippedMerges: []
      }
    };
  }

  if (verbose) {
    console.log(`[Coref] LLM suggested ${corefResult.merges.length} merge groups`);
  }

  // Apply merges to both lists
  // First, combine entities for merging, then re-separate
  const allEntities = [...confirmedCharacters, ...candidates];
  const confirmedIds = new Set(confirmedCharacters.map(e => e.id));

  const mergeResult = applyMerges(allEntities, corefResult.merges, { verbose });

  // Re-separate into confirmed and candidates based on original classification
  // If a merge group contains any confirmed entity, the result is confirmed
  const mergedConfirmed = [];
  const mergedCandidates = [];

  for (const entity of mergeResult.entities) {
    // Check if this entity or any of its merged sources was confirmed
    const wasConfirmed = confirmedIds.has(entity.id) ||
      (entity.mergedFrom || []).some(name => {
        const original = allEntities.find(e => e.canonicalName === name);
        return original && confirmedIds.has(original.id);
      });

    if (wasConfirmed) {
      mergedConfirmed.push(entity);
    } else {
      mergedCandidates.push(entity);
    }
  }

  return {
    confirmedCharacters: mergedConfirmed,
    candidates: mergedCandidates,
    corefStats: {
      groupsIdentified: corefResult.merges.length,
      entitiesMerged: mergeResult.appliedMerges.reduce((sum, m) => sum + m.merged.length, 0),
      appliedMerges: mergeResult.appliedMerges,
      skippedMerges: mergeResult.skippedMerges,
      llmTokensUsed: corefResult.tokens
    },
    debug: {
      prompt: `[${allEntityNames.length} entities sent to LLM]`,
      rawResponse: corefResult.rawResponse,
      parsedMerges: corefResult.merges
    }
  };
}

module.exports = {
  llmCorefMerge,
  applyMerges,
  runCorefResolution,
  defaultAnthropicProvider
};
