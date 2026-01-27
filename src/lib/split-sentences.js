/**
 * split-sentences.js
 *
 * Splits text into sentences with protection for abbreviations,
 * dialogue, and other edge cases.
 */

// Common abbreviations that shouldn't trigger sentence splits
const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof', 'Sr', 'Jr',
  'St', 'vs', 'etc', 'Inc', 'Ltd', 'Co',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

// Placeholder for protected periods
const DOT_PLACEHOLDER = '<<<DOT>>>';

/**
 * Split text into sentences
 * @param {string} text - Text to split
 * @returns {Array<string>} Array of sentences
 */
function splitSentences(text) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  let processed = text;

  // Protect abbreviations
  for (const abbr of ABBREVIATIONS) {
    // Match abbreviation followed by period (case-insensitive for the first letter)
    const regex = new RegExp(`\\b(${abbr})\\.`, 'gi');
    processed = processed.replace(regex, `$1${DOT_PLACEHOLDER}`);
  }

  // Protect initials (single capital letter followed by period)
  // e.g., "J. K. Rowling" -> "J<<DOT>> K<<DOT>> Rowling"
  processed = processed.replace(/\b([A-Z])\./g, `$1${DOT_PLACEHOLDER}`);

  // Protect ellipsis
  processed = processed.replace(/\.\.\./g, '<<<ELLIPSIS>>>');

  // Protect decimal numbers
  processed = processed.replace(/(\d)\.(\d)/g, `$1${DOT_PLACEHOLDER}$2`);

  // Split on sentence-ending punctuation followed by space and capital letter
  // Also handle quotes: ." or !"
  const sentenceEndRegex = /([.!?]["']?)\s+(?=[A-Z"'])/g;
  const parts = processed.split(sentenceEndRegex);

  // Reassemble sentences (split captures the delimiter, so we need to rejoin)
  const sentences = [];
  for (let i = 0; i < parts.length; i += 2) {
    let sentence = parts[i];
    if (i + 1 < parts.length) {
      sentence += parts[i + 1]; // Add back the punctuation
    }
    sentence = sentence.trim();
    if (sentence.length > 0) {
      // Restore protected characters
      sentence = sentence
        .replace(/<<<DOT>>>/g, '.')
        .replace(/<<<ELLIPSIS>>>/g, '...');
      sentences.push(sentence);
    }
  }

  // Handle case where no splits occurred
  if (sentences.length === 0 && text.trim().length > 0) {
    return [text.trim()
      .replace(/<<<DOT>>>/g, '.')
      .replace(/<<<ELLIPSIS>>>/g, '...')];
  }

  return sentences;
}

module.exports = {
  splitSentences
};
