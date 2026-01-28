# narrative-entity-extraction

Extract characters and relationships from fiction text using regex heuristics + optional LLM co-reference resolution.

The core pipeline (extraction, grouping, filtering, tiering) is entirely regex-based — no LLM needed. An optional co-reference step uses Claude Haiku to merge aliases (e.g., "Vernon" + "Uncle Vernon" + "Mr Dursley").

## Quick Start

```bash
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
- `review.md` — Human-readable audit report

## Programmatic API

```javascript
const { extractProperNouns } = require('./src/lib/extract-proper-nouns');
const { groupVariants } = require('./src/lib/group-variants');
const { filterJunk } = require('./src/lib/filter-junk');
const { tierEntities } = require('./src/lib/tier-entities');

const text = fs.readFileSync('book.md', 'utf8');

const extraction = extractProperNouns(text);
const groups = groupVariants(extraction, { minMentions: 3 });
const { clean } = filterJunk(groups, extraction, text);
const { confirmedCharacters, candidates } = tierEntities(clean, extraction);
```

## LLM Co-Reference

The optional LLM step merges entities that the regex pipeline can't connect (aliases, nicknames). Default provider uses `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY`.

### Custom LLM Provider

Pass a custom `llmProvider` function to use any LLM:

```javascript
const { llmCorefMerge } = require('./src/lib/llm-coref-merge');

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

### discover.js

```bash
node src/discover.js \
  --input <file>        # Input markdown file (required)
  --output <dir>        # Output directory (required)
  --min-mentions <n>    # Minimum mentions for candidates (default: 8)
  --no-coref            # Skip LLM co-reference resolution
  --verbose             # Enable detailed logging
```

### extract-snippets.js

```bash
node src/extract-snippets.js \
  --input <file>        # Input markdown file (required)
  --entities <file>     # confirmed_characters.json (required)
  --output <dir>        # Output directory (required)
  --include-candidates  # Also extract snippets for candidate entities
  --verbose             # Enable detailed logging
```

### query.js

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

## Architecture

<details>
<summary>Pipeline stages (click to expand)</summary>

```
[1] EXTRACTION — extract-proper-nouns.js
    Regex-based proper noun extraction. Tracks mention counts,
    possessive counts, sentence-start counts. Chapter-aware.

[2] GROUPING — group-variants.js
    Groups name variants: "Harry Potter" ← "Harry" ← "Potter" ← "Mr Potter"
    Detects titled names. Skips false full names.

[3] FILTERING — filter-junk.js
    Sentence-start ratio >50% → excluded
    Truncated phrases → excluded
    List-separated names → excluded

[4] TIERING — tier-entities.js
    Confirmed: has title pattern, OR two-word name with both parts
    appearing 10+ times, OR single name 20+ mentions with possessive 5+.
    Candidates: 8+ mentions but doesn't qualify.

[5] LLM CO-REFERENCE (optional) — llm-coref-merge.js
    Merges aliases via LLM. Pipeline continues if LLM fails.
```

</details>

## Input Format

Markdown with chapter headers:

```markdown
---
title: Book Title
---

## CHAPTER ONE: The Beginning

Story text here...
```

Headers must match `## CHAPTER <NUMBER/WORD>: <TITLE>`. Supports "one" through "twenty" and numeric digits.

## Known Issues

1. **LLM co-ref over-merges**: Haiku sometimes merges family names with individuals (e.g., "Potters" → "Harry Potter"). Use `--no-coref` for conservative results.

2. **Sentence-start filter too aggressive**: Characters whose names frequently start sentences (>50% ratio) get excluded. Check `debug/excluded.json`.

3. **Possessive objects**: Items like "Sorcerer's Stone" may be classified as characters due to possessive forms.

## License

MIT
