#!/usr/bin/env node

/**
 * discover.js
 *
 * Entity Discovery Pipeline - Phase 1 (with Co-reference Resolution)
 *
 * Extracts entity candidates from fiction text, splits into:
 * - confirmed_characters.json: High-confidence characters
 * - candidates.json: Entities needing human review
 *
 * Usage:
 *   node src/discover.js \
 *     --input path/to/book.md \
 *     --output path/to/output/
 *
 * Options:
 *   --input       Input markdown file (required)
 *   --output      Output directory (required)
 *   --min-mentions  Minimum mentions for candidates (default: 8)
 *   --no-coref    Skip LLM co-reference resolution
 *   --verbose     Log discovery process
 */

const fs = require('fs');
const path = require('path');

// Import pipeline modules
const { extractProperNouns } = require('./lib/extract-proper-nouns');
const { groupVariants } = require('./lib/group-variants');
const { filterJunk } = require('./lib/filter-junk');
const { tierEntities, generateEntityId } = require('./lib/tier-entities');
const { runCorefResolution } = require('./lib/llm-coref-merge');

// Parse CLI arguments
function parseArgs() {
  const args = {
    input: null,
    output: null,
    minMentions: 8,
    verbose: false,
    skipCoref: false
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--input' && process.argv[i + 1]) {
      args.input = process.argv[++i];
    } else if (arg === '--output' && process.argv[i + 1]) {
      args.output = process.argv[++i];
    } else if (arg === '--min-mentions' && process.argv[i + 1]) {
      args.minMentions = parseInt(process.argv[++i], 10);
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    } else if (arg === '--no-coref') {
      args.skipCoref = true;
    }
  }

  return args;
}

