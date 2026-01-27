# narrative-entity-extraction

Extract characters, locations, and relationships from fiction text using regex heuristics + optional LLM co-reference resolution.

**Zero LLM required for core pipeline.** The extraction, grouping, filtering, and tiering stages are entirely regex-based. LLM co-reference (merging "Vernon" + "Uncle Vernon" + "Mr Dursley" into one entity) is optional and costs ~$0.002 per book.

## What It Does

Given a fiction text (markdown), the pipeline:

1. **Extracts** proper nouns with position tracking (chapter, paragraph, sentence)
2. **Groups** name variants ("Harry Potter" ← "Harry" ← "Potter" ← "Mr. Potter")
3. **Filters** false positives using heuristics (sentence-start ratio, truncated phrases, list-separated names)
4. **Tiers** entities into confirmed characters vs. candidates needing review
5. **Optionally merges** co-references via LLM ("Voldemort" = "You-Know-Who")
6. **Extracts snippets** around every entity mention with context windows
7. **Builds indices** for entity lookup and co-occurrence discovery

**Tested on Harry Potter Book 1:** 31 confirmed entities, 525 snippets, ~$0.002 LLM cost.

## Quick Start

```bash
# Install
git clone https://github.com/shanefrancis93/narrative-entity-extraction.git
cd narrative-entity-extraction
npm install

# Run the example (no API key needed)
node examples/basic-extraction.js

# Run on your own text (no LLM)
node src/discover.js --input your-book.md --output ./output --no-coref --verbose

# Run with LLM co-reference (requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=sk-ant-...
node src/discover.js --input your-book.md --output ./output --verbose

# Extract snippets (Phase 2)
node src/extract-snippets.js \
  --input your-book.md \
  --entities ./output/confirmed_characters.json \
  --output ./output/snippets

# Query results
node src/query.js --data-dir ./output/snippets --list
node src/query.js --data-dir ./output/snippets --entity "Harry" --max 5
node src/query.js --data-dir ./output/snippets --entity "Harry" --with "Snape"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ENTITY DISCOVERY PIPELINE                        │
│                         (discover.js)                               │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [1] EXTRACTION              extract-proper-nouns.js                │
│  • Regex-based proper noun extraction (capitalized words)           │
│  • Tracks: mentionCounts, possessiveCounts, sentenceStartCounts     │
│  • Normalizes Unicode apostrophes (curly → straight)                │
│  • Chapter-aware processing with firstAppearance tracking           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [2] GROUPING                group-variants.js                      │
│  • Groups: "Harry Potter" ← "Harry" ← "Potter" ← "Mr Potter"      │
│  • Detects titled names (Mr/Mrs/Professor X)                        │
│  • Skips false full names where both parts are high-frequency       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [3] FILTERING               filter-junk.js                         │
│  • Sentence-start ratio >50% → likely common word, not entity       │
│  • Truncated phrases (first word in 3+ other two-word entities)     │
│  • List-separated names ("Malfoy Crabbe" from comma lists)          │
│  • High-frequency both words (two separate characters concatenated) │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [4] TIERING                 tier-entities.js                       │
│  Confirmed Characters (ANY of):                                     │
│  • Has title pattern (Professor X, Mr X, Uncle X)                   │
│  • Two-word name, both parts appear 10+ times independently         │
│  • Single name 20+ mentions WITH possessive 5+ times                │
│                                                                     │
│  Candidates: 8+ mentions but doesn't qualify for confirmed          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [5] LLM CO-REFERENCE (optional)  llm-coref-merge.js               │
│  • Uses Claude 3.5 Haiku via Anthropic SDK (~$0.002/run)            │
│  • Merges: "Vernon" + "Uncle Vernon" + "Mr Dursley" → one entity    │
│  • Pluggable: bring your own LLM provider (OpenAI, OpenRouter, etc) │
│  • Graceful degradation: pipeline continues if LLM fails            │
└─────────────────────────────────────────────────────────────────────┘
```

## Output Schema

### confirmed_characters.json

```json
{
  "metadata": {
    "source": "book1.md",
    "pipeline": "entity-discovery-v2-coref",
    "corefApplied": true
  },
  "entities": [{
    "id": "harry_potter",
    "canonicalName": "Harry Potter",
    "mentions": 1341,
    "variants": [
      { "form": "Harry", "count": 1233 },
      { "form": "Potter", "count": 57 }
    ],
    "qualifiedBy": "title_pattern",
    "mergedFrom": ["Potters"],
    "firstAppearance": { "chapter": 1, "paragraph": 0 }
  }]
}
```

