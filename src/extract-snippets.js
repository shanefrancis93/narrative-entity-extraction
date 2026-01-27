#!/usr/bin/env node

/**
 * extract-snippets.js
 *
 * Phase 2: Snippet Extraction Pipeline
 *
 * Extracts text snippets around every entity mention, creating a queryable
 * index for efficient LLM context retrieval.
 *
 * Usage:
 *   node src/extract-snippets.js \
 *     --input path/to/book.md \
 *     --entities path/to/confirmed_characters.json \
 *     --output path/to/output/
 */

const fs = require('fs');
const path = require('path');

// Import pipeline modules
const { parseChapters, splitParagraphs } = require('./lib/parse-chapters');
const { splitSentences } = require('./lib/split-sentences');
const { buildVariantLookup, findMentions } = require('./lib/find-mentions');
const { dedupeSnippets } = require('./lib/dedupe-snippets');
const { buildEntityIndex, buildCooccurrenceIndex, getTopCooccurrences, buildChapterIndex } = require('./lib/build-indices');

/**
 * Parse CLI arguments
 */
function parseArgs() {
  const args = {
    input: null,
    entities: null,
    output: null,
    includeCandidates: false,
    contextSentences: 1,
    verbose: false
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--input' && process.argv[i + 1]) {
      args.input = process.argv[++i];
    } else if (arg === '--entities' && process.argv[i + 1]) {
      args.entities = process.argv[++i];
    } else if (arg === '--output' && process.argv[i + 1]) {
      args.output = process.argv[++i];
    } else if (arg === '--include-candidates') {
      args.includeCandidates = true;
    } else if (arg === '--context-sentences' && process.argv[i + 1]) {
      args.contextSentences = parseInt(process.argv[++i], 10);
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    }
  }

  return args;
}

/**
 * Extract snippets from chapters using entity mentions
 */
function extractSnippets(chapters, variantLookup, options = {}) {
  const { verbose = false } = options;
  const snippets = [];
  let snippetId = 0;

  for (const chapter of chapters) {
    if (verbose) {
      console.log(`[Extract] Chapter ${chapter.number}: ${chapter.title}`);
    }

    const paragraphs = splitParagraphs(chapter.text);

    for (let paraIndex = 0; paraIndex < paragraphs.length; paraIndex++) {
      const paragraph = paragraphs[paraIndex];
      const sentences = splitSentences(paragraph);

      for (let sentIndex = 0; sentIndex < sentences.length; sentIndex++) {
        const sentence = sentences[sentIndex];

        // Find mentions in this sentence
        const mentions = findMentions(sentence, variantLookup);

        if (mentions.length === 0) continue;

        // Build the 3-sentence window
        const prevSent = sentences[sentIndex - 1] || '';
        const nextSent = sentences[sentIndex + 1] || '';

        // Find mentions in context sentences
        const prevMentions = findMentions(prevSent, variantLookup);
        const nextMentions = findMentions(nextSent, variantLookup);

        // Collect all mentions with location info
        const allMentions = [
          ...prevMentions.map(m => ({ ...m, sentence: 'before' })),
          ...mentions.map(m => ({ ...m, sentence: 'match' })),
          ...nextMentions.map(m => ({ ...m, sentence: 'after' }))
        ];

        // Unique entity IDs
        const entityIds = [...new Set(allMentions.map(m => m.entity))];

        snippets.push({
          id: `s_${String(snippetId++).padStart(4, '0')}`,
          book: 1,
          chapter: chapter.number,
          chapterTitle: chapter.title,
          location: {
            paragraphIndex: paraIndex,
            sentenceIndex: sentIndex
          },
          text: {
            before: prevSent,
            match: sentence,
            after: nextSent
          },
          entities: entityIds,
          mentions: allMentions
        });
      }
    }
  }

  return snippets;
}

/**
 * Build statistics object
 */