// Main discovery pipeline
async function discover(args) {
  const { input, output, minMentions, verbose, skipCoref } = args;

  // Validate input
  if (!input) {
    console.error('Error: --input is required');
    process.exit(1);
  }
  if (!output) {
    console.error('Error: --output is required');
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Create output directory
  const outputPath = path.resolve(output);
  const debugPath = path.join(outputPath, 'debug');
  fs.mkdirSync(debugPath, { recursive: true });

  console.log('\n=== Entity Discovery Pipeline (v2 + Coref) ===\n');
  console.log(`Input:  ${inputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Min candidate mentions: ${minMentions}`);
  console.log(`LLM Co-reference: ${skipCoref ? 'disabled' : 'enabled'}`);
  console.log('');

  const totalSteps = skipCoref ? 5 : 6;

  // Step 1: Read input
  console.log(`[1/${totalSteps}] Reading input file...`);
  const text = fs.readFileSync(inputPath, 'utf8');
  const sourceFilename = path.basename(inputPath);

  // Step 2: Extract proper nouns
  console.log(`[2/${totalSteps}] Extracting proper nouns...`);
  const extractionResult = extractProperNouns(text, { verbose });

  if (verbose) {
    console.log(`  Found ${extractionResult.metadata.totalMentions} mentions`);
    console.log(`  ${extractionResult.metadata.uniqueForms} unique forms`);
    console.log(`  ${extractionResult.metadata.chaptersProcessed} chapters processed`);
  }

  // Save debug: raw extractions
  fs.writeFileSync(
    path.join(debugPath, 'raw_extractions.json'),
    JSON.stringify({
      totalMentions: extractionResult.metadata.totalMentions,
      uniqueForms: extractionResult.metadata.uniqueForms,
      mentionCounts: extractionResult.mentionCounts,
      possessiveCounts: extractionResult.possessiveCounts,
      sentenceStartCounts: extractionResult.sentenceStartCounts
    }, null, 2)
  );

  // Step 3: Group variants
  console.log(`[3/${totalSteps}] Grouping variants...`);
  const entityGroups = groupVariants(extractionResult, { verbose, minMentions: 3 });

  if (verbose) {
    console.log(`  Created ${entityGroups.length} entity groups`);
  }

  // Step 4: Filter junk
  console.log(`[4/${totalSteps}] Filtering junk...`);
  const { clean, excluded } = filterJunk(entityGroups, extractionResult, text, { verbose });

  if (verbose) {
    console.log(`  ${clean.length} clean groups, ${excluded.length} excluded`);
  }

  // Save debug: excluded items
  fs.writeFileSync(
    path.join(debugPath, 'excluded.json'),
    JSON.stringify({
      totalExcluded: excluded.length,
      excluded: excluded
    }, null, 2)
  );

  // Step 5: Tier entities
  console.log(`[5/${totalSteps}] Tiering entities...`);
  let { confirmedCharacters, candidates } = tierEntities(clean, extractionResult, {
    verbose,
    minCandidateMentions: minMentions
  });

  // Step 6: LLM Co-reference Resolution (optional)
  let corefStats = null;
  let corefDebug = null;

  if (!skipCoref) {
    console.log(`[6/${totalSteps}] Running LLM co-reference resolution...`);
    try {
      const corefResult = await runCorefResolution(confirmedCharacters, candidates, { verbose });

      confirmedCharacters = corefResult.confirmedCharacters;
      candidates = corefResult.candidates;
      corefStats = corefResult.corefStats;
      corefDebug = corefResult.debug;

      if (corefStats.error) {
        console.log(`  Warning: ${corefStats.error}`);
        console.log('  Continuing with unmerged entities...');
      } else {
        console.log(`  Merged ${corefStats.entitiesMerged} entities into ${corefStats.groupsIdentified} groups`);
        if (corefStats.llmTokensUsed) {
          console.log(`  LLM tokens: ${corefStats.llmTokensUsed.input} input, ${corefStats.llmTokensUsed.output} output`);
        }
      }
    } catch (error) {
      console.error('  LLM co-reference failed:', error.message);
      console.log('  Continuing with unmerged entities...');
      corefStats = { error: `LLM call failed: ${error.message}` };
    }

    // Save debug: LLM coref response
    if (corefDebug) {
      fs.writeFileSync(
        path.join(debugPath, 'llm_coref_response.json'),
        JSON.stringify(corefDebug, null, 2)
      );
    }
  }

  // Generate confirmed_characters.json
  const confirmedOutput = {
    metadata: {
      source: sourceFilename,
      generated: new Date().toISOString(),
      tier: 'confirmed_characters',
      count: confirmedCharacters.length,
      pipeline: skipCoref ? 'entity-discovery-v2' : 'entity-discovery-v2-coref',
      corefApplied: !skipCoref && corefStats && !corefStats.error
    },
    entities: confirmedCharacters
  };

  fs.writeFileSync(
    path.join(outputPath, 'confirmed_characters.json'),
    JSON.stringify(confirmedOutput, null, 2)
  );

  // Generate candidates.json
  const candidatesOutput = {
    metadata: {
      source: sourceFilename,
      generated: new Date().toISOString(),
      tier: 'candidates',
      count: candidates.length,
      pipeline: skipCoref ? 'entity-discovery-v2' : 'entity-discovery-v2-coref',
      corefApplied: !skipCoref && corefStats && !corefStats.error
    },
    entities: candidates
  };

  fs.writeFileSync(
    path.join(outputPath, 'candidates.json'),
    JSON.stringify(candidatesOutput, null, 2)
  );

  // Generate stats
  const exclusionReasons = {};
  for (const item of excluded) {
    exclusionReasons[item.reason] = (exclusionReasons[item.reason] || 0) + 1;
  }

  // Count low-frequency exclusions (groups that didn't make it to candidates)
  const lowFrequencyExcluded = clean.filter(g => g.totalMentions < minMentions).length;
  if (lowFrequencyExcluded > 0) {
    exclusionReasons['low_frequency'] = lowFrequencyExcluded;
  }

  const stats = {
    source: sourceFilename,
    confirmedCharacters: confirmedCharacters.length,
    candidates: candidates.length,
    excluded: excluded.length + lowFrequencyExcluded,
    exclusionReasons,
    corefMerges: corefStats || { skipped: true },
    topConfirmedByMentions: confirmedCharacters.slice(0, 10).map(c => ({
      name: c.canonicalName,
      mentions: c.mentions,
      qualifiedBy: c.qualifiedBy,
      mergedFrom: c.mergedFrom || null
    })),
    topCandidatesByMentions: candidates.slice(0, 10).map(c => ({
      name: c.canonicalName,
      mentions: c.mentions
    }))
  };

  fs.writeFileSync(
    path.join(outputPath, 'stats.json'),
    JSON.stringify(stats, null, 2)
  );

  // Print summary
  console.log('\n=== Discovery Complete ===\n');
  console.log(`Confirmed Characters: ${confirmedCharacters.length}`);
  console.log(`Candidates:           ${candidates.length}`);
  console.log(`Excluded:             ${excluded.length + lowFrequencyExcluded}`);

  if (corefStats && !corefStats.error && !corefStats.skipped) {
    console.log(`Coref Merges:         ${corefStats.entitiesMerged} entities → ${corefStats.groupsIdentified} groups`);
  }
  console.log('');

  console.log('Exclusion reasons:');
  for (const [reason, count] of Object.entries(exclusionReasons)) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log('');

  console.log('Top 10 Confirmed Characters:');
  confirmedCharacters.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.canonicalName} (${c.mentions} mentions, ${c.qualifiedBy})`);
  });
  console.log('');

  console.log('Top 5 Candidates:');
  candidates.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.canonicalName} (${c.mentions} mentions)`);
  });
  console.log('');

  console.log(`Output:`);
  console.log(`  ${outputPath}/confirmed_characters.json`);
  console.log(`  ${outputPath}/candidates.json`);
  console.log(`  ${outputPath}/stats.json`);
  console.log(`  ${outputPath}/debug/excluded.json`);
  if (corefDebug) {
    console.log(`  ${outputPath}/debug/llm_coref_response.json`);
  }
}

// Run
const args = parseArgs();
discover(args).catch(err => {
  console.error('Discovery failed:', err);
  console.error(err.stack);
  process.exit(1);
});
