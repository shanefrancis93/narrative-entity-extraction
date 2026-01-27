#!/usr/bin/env node

/**
 * basic-extraction.js
 *
 * Demonstrates the entity extraction pipeline programmatically.
 * Runs discovery on a small inline text sample (no external files needed).
 */

const path = require('path');
const fs = require('fs');

// Import pipeline modules
const { extractProperNouns } = require('../src/lib/extract-proper-nouns');
const { groupVariants } = require('../src/lib/group-variants');
const { filterJunk } = require('../src/lib/filter-junk');
const { tierEntities } = require('../src/lib/tier-entities');

// Sample fiction text (markdown format with chapter headers)
const SAMPLE_TEXT = `---
title: The Quest for the Silver Crown
---

## CHAPTER ONE: The Arrival

Lord Aldric Blackwood had not visited the village of Thornhaven in twenty years.
His arrival at the old manor caused quite a stir. Mrs. Pemberton, the innkeeper,
nearly dropped her teapot when she saw Lord Blackwood's carriage roll through the
cobblestone streets.

"Lord Blackwood!" Mrs. Pemberton cried, rushing to the door. "We thought you'd
never return!"

Aldric stepped from the carriage, his weathered face betraying no emotion. Behind
him, his young ward Elena clutched a leather satchel. Elena's eyes were wide as
she took in the crumbling stone buildings and the fog rolling in from the moors.

Professor Hartwell was waiting at the manor gates. The old scholar had been
Aldric's tutor in his youth, and now served as caretaker of the Blackwood estate.
Professor Hartwell's white beard had grown considerably since their last meeting.

"The library is intact," Hartwell reported. "But I must warn you—Sir Maddox has
been asking questions. Sir Maddox came twice last month, demanding to see the
archives."

Aldric frowned. Sir Maddox was his cousin, and they had not parted on good terms.
Maddox's interest in the family archives could mean only one thing: he knew about
the Silver Crown.

## CHAPTER TWO: The Library

Elena spent her first morning exploring the manor's vast library. She found
Professor Hartwell already there, surrounded by towering stacks of leather-bound
volumes.

"Elena, come look at this," Hartwell said, beckoning her to his desk. He held
up a faded map. "This shows the location of Queen Isolde's tomb. Queen Isolde
was the last to wear the Silver Crown before it was hidden."

Elena studied the map carefully. "Professor Hartwell, these markings—they're in
Old Thornish. Can you read them?"

Hartwell nodded. "I've spent years studying the old language. The inscription
says: 'Beyond the Whispering Falls, beneath the Elder Stone.'"

Mrs. Pemberton arrived with lunch, her face flushed with news. "Lord Blackwood,
Sir Maddox is in the village! He's at the inn, asking about you. Maddox brought
three men with him."

Aldric's jaw tightened. "Thank you, Mrs. Pemberton. Elena, we need to move
quickly. Hartwell, prepare the expedition supplies."

Elena exchanged a worried glance with Hartwell. She had known Lord Blackwood's
quest was urgent, but Sir Maddox's presence made it dangerous as well.
`;

// --- Run the pipeline ---

console.log('=== Narrative Entity Extraction - Basic Example ===\n');

// Step 1: Extract proper nouns
console.log('[1/4] Extracting proper nouns...');
const extraction = extractProperNouns(SAMPLE_TEXT, { verbose: false });
console.log(`  Found ${extraction.metadata.totalMentions} mentions, ${extraction.metadata.uniqueForms} unique forms`);

// Step 2: Group variants
console.log('[2/4] Grouping variants...');
const groups = groupVariants(extraction, { verbose: false, minMentions: 2 });
console.log(`  Created ${groups.length} entity groups`);

// Step 3: Filter junk
console.log('[3/4] Filtering junk entities...');
const { clean, excluded } = filterJunk(groups, extraction, SAMPLE_TEXT, { verbose: false });
console.log(`  ${clean.length} clean groups, ${excluded.length} excluded`);

// Step 4: Tier entities
console.log('[4/4] Tiering entities...');
const { confirmedCharacters, candidates } = tierEntities(clean, extraction, {
  verbose: false,
  minCandidateMentions: 2  // Lower threshold for this small sample
});

// Print results
console.log('\n=== Results ===\n');

console.log(`Confirmed Characters (${confirmedCharacters.length}):`);
for (const c of confirmedCharacters) {
  const variants = c.variants.map(v => `${v.form} (${v.count})`).join(', ');
  console.log(`  ${c.canonicalName} — ${c.mentions} mentions [${c.qualifiedBy}]`);
  console.log(`    Variants: ${variants}`);
}

console.log(`\nCandidates (${candidates.length}):`);
for (const c of candidates) {
  console.log(`  ${c.canonicalName} — ${c.mentions} mentions`);
}

if (excluded.length > 0) {
  console.log(`\nExcluded (${excluded.length}):`);
  for (const e of excluded) {
    console.log(`  ${e.text} — ${e.reason}`);
  }
}

// Demonstrate programmatic API output
console.log('\n=== Programmatic Output (JSON) ===\n');
const output = {
  metadata: {
    pipeline: 'entity-discovery-v2',
    confirmedCount: confirmedCharacters.length,
    candidateCount: candidates.length
  },
  confirmedCharacters: confirmedCharacters.map(c => ({
    id: c.id,
    name: c.canonicalName,
    mentions: c.mentions,
    qualifiedBy: c.qualifiedBy
  }))
};
console.log(JSON.stringify(output, null, 2));

console.log('\nDone! To run on your own text:');
console.log('  node src/discover.js --input your-book.md --output ./output --no-coref --verbose');
