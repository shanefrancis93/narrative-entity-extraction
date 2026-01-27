#!/usr/bin/env node

/**
 * query.js
 *
 * Query interface for entity extraction output.
 * Retrieves entity context from snippet extraction results.
 *
 * Usage:
 *   node src/query.js --data-dir path/to/output --entity "Quirrell" --max 5
 *   node src/query.js --data-dir path/to/output --entity "Quirrell" --with "Snape" --max 5
 *   node src/query.js --data-dir path/to/output --list
 *   node src/query.js --data-dir path/to/output --search "dumble"
 *
 * Options:
 *   --data-dir    Directory containing extraction output (required)
 *   --entities    Path to confirmed_characters.json (default: <data-dir>/confirmed_characters.json)
 *   --json        Output as JSON instead of human-readable
 *   --max N       Maximum snippets to return (default: 10)
 */

const fs = require('fs');
const path = require('path');

// Paths configured at init
let DATA_DIR = null;
let ENTITIES_FILE = null;

// Lazy-loaded data
let snippetsCache = null;
let entityIndexCache = null;
let cooccurrenceIndexCache = null;
let entitiesCache = null;

/**
 * Initialize data paths. Must be called before using query functions.
 * @param {Object} options - { dataDir, entitiesFile }
 */
function init(options = {}) {
  const { dataDir, entitiesFile } = options;
  if (!dataDir) {
    throw new Error('dataDir is required. Pass --data-dir <path> on CLI or call init({ dataDir }).');
  }
  DATA_DIR = path.resolve(dataDir);
  ENTITIES_FILE = entitiesFile
    ? path.resolve(entitiesFile)
    : path.join(DATA_DIR, 'confirmed_characters.json');

  // Reset caches
  snippetsCache = null;
  entityIndexCache = null;
  cooccurrenceIndexCache = null;
  entitiesCache = null;
}

/**
 * Load snippets from JSONL (lazy)
 */
function loadSnippets() {
  if (snippetsCache) return snippetsCache;
  const content = fs.readFileSync(path.join(DATA_DIR, 'snippets.jsonl'), 'utf8');
  snippetsCache = content.trim().split('\n').map(line => JSON.parse(line));
  return snippetsCache;
}

/**
 * Load entity index (lazy)
 */
function loadEntityIndex() {
  if (entityIndexCache) return entityIndexCache;
  entityIndexCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'entity_index.json'), 'utf8'));
  return entityIndexCache;
}

/**
 * Load cooccurrence index (lazy)
 */
function loadCooccurrenceIndex() {
  if (cooccurrenceIndexCache) return cooccurrenceIndexCache;
  cooccurrenceIndexCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cooccurrence_index.json'), 'utf8'));
  return cooccurrenceIndexCache;
}

/**
 * Load entities from confirmed characters (lazy)
 */
function loadEntities() {
  if (entitiesCache) return entitiesCache;
  const data = JSON.parse(fs.readFileSync(ENTITIES_FILE, 'utf8'));
  entitiesCache = data.entities || [];
  return entitiesCache;
}

/**
 * Fuzzy match entity name against all known entities
 * @param {string} searchTerm - Search term (partial, case-insensitive)
 * @returns {Object|null} Matched entity or null
 */
function findEntity(searchTerm) {
  const entities = loadEntities();
  const term = searchTerm.toLowerCase().trim();

  // Exact ID match
  const exactId = entities.find(e => e.id === term);
  if (exactId) return exactId;

  // Exact canonical name match (case-insensitive)
  const exactName = entities.find(e => e.canonicalName.toLowerCase() === term);
  if (exactName) return exactName;

  // Partial match on canonical name
  const partialName = entities.find(e => e.canonicalName.toLowerCase().includes(term));
  if (partialName) return partialName;

  // Check variants
  for (const entity of entities) {
    for (const v of entity.variants || []) {
      if (v.form.toLowerCase() === term || v.form.toLowerCase().includes(term)) {
        return entity;
      }
    }
  }

  return null;
}

/**
 * Get snippets for an entity
 * @param {string} entityName - Entity name (fuzzy matched)
 * @param {Object} options - { maxSnippets: 10 }
 * @returns {Array} Array of snippet objects
 */
function getEntityContext(entityName, options = {}) {
  const { maxSnippets = 10 } = options;

  const entity = findEntity(entityName);
  if (!entity) return [];

  const entityIndex = loadEntityIndex();
  const snippetIds = entityIndex[entity.id] || [];

  const snippets = loadSnippets();
  const snippetMap = new Map(snippets.map(s => [s.id, s]));

  return snippetIds
    .slice(0, maxSnippets)
    .map(id => snippetMap.get(id))
    .filter(Boolean);
}

/**
 * Get snippets where two entities appear together
 * @param {string} entityA - First entity name
 * @param {string} entityB - Second entity name
 * @param {Object} options - { maxSnippets: 10 }
 * @returns {Array} Array of snippets containing both
 */
function getCooccurrenceContext(entityA, entityB, options = {}) {
  const { maxSnippets = 10 } = options;

  const entA = findEntity(entityA);
  const entB = findEntity(entityB);
  if (!entA || !entB) return [];

  // Build cooccurrence key (alphabetically sorted)
  const ids = [entA.id, entB.id].sort();
  const key = `${ids[0]}+${ids[1]}`;

  const cooccurrenceIndex = loadCooccurrenceIndex();
  const snippetIds = cooccurrenceIndex[key] || [];

  const snippets = loadSnippets();
  const snippetMap = new Map(snippets.map(s => [s.id, s]));

  return snippetIds
    .slice(0, maxSnippets)
    .map(id => snippetMap.get(id))
    .filter(Boolean);
}