function buildStats(snippets, dedupedSnippets, entities, entityIndex, cooccurrenceIndex, chapterIndex) {
  const byEntity = {};
  for (const entity of entities) {
    const snippetIds = entityIndex[entity.id] || [];
    byEntity[entity.id] = {
      canonicalName: entity.canonicalName,
      snippets: snippetIds.length,
      mentions: entity.mentions
    };
  }

  const byChapter = {};
  for (const [chapter, snippetIds] of Object.entries(chapterIndex)) {
    byChapter[chapter] = { snippets: snippetIds.length };
  }

  const multiEntitySnippets = dedupedSnippets.filter(s => s.entities.length > 1).length;
  const avgEntities = dedupedSnippets.length > 0
    ? dedupedSnippets.reduce((sum, s) => sum + s.entities.length, 0) / dedupedSnippets.length
    : 0;

  const topPairs = getTopCooccurrences(cooccurrenceIndex, 10)
    .map(p => ({ pair: p.pair, snippets: p.count }));

  return {
    extraction: {
      totalSnippets: dedupedSnippets.length,
      beforeDedup: snippets.length,
      dedupReduction: snippets.length > 0
        ? `${Math.round((1 - dedupedSnippets.length / snippets.length) * 100)}%`
        : '0%'
    },
    entities: {
      totalUsed: entities.length
    },
    coverage: {
      snippetsWithMultipleEntities: multiEntitySnippets,
      avgEntitiesPerSnippet: Math.round(avgEntities * 10) / 10
    },
    byEntity,
    byChapter,
    cooccurrences: {
      totalPairs: Object.keys(cooccurrenceIndex).length,
      topPairs
    }
  };
}

/**
 * Generate review.md - human-readable audit report
 */