### snippets.jsonl

Each line is a JSON object:

```json
{
  "id": "s_0042",
  "chapter": 3,
  "chapterTitle": "The Letters from No One",
  "text": {
    "before": "He looked back at the letter.",
    "match": "Harry picked up the envelope and stared at it.",
    "after": "No one ever wrote to him."
  },
  "entities": ["harry_potter"],
  "mentions": [{ "entity": "harry_potter", "variant": "Harry", "sentence": "match" }]
}
```

### Other outputs

- `candidates.json` — Entities needing human review
- `stats.json` — Pipeline statistics and co-reference details
- `entity_index.json` — Entity ID → snippet IDs mapping
- `cooccurrence_index.json` — Entity pair → snippet IDs mapping
- `review.md` — Human-readable audit report (from snippet extraction)

## Programmatic API

```javascript
const { extractProperNouns } = require('./src/lib/extract-proper-nouns');
const { groupVariants } = require('./src/lib/group-variants');
const { filterJunk } = require('./src/lib/filter-junk');
const { tierEntities } = require('./src/lib/tier-entities');

const text = fs.readFileSync('book.md', 'utf8');

// Run the pipeline
const extraction = extractProperNouns(text);
const groups = groupVariants(extraction, { minMentions: 3 });
const { clean } = filterJunk(groups, extraction, text);
const { confirmedCharacters, candidates } = tierEntities(clean, extraction);

console.log(confirmedCharacters); // High-confidence characters
```

## LLM Co-Reference

The optional LLM step merges entities that the regex pipeline can't connect (e.g., aliases, nicknames).

### Default: Anthropic SDK

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node src/discover.js --input book.md --output ./output --verbose
```

### Custom LLM Provider

Pass a custom `llmProvider` function to use any LLM:

```javascript
const { llmCorefMerge } = require('./src/lib/llm-coref-merge');

// Example: OpenAI provider
async function openaiProvider({ system, messages, max_tokens, temperature }) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens,
    temperature,
    messages: [{ role: 'system', content: system }, ...messages]
  });
  return {
    content: response.choices[0].message.content,
    usage: {
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens
    }
  };
}

const result = await llmCorefMerge(entityNames, { llmProvider: openaiProvider });
```

### Skip LLM entirely

```bash
node src/discover.js --input book.md --output ./output --no-coref
```

## CLI Reference

### discover.js — Entity Discovery

```bash
node src/discover.js \
  --input <file>        # Input markdown file (required)
  --output <dir>        # Output directory (required)
  --min-mentions <n>    # Minimum mentions for candidates (default: 8)
  --no-coref            # Skip LLM co-reference resolution
  --verbose             # Enable detailed logging
```

### extract-snippets.js — Snippet Extraction

```bash
node src/extract-snippets.js \
  --input <file>        # Input markdown file (required)
  --entities <file>     # confirmed_characters.json (required)
  --output <dir>        # Output directory (required)
  --include-candidates  # Also extract snippets for candidate entities
  --verbose             # Enable detailed logging
```

### query.js — Query Interface

```bash
node src/query.js \
  --data-dir <dir>      # Directory with extraction output (required)
  --entity <name>       # Search for entity (fuzzy match)
  --with <name>         # Co-occurrence with another entity
  --search <term>       # Search entity by name
  --list                # List all entities
  --json                # Output as JSON
  --max <n>             # Max snippets (default: 10)
```

## Known Issues

1. **LLM Co-ref Over-Merges**: Haiku sometimes merges family names with individuals (e.g., "Potters" with "Harry Potter"). Use `--no-coref` for conservative results.

2. **Sentence-Start Filter**: Real characters can be excluded if their names frequently start sentences (>50% ratio). Check `debug/excluded.json` and manually add back.

3. **Possessive Objects**: Items with possessive forms (e.g., "Sorcerer's Stone") may be classified as characters. Review candidates.json.

## Input Format

The pipeline expects markdown with chapter headers in this format:

```markdown
---
title: Book Title
---

## CHAPTER ONE: The Beginning

Story text here...

## CHAPTER TWO: The Journey

More story text...
```

Chapter headers must match `## CHAPTER <NUMBER/WORD>: <TITLE>`. The word-to-number mapping supports "one" through "twenty" and numeric digits.

## License

MIT
