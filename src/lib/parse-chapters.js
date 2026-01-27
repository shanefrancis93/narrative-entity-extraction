/**
 * parse-chapters.js
 *
 * Parses markdown text into chapters with number, title, and text content.
 * Handles YAML frontmatter and chapter header format: ## CHAPTER ONE: TITLE
 */

// Map word numbers to digits
const WORD_TO_NUM = {
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
  'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20
};

/**
 * Parse chapter number from header text
 * @param {string} headerText - e.g., "CHAPTER ONE" or "CHAPTER 1"
 * @returns {number} Chapter number
 */
function parseChapterNumber(headerText) {
  // Try numeric: "CHAPTER 1"
  const numMatch = headerText.match(/chapter\s+(\d+)/i);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }

  // Try word: "CHAPTER ONE"
  const wordMatch = headerText.match(/chapter\s+(\w+)/i);
  if (wordMatch) {
    const word = wordMatch[1].toLowerCase();
    if (WORD_TO_NUM[word]) {
      return WORD_TO_NUM[word];
    }
  }

  return 0;
}

/**
 * Parse markdown text into chapters
 * @param {string} markdown - Full markdown text with YAML frontmatter
 * @returns {Array} Array of { number, title, text }
 */
function parseChapters(markdown) {
  // Remove YAML frontmatter
  let text = markdown;
  const frontmatterMatch = markdown.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    text = markdown.slice(frontmatterMatch[0].length);
  }

  // Split by chapter headers: ## CHAPTER ...
  const chapterRegex = /^## CHAPTER\s+(\w+)(?::\s*|\s+)(.+)$/gm;
  const chapters = [];
  let lastIndex = 0;
  let lastChapter = null;
  let match;

  while ((match = chapterRegex.exec(text)) !== null) {
    // Save previous chapter's text
    if (lastChapter !== null) {
      lastChapter.text = text.slice(lastIndex, match.index).trim();
      chapters.push(lastChapter);
    }

    // Parse new chapter
    const chapterWord = match[1];
    const title = match[2].trim();
    const number = parseChapterNumber(`CHAPTER ${chapterWord}`);

    lastChapter = {
      number,
      title,
      text: ''
    };
    lastIndex = match.index + match[0].length;
  }

  // Don't forget the last chapter
  if (lastChapter !== null) {
    lastChapter.text = text.slice(lastIndex).trim();
    chapters.push(lastChapter);
  }

  return chapters;
}

/**
 * Split chapter text into paragraphs
 * @param {string} text - Chapter text
 * @returns {Array<string>} Array of paragraphs (non-empty)
 */
function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 0);
}

module.exports = {
  parseChapters,
  splitParagraphs,
  parseChapterNumber
};