function generateReview(snippets, entities, entityIndex, cooccurrenceIndex, stats, outputPath) {
  const lines = [];

  // Header
  lines.push('# Extraction Review\n');
  lines.push(`**Source:** ${stats.source}`);
  lines.push(`**Entities:** ${entities.length} from confirmed_characters.json`);
  lines.push(`**Generated:** ${new Date().toISOString()}\n`);
  lines.push('---\n');

  // Summary table
  lines.push('## Summary\n');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Snippets | ${stats.extraction.totalSnippets} |`);
  lines.push(`| Before Dedup | ${stats.extraction.beforeDedup} |`);
  lines.push(`| Dedup Reduction | ${stats.extraction.dedupReduction} |`);
  lines.push(`| Co-occurrence Pairs | ${stats.cooccurrences.totalPairs} |`);
  lines.push(`| Avg Entities/Snippet | ${stats.coverage.avgEntitiesPerSnippet} |`);
  lines.push('');

  // Entity coverage
  lines.push('---\n');
  lines.push('## Entity Coverage\n');

  const entitiesWithSnippets = Object.keys(entityIndex).length;
  if (entitiesWithSnippets === entities.length) {
    lines.push(`All ${entities.length} entities have snippets. ✓\n`);
  } else {
    const missing = entities.filter(e => !entityIndex[e.id]);
    lines.push(`⚠️ ${entities.length - entitiesWithSnippets} entities have no snippets:\n`);
    for (const e of missing) {
      lines.push(`- ${e.canonicalName}`);
    }
    lines.push('');
  }

  // Top entities table
  lines.push('### Top 10 by Snippet Count\n');
  lines.push('| Entity | Snippets | Mentions | Coverage |');
  lines.push('|--------|----------|----------|----------|');

  const sortedEntities = entities
    .map(e => ({
      ...e,
      snippetCount: (entityIndex[e.id] || []).length
    }))
    .sort((a, b) => b.snippetCount - a.snippetCount);

  for (const e of sortedEntities.slice(0, 10)) {
    const coverage = e.mentions > 0 ? Math.round(e.snippetCount / e.mentions * 100) : 0;
    lines.push(`| ${e.canonicalName} | ${e.snippetCount} | ${e.mentions} | ${coverage}% |`);
  }
  lines.push('');

  // Bottom entities
  lines.push('### Bottom 5 by Snippet Count\n');
  lines.push('| Entity | Snippets | Mentions |');
  lines.push('|--------|----------|----------|');

  for (const e of sortedEntities.slice(-5).reverse()) {
    lines.push(`| ${e.canonicalName} | ${e.snippetCount} | ${e.mentions} |`);
  }
  lines.push('');

  // Co-occurrences
  lines.push('---\n');
  lines.push('## Co-occurrences\n');
  lines.push('### Top 10 Entity Pairs\n');
  lines.push('| Pair | Snippets |');
  lines.push('|------|----------|');

  const topPairs = Object.entries(cooccurrenceIndex)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  for (const [pair, snippetIds] of topPairs) {
    lines.push(`| ${pair.replace('+', ' + ')} | ${snippetIds.length} |`);
  }
  lines.push('');

  // Sample snippets for top 5 entities
  lines.push('---\n');
  lines.push('## Sample Snippets\n');

  const snippetMap = new Map(snippets.map(s => [s.id, s]));

  for (const entity of sortedEntities.slice(0, 5)) {
    lines.push(`### ${entity.canonicalName} (3 samples)\n`);

    const entitySnippetIds = entityIndex[entity.id] || [];
    const sampleIds = entitySnippetIds.slice(0, 3);

    for (const sid of sampleIds) {
      const s = snippetMap.get(sid);
      if (!s) continue;

      lines.push(`**[${s.id}]** Chapter ${s.chapter}: ${s.chapterTitle}`);
      lines.push(`> **Before:** ${s.text.before || '(start of paragraph)'}`);
      lines.push(`> **Match:** ${s.text.match}`);
      lines.push(`> **After:** ${s.text.after || '(end of paragraph)'}`);
      lines.push(`>`);
      lines.push(`> *Entities: ${s.entities.join(', ')}*\n`);
    }
  }

  // Potential issues
  lines.push('---\n');
  lines.push('## Potential Issues\n');

  const issues = [];
  const dedupPct = parseInt(stats.extraction.dedupReduction);
  if (dedupPct > 50) {
    issues.push(`- **High dedup ratio (${dedupPct}%)**: Expected 15-25%. Review merged snippets for quality.`);
  }

  const missingEntities = entities.filter(e => !entityIndex[e.id]);
  if (missingEntities.length > 0) {
    issues.push(`- **Missing entities (${missingEntities.length})**: ${missingEntities.map(e => e.canonicalName).join(', ')}`);
  }

  if (issues.length === 0) {
    lines.push('No issues detected.');
  } else {
    lines.push(...issues);
  }

  lines.push('');

  // Files generated
  lines.push('---\n');
  lines.push('## Files Generated\n');
  lines.push(`- \`snippets.jsonl\` — ${stats.extraction.totalSnippets} snippets`);
  lines.push(`- \`entity_index.json\` — ${Object.keys(entityIndex).length} entities indexed`);
  lines.push(`- \`cooccurrence_index.json\` — ${stats.cooccurrences.totalPairs} entity pairs`);
  lines.push('- `stats.json` — Full statistics');
  lines.push('- `review.md` — This file');

  // Write file
  const reviewPath = path.join(outputPath, 'review.md');
  fs.writeFileSync(reviewPath, lines.join('\n'));

  return reviewPath;
}

/**
 * Main extraction pipeline
 */
