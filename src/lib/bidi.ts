// Arabic / mixed-direction text layout for writing into PDFs.
//
// A PDF has no idea about "right-to-left": it just places glyphs at x,y. So we
// must do what a browser does before drawing:
//   1. Unicode Bidirectional Algorithm (UBA) -> split a line into runs and put
//      them in *visual* left-to-right order (bidi-js does the UBA).
//   2. Arabic shaping (choose initial/medial/final/isolated letter forms and
//      ligatures like لا) -> done by fontkit inside pdf-lib when it lays out a
//      run whose script is Arabic. fontkit also reverses the glyphs of an Arabic
//      run itself, so we hand it Arabic runs in logical order.
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

export interface VisualRun {
  text: string; // text to hand to the font engine
  rtl: boolean;
}

export function isRtlText(text: string): boolean {
  const { paragraphs } = bidi.getEmbeddingLevels(text, 'auto');
  return (paragraphs[0]?.level ?? 0) % 2 === 1;
}

/** First strong character decides direction, like HTML dir="auto". */
export function baseDirection(text: string): 'rtl' | 'ltr' {
  return isRtlText(text) ? 'rtl' : 'ltr';
}

/**
 * Split one line (no newlines) into runs in visual order (left to right).
 */
export function visualRuns(line: string, base: 'rtl' | 'ltr' | 'auto' = 'auto'): VisualRun[] {
  if (!line) return [];
  const result = bidi.getEmbeddingLevels(line, base);
  const levels = result.levels;
  const mirrors = bidi.getMirroredCharactersMap(line, levels);

  // 1) group consecutive characters with the same level into logical runs
  type Run = { start: number; end: number; level: number };
  const runs: Run[] = [];
  for (let i = 0; i < line.length; i++) {
    const lvl = levels[i];
    const last = runs[runs.length - 1];
    if (last && last.level === lvl && last.end === i - 1) last.end = i;
    else runs.push({ start: i, end: i, level: lvl });
  }

  // 2) UBA rule L2: from the highest level down to the lowest odd level,
  //    reverse every contiguous sequence of runs at that level or higher.
  const maxLevel = Math.max(...runs.map((r) => r.level));
  const minOdd = Math.min(...runs.map((r) => (r.level % 2 ? r.level : r.level + 1)));
  for (let lvl = maxLevel; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < runs.length) {
      if (runs[i].level >= lvl) {
        let j = i;
        while (j + 1 < runs.length && runs[j + 1].level >= lvl) j++;
        const slice = runs.slice(i, j + 1).reverse();
        runs.splice(i, slice.length, ...slice);
        i = j + 1;
      } else i++;
    }
  }

  // 3) produce text per run. RTL runs get mirrored brackets. If the run has
  //    Arabic/Hebrew letters the font engine reverses it; otherwise (e.g. a
  //    lone "(" or " - " inside Arabic) we reverse the characters ourselves.
  return runs.map((r) => {
    const rtl = r.level % 2 === 1;
    let chars = Array.from(line.slice(r.start, r.end + 1));
    if (rtl) {
      chars = chars.map((c, k) => mirrors.get(r.start + k) ?? c);
      const text = chars.join('');
      if (!RTL_LETTER.test(text)) return { text: Array.from(text).reverse().join(''), rtl };
      return { text, rtl };
    }
    return { text: chars.join(''), rtl };
  });
}

/**
 * Greedy word wrap in logical order. Widths do not depend on visual order, so
 * we can wrap before reordering. Explicit newlines always break.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (para === '') {
      out.push('');
      continue;
    }
    const words = para.split(/(\s+)/); // keep separators
    let line = '';
    for (const token of words) {
      if (token === '') continue;
      const candidate = line + token;
      if (line.trim() !== '' && measure(candidate.trimEnd()) > maxWidth && token.trim() !== '') {
        out.push(line.trimEnd());
        line = token;
        // a single word longer than the box: hard-break it
        while (measure(line) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
