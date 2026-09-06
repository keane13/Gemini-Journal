/**
 * @file lib/server/locale.ts
 * Entry language & locale detector.
 *
 * Automatically detects whether a journal entry is written in Indonesian,
 * Spanish, French, German, Japanese, or English so auto-generated titles
 * and synthesis metadata match the user's authentic language.
 */

export interface DetectedLocale {
  language: string;
  locale: string;
}

/**
 * Detects language from the text content of a journal entry.
 */
export function detectLanguageLocale(text: string, hintedLocale?: string): DetectedLocale {
  if (!text || typeof text !== 'string') {
    return { language: 'English', locale: hintedLocale || 'en-US' };
  }

  // Indonesian: common particles, prepositions, pronouns
  const indonesianMatches = text.match(
    /\b(saya|aku|kami|kita|kamu|anda|dia|mereka|ini|itu|yang|dan|di|ke|dari|untuk|dengan|pada|adalah|tidak|bukan|bisa|sudah|akan|hari|karena|saat|jadi|lebih|sangat|banyak|sekali|jalan|rumah|kerja|merasa|pikiran|hati|tapi|namun|juga)\b/gi
  );
  if (indonesianMatches && indonesianMatches.length >= 2) {
    return { language: 'Indonesian', locale: 'id-ID' };
  }

  // Spanish
  const spanishMatches = text.match(
    /\b(el|la|los|las|un|una|unos|unas|y|o|pero|por|para|con|de|en|que|es|son|fue|era|hoy|ayer|mañana|estoy|está|tengo|tiene|sentir|vida|año|hacer|tiempo)\b/gi
  );
  if (spanishMatches && spanishMatches.length >= 3) {
    return { language: 'Spanish', locale: 'es-ES' };
  }

  // French
  const frenchMatches = text.match(
    /\b(le|la|les|un|une|des|et|ou|mais|pour|avec|dans|sur|qui|que|est|sont|aujourd'hui|hier|demain|suis|pensée|sentiment|faire|tout|nous|vous)\b/gi
  );
  if (frenchMatches && frenchMatches.length >= 3) {
    return { language: 'French', locale: 'fr-FR' };
  }

  // German
  const germanMatches = text.match(
    /\b(der|die|das|den|dem|des|ein|eine|und|oder|aber|für|mit|von|zu|auf|in|ist|sind|war|heute|gestern|morgen|ich|gefühl|gedanken|nicht|auch)\b/gi
  );
  if (germanMatches && germanMatches.length >= 3) {
    return { language: 'German', locale: 'de-DE' };
  }

  // Japanese
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text)) {
    return { language: 'Japanese', locale: 'ja-JP' };
  }

  // Check hint if provided
  if (hintedLocale && hintedLocale.startsWith('id')) {
    return { language: 'Indonesian', locale: 'id-ID' };
  }
  if (hintedLocale && hintedLocale.startsWith('es')) {
    return { language: 'Spanish', locale: 'es-ES' };
  }

  return { language: 'English', locale: 'en-US' };
}