async function extractSnippetsPipeline(args) {
  const { input, entities: entitiesPath, output, includeCandidates, verbose } = args;

  // Validate inputs
  if (!input) {
    console.error('Error: --input is required');
    process.exit(1);
  }
  if (!entitiesPath) {
    console.error('Error: --entities is required');
    process.exit(1);
  }
  if (!output) {
    console.error('Error: --output is required');
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  const entitiesFilePath = path.resolve(entitiesPath);
  const outputPath = path.resolve(output);

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(entitiesFilePath)) {
    console.error(`Error: Entities file not found: ${entitiesFilePath}`);
    process.exit(1);
  }

  // Create output directory
  fs.mkdirSync(outputPath, { recursive: true });

  console.log('\n=== Snippet Extraction Pipeline ===\n');
  console.log(`Input:    ${inputPath}`);
  console.log(`Entities: ${entitiesFilePath}`);
  console.log(`Output:   ${outputPath}`);
  console.log('');

  // Step 1: Load entities
  console.log('[1/6] Loading entities...');
  const entitiesData = JSON.parse(fs.readFileSync(entitiesFilePath, 'utf8'));
  let entities = entitiesData.entities || [];

  if (verbose) {
    console.log(`  Loaded ${entities.length} entities`);
  }

  // Step 2: Parse chapters
  console.log('[2/6] Parsing chapters...');
  const markdown = fs.readFileSync(inputPath, 'utf8');
  const chapters = parseChapters(markdown);

  if (verbose) {
    console.log(`  Parsed ${chapters.length} chapters`);
  }

  // Step 3: Build variant lookup
  console.log('[3/6] Building variant lookup...');
  const variantLookup = buildVariantLookup(entities);

  if (verbose) {
    console.log(`  ${variantLookup.size} variant patterns`);
  }

  // Step 4: Extract snippets
  console.log('[4/6] Extracting snippets...');
  const rawSnippets = extractSnippets(chapters, variantLookup, { verbose });

  if (verbose) {
    console.log(`  Extracted ${rawSnippets.length} raw snippets`);
  }

  // Step 5: Deduplicate
  console.log('[5/6] Deduplicating overlapping snippets...');
  const snippets = dedupeSnippets(rawSnippets);

  console.log(`  ${rawSnippets.length} -> ${snippets.length} snippets (${Math.round((1 - snippets.length / rawSnippets.length) * 100)}% reduction)`);

  // Step 6: Build indices and output
  console.log('[6/6] Building indices and writing output...');

  const entityIndex = buildEntityIndex(snippets);
  const cooccurrenceIndex = buildCooccurrenceIndex(snippets);
  const chapterIndex = buildChapterIndex(snippets);

  // Write snippets.jsonl
  const snippetsPath = path.join(outputPath, 'snippets.jsonl');
  const snippetsContent = snippets.map(s => JSON.stringify(s)).join('\n');
  fs.writeFileSync(snippetsPath, snippetsContent);

  // Write entity_index.json
  fs.writeFileSync(
    path.join(outputPath, 'entity_index.json'),
    JSON.stringify(entityIndex, null, 2)
  );

  // Write cooccurrence_index.json
  fs.writeFileSync(
    path.join(outputPath, 'cooccurrence_index.json'),
    JSON.stringify(cooccurrenceIndex, null, 2)
  );

  // Build and write stats
  const stats = buildStats(rawSnippets, snippets, entities, entityIndex, cooccurrenceIndex, chapterIndex);
  stats.source = path.basename(inputPath);
  fs.writeFileSync(
    path.join(outputPath, 'stats.json'),
    JSON.stringify(stats, null, 2)
  );

  // Generate review.md
  console.log('  Generating review.md...');
  generateReview(snippets, entities, entityIndex, cooccurrenceIndex, stats, outputPath);

  // Print summary
  console.log('\n=== Extraction Complete ===\n');
  console.log(`Total Snippets:    ${snippets.length}`);
  console.log(`Entities Indexed:  ${Object.keys(entityIndex).length}`);
  console.log(`Co-occurrence Pairs: ${Object.keys(cooccurrenceIndex).length}`);
  console.log('');

  console.log('Top entities by snippets:');
  const topEntities = Object.entries(entityIndex)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  for (const [entityId, snippetIds] of topEntities) {
    const entity = entities.find(e => e.id === entityId);
    const name = entity ? entity.canonicalName : entityId;
    console.log(`  ${name}: ${snippetIds.length} snippets`);
  }
  console.log('');

  console.log('Top co-occurrences:');
  const topCooc = getTopCooccurrences(cooccurrenceIndex, 5);
  for (const { pair, count } of topCooc) {
    console.log(`  ${pair}: ${count} snippets`);
  }
  console.log('');

  console.log('Output files:');
  console.log(`  ${outputPath}/snippets.jsonl`);
  console.log(`  ${outputPath}/entity_index.json`);
  console.log(`  ${outputPath}/cooccurrence_index.json`);
  console.log(`  ${outputPath}/stats.json`);
  console.log(`  ${outputPath}/review.md`);
}

// Run
const args = parseArgs();
extractSnippetsPipeline(args).catch(err => {
  console.error('Extraction failed:', err);
  console.error(err.stack);
  process.exit(1);
});
