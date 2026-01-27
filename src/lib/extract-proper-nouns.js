/**
 * extract-proper-nouns.js
 *
 * Extracts proper nouns from markdown text with position tracking.
 * Handles multi-word names, possessives, and title patterns.
 */

const fs = require('fs');
const path = require('path');

/**
 * Normalize all apostrophe variants to standard straight apostrophe
 * Handles: ' (U+2019 right curly), ' (U+2018 left curly), ʼ (U+02BC modifier)
 */
function normalizeApostrophes(str) {
  if (!str) return '';
  return str.replace(/[\u2018\u2019\u02BC']/g, "'");
}

// Load config
const configDir = path.join(__dirname, '..', 'config');
const stopwords = JSON.parse(fs.readFileSync(path.join(configDir, 'stopwords.json'), 'utf8'));
const titlePatterns = JSON.parse(fs.readFileSync(path.join(configDir, 'title-patterns.json'), 'utf8'));

// Build lookup sets (normalize apostrophes for consistent matching)
const stopwordSet = new Set(stopwords.words.map(w => normalizeApostrophes(w).toLowerCase()));
const chapterPatterns = new Set(stopwords.chapterStartPatterns.map(p => p.toLowerCase()));
const titlePrefixes = new Set(titlePatterns.patterns.map(p => p.pattern.toLowerCase()));

/**
 * Extract proper nouns from markdown text
 * @param {string} text - The markdown content
 * @param {Object} options - Extraction options
 * @returns {Object} Extraction results with mentions and metadata
 */
function extractProperNouns(text, options = {}) {
  const { verbose = false } = options;

  // Parse the document
  const lines = text.split('\n');
  let inFrontmatter = false;
  let currentChapter = 0;
  let chapterTitle = '';
  let paragraphIndex = 0;

  // Results storage
  const mentions = []; // All individual mentions
  const mentionCounts = {}; // Form (normalized) -> count
  const possessiveCounts = {}; // Base form -> count of possessive mentions
  const sentenceStartCounts = {}; // Form -> count of sentence-start occurrences
  const firstAppearances = {}; // Form -> {chapter, paragraph}

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    // Handle frontmatter
    if (line.trim() === '---') {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;

    // Handle chapter headers
    const chapterMatch = line.match(/^##\s+CHAPTER\s+(\w+):\s*(.*)$/i);
    if (chapterMatch) {
      currentChapter++;
      chapterTitle = chapterMatch[2].trim();
      paragraphIndex = 0;
      if (verbose) console.log(`[Chapter ${currentChapter}] ${chapterTitle}`);
      continue;
    }

    // Skip empty lines, increment paragraph on blank lines
    if (line.trim() === '') {
      paragraphIndex++;
      continue;
    }

    // Extract proper nouns from this line (with sentence-start tracking)
    const lineProperNouns = extractFromLine(line);

    for (const pn of lineProperNouns) {
      const mention = {
        form: pn.form,
        normalized: pn.normalized,
        isPossessive: pn.isPossessive,
        hasTitle: pn.hasTitle,
        titleType: pn.titleType,
        isAtSentenceStart: pn.isAtSentenceStart,
        chapter: currentChapter,
        paragraph: paragraphIndex,
        line: lineIndex + 1
      };

      mentions.push(mention);

      // Track counts
      mentionCounts[pn.normalized] = (mentionCounts[pn.normalized] || 0) + 1;

      // Track possessive counts (for tier classification)
      if (pn.isPossessive) {
        possessiveCounts[pn.normalized] = (possessiveCounts[pn.normalized] || 0) + 1;
      }

      // Track sentence-start counts
      if (pn.isAtSentenceStart) {
        sentenceStartCounts[pn.normalized] = (sentenceStartCounts[pn.normalized] || 0) + 1;
      }

      // Track first appearance
      if (!firstAppearances[pn.normalized]) {
        firstAppearances[pn.normalized] = {
          chapter: currentChapter,
          paragraph: paragraphIndex,
          form: pn.form
        };
      }
    }
  }

  return {
    mentions,
    mentionCounts,
    possessiveCounts,
    sentenceStartCounts,
    firstAppearances,
    metadata: {
      totalMentions: mentions.length,
      uniqueForms: Object.keys(mentionCounts).length,
      chaptersProcessed: currentChapter
    }
  };
}

/**
 * Extract proper nouns from a single line
 * @param {string} line - A line of text
 * @returns {Array} Array of proper noun objects with sentence-start tracking
 */
function extractFromLine(line) {
  const results = [];

  // Tokenize - split on whitespace but preserve punctuation info
  const words = line.split(/\s+/).filter(w => w.length > 0);

  // Build set of word indices that are at sentence start
  // Index 0 is always sentence start, then any word after sentence-ending punctuation
  const sentenceStartIndices = new Set([0]);
  for (let j = 0; j < words.length - 1; j++) {
    if (endsSentence(words[j])) {
      sentenceStartIndices.add(j + 1);
    }
  }

  let i = 0;
  while (i < words.length) {
    const word = words[i];

    // Skip contractions entirely (He'd, I'm, They'll, etc.)
    if (isContraction(word)) {
      i++;
      continue;
    }

    const cleanWord = cleanToken(word);

    // Skip if empty after cleaning or is a stopword
    if (!cleanWord || isStopword(cleanWord)) {
      i++;
      continue;
    }

    // Check if this starts a proper noun
    if (isCapitalized(cleanWord)) {
      const result = extractProperNounSequence(words, i);
      if (result) {
        // Add sentence-start tracking
        result.isAtSentenceStart = sentenceStartIndices.has(i);
        results.push(result);
        i = result.endIndex + 1;
        continue;
      }
    }

    i++;
  }

  return results;
}

/**
 * Extract a proper noun sequence starting at index
 * Handles: "Harry", "Harry Potter", "Mr. Dursley", "Professor McGonagall"
 */
function extractProperNounSequence(words, startIndex) {
  const components = [];
  let hasTitle = false;
  let titleType = null;
  let endIndex = startIndex;

  // Check for title prefix
  const firstWord = cleanToken(words[startIndex]);
  const firstWordLower = firstWord.toLowerCase().replace(/\.$/, ''); // Remove trailing period

  if (titlePrefixes.has(firstWordLower)) {
    hasTitle = true;
    const titleInfo = titlePatterns.patterns.find(
      p => p.pattern.toLowerCase() === firstWordLower
    );
    titleType = titleInfo?.type || 'honorific';
    components.push(firstWord);
    endIndex = startIndex;

    // Move to next word
    if (startIndex + 1 < words.length) {
      const nextWord = cleanToken(words[startIndex + 1]);
      if (nextWord && isCapitalized(nextWord) && !isStopword(nextWord) && !isContraction(words[startIndex + 1])) {
        components.push(nextWord);
        endIndex = startIndex + 1;
      }
    }
  } else {
    // Regular proper noun - collect consecutive capitalized words (max 2 - first+last name)
    for (let i = startIndex; i < words.length && components.length < 2; i++) {
      const rawWord = words[i];
      const word = cleanToken(rawWord);

      if (!word) break;

      // Stop at contractions (He'd, I'm, etc.)
      if (isContraction(rawWord)) break;

      // If this is not the first word, check if previous word ended a sentence
      if (i > startIndex) {
        const prevWord = words[i - 1];
        if (endsSentence(prevWord)) break;
      }

      // Check for possessive form
      const isPossessive = rawWord.includes("'s") && !isContraction(rawWord);
      const baseWord = word.replace(/'s$/i, '');

      if (isCapitalized(baseWord) && !isStopword(baseWord)) {
        // For possessives, only add if it's the last word
        if (isPossessive) {
          components.push(baseWord + "'s");
          endIndex = i;
          break; // Possessive ends the sequence
        } else {
          components.push(word);
          endIndex = i;
        }
      } else {
        break;
      }
    }
  }

  if (components.length === 0) return null;

  // Build the form
  const form = components.join(' ');
  const isPossessive = form.includes("'s");
  const normalized = form.replace(/'s$/i, '').replace(/\.$/, '');

  // Skip if it's a chapter pattern
  if (chapterPatterns.has(normalized.toLowerCase())) return null;

  // Skip single-letter or very short results
  if (normalized.length < 2) return null;

  return {
    form,
    normalized,
    isPossessive,
    hasTitle,
    titleType,
    wordCount: components.length,
    endIndex
  };
}

/**
 * Check if a word is a contraction (not possessive)
 */
function isContraction(word) {
  if (!word) return false;

  // Normalize apostrophes (handle curly quotes)
  const normalized = normalizeApostrophes(word);

  // Check for contraction patterns: He'd, I'm, They'll, We're, etc.
  // These have apostrophe followed by: d, m, ll, re, ve, t
  // Exclude possessives (ends with 's where s is the only letter after apostrophe)
  if (/'s$/i.test(normalized)) {
    // This could be possessive (Harry's) or "is" contraction (He's)
    // If it starts with common pronoun, it's a contraction
    const base = normalized.replace(/'s$/i, '').toLowerCase();
    const pronouns = ['he', 'she', 'it', 'that', 'what', 'who', 'there', 'here', 'where'];
    return pronouns.includes(base);
  }
  // Other contractions: 'd, 'm, 'll, 're, 've, 't
  return /'(d|m|ll|re|ve|t)$/i.test(normalized);
}

/**
 * Check if previous word ends with sentence-ending punctuation
 */
function endsSentence(word) {
  if (!word) return false;
  return /[.!?]["']?$/.test(word);
}

/**
 * Clean a token - remove punctuation but preserve possessives
 */
function cleanToken(word) {
  if (!word) return '';

  // Normalize apostrophes first
  let cleaned = normalizeApostrophes(word);

  // Remove leading/trailing punctuation except apostrophe
  cleaned = cleaned.replace(/^[^a-zA-Z']+/, '').replace(/[^a-zA-Z']+$/, '');

  // Remove trailing period (for Mr. Mrs. etc.)
  cleaned = cleaned.replace(/\.$/, '');

  return cleaned;
}

/**
 * Check if a word is capitalized (proper noun candidate)
 */
function isCapitalized(word) {
  if (!word || word.length === 0) return false;
  return word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
}

/**
 * Check if a word is a stopword
 */
function isStopword(word) {
  // Normalize apostrophes for matching
  const normalized = normalizeApostrophes(word).toLowerCase();
  return stopwordSet.has(normalized) || stopwordSet.has(word.toLowerCase());
}

module.exports = {
  extractProperNouns,
  extractFromLine
};