/**
 * List all entities with counts
 * @param {Object} options - { sortBy: 'snippets' | 'mentions' }
 * @returns {Array} Array of { id, name, snippetCount, mentionCount }
 */
function listEntities(options = {}) {
  const { sortBy = 'snippets' } = options;

  const entities = loadEntities();
  const entityIndex = loadEntityIndex();

  const result = entities.map(e => ({
    id: e.id,
    name: e.canonicalName,
    snippetCount: (entityIndex[e.id] || []).length,
    mentionCount: e.mentions || 0
  }));

  if (sortBy === 'mentions') {
    result.sort((a, b) => b.mentionCount - a.mentionCount);
  } else {
    result.sort((a, b) => b.snippetCount - a.snippetCount);
  }

  return result;
}

/**
 * Format snippet for human-readable output
 */
function formatSnippet(s) {
  const lines = [];
  lines.push(`[${s.id}] Chapter ${s.chapter}: ${s.chapterTitle}`);
  lines.push(`  Before: ${s.text.before || '(start)'}`);
  lines.push(`  Match: ${s.text.match}`);
  lines.push(`  After: ${s.text.after || '(end)'}`);
  lines.push(`  Entities: ${s.entities.join(', ')}`);
  return lines.join('\n');
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };
  const hasFlag = (flag) => args.includes(flag);

  const dataDir = getArg('--data-dir');
  const entitiesFile = getArg('--entities');
  const jsonOutput = hasFlag('--json');
  const entityName = getArg('--entity');
  const withEntity = getArg('--with');
  const maxSnippets = parseInt(getArg('--max') || '10', 10);
  const searchTerm = getArg('--search');
  const doList = hasFlag('--list');

  if (!dataDir) {
    console.error('Error: --data-dir is required');
    console.log(`
Usage:
  node src/query.js --data-dir <path> --entity "Quirrell" [--max 5]
  node src/query.js --data-dir <path> --entity "Quirrell" --with "Snape" [--max 5]
  node src/query.js --data-dir <path> --list
  node src/query.js --data-dir <path> --search "dumble"

Options:
  --data-dir  Directory containing extraction output (required)
  --entities  Path to confirmed_characters.json (default: <data-dir>/confirmed_characters.json)
  --json      Output as JSON instead of human-readable
  --max N     Maximum snippets to return (default: 10)
`);
    process.exit(1);
  }

  init({ dataDir, entitiesFile });

  try {
    if (doList) {
      const entities = listEntities();
      if (jsonOutput) {
        console.log(JSON.stringify(entities, null, 2));
      } else {
        console.log(`\n=== All Entities (${entities.length}) ===\n`);
        for (const e of entities) {
          console.log(`${e.name}: ${e.snippetCount} snippets, ${e.mentionCount} mentions`);
        }
      }
    } else if (searchTerm) {
      const entity = findEntity(searchTerm);
      if (jsonOutput) {
        console.log(JSON.stringify(entity, null, 2));
      } else if (entity) {
        const entityIndex = loadEntityIndex();
        const count = (entityIndex[entity.id] || []).length;
        console.log(`\nFound: ${entity.canonicalName} (${entity.id})`);
        console.log(`Snippets: ${count}, Mentions: ${entity.mentions}`);
      } else {
        console.log(`No entity found matching "${searchTerm}"`);
      }
    } else if (entityName && withEntity) {
      const snippets = getCooccurrenceContext(entityName, withEntity, { maxSnippets });
      if (jsonOutput) {
        console.log(JSON.stringify(snippets, null, 2));
      } else {
        const entA = findEntity(entityName);
        const entB = findEntity(withEntity);
        console.log(`\n=== ${entA?.canonicalName || entityName} + ${entB?.canonicalName || withEntity} (${snippets.length} snippets) ===\n`);
        for (const s of snippets) {
          console.log(formatSnippet(s));
          console.log('');
        }
      }
    } else if (entityName) {
      const snippets = getEntityContext(entityName, { maxSnippets });
      if (jsonOutput) {
        console.log(JSON.stringify(snippets, null, 2));
      } else {
        const entity = findEntity(entityName);
        const entityIndex = loadEntityIndex();
        const total = (entityIndex[entity?.id] || []).length;
        console.log(`\n=== ${entity?.canonicalName || entityName} (${total} total, showing ${snippets.length}) ===\n`);
        for (const s of snippets) {
          console.log(formatSnippet(s));
          console.log('');
        }
      }
    } else {
      console.log(`
Usage:
  node src/query.js --data-dir <path> --entity "Quirrell" [--max 5]
  node src/query.js --data-dir <path> --entity "Quirrell" --with "Snape" [--max 5]
  node src/query.js --data-dir <path> --list
  node src/query.js --data-dir <path> --search "dumble"

Options:
  --data-dir  Directory containing extraction output (required)
  --entities  Path to confirmed_characters.json (default: <data-dir>/confirmed_characters.json)
  --json      Output as JSON instead of human-readable
  --max N     Maximum snippets to return (default: 10)
`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

module.exports = {
  init,
  findEntity,
  getEntityContext,
  getCooccurrenceContext,
  listEntities
};
