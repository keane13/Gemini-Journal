/**
 * @file lib/server/redaction.ts
 * FLAGSHIP FEATURE: "Privacy Shield" Two-Stage Redaction Pipeline.
 *
 * Deterministically detects and masks sensitive personal data before prompt egress
 * to upstream AI models. Rehydrates model output in server memory before display and storage.
 * The mapping is NEVER persisted to any database and NEVER logged.
 */

export type PrivacyMode = 'off' | 'standard' | 'strict';

export interface MaskedSpan {
  start: number;
  end: number;
  category: string;
  placeholder: string;
  maskedPreview: string;
}

export interface RedactionResult {
  redactedText: string;
  redactionApplied: boolean;
  categoryCounts: Record<string, number>;
  maskedSpans: MaskedSpan[];
  /** Ephemeral replacement map: placeholder -> original value. Held in request memory ONLY. */
  ephemeralMap: Map<string, string>;
}

/**
 * Standard Luhn Checksum Algorithm for Credit Cards.
 */
function isValidLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.charAt(i), 10);
    if (isNaN(n)) return false;
    if (alternate) {
      n *= 2;
      if (n > 9) n = (n % 10) + 1;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Validates Indonesian NIK (Nomor Induk Kependudukan): 16 digits.
 */
function isValidIndonesianNIK(nik: string): boolean {
  if (!/^\d{16}$/.test(nik)) return false;
  const day = parseInt(nik.substring(6, 8), 10);
  // Indonesian NIK: women have birth day + 40
  const normalizedDay = day > 40 ? day - 40 : day;
  const month = parseInt(nik.substring(8, 10), 10);
  return normalizedDay >= 1 && normalizedDay <= 31 && month >= 1 && month <= 12;
}

/**
 * Validates Indonesian NPWP (Nomor Pokok Wajib Pajak): 15-16 digits.
 */
function isValidIndonesianNPWP(npwp: string): boolean {
  const digits = npwp.replace(/[\.\-]/g, '');
  return digits.length === 15 || digits.length === 16;
}

/**
 * Runs the Privacy Shield redaction pipeline on an input text.
 */
export function runPrivacyShield(
  input: string,
  mode: PrivacyMode = 'standard'
): RedactionResult {
  if (mode === 'off' || !input) {
    return {
      redactedText: input,
      redactionApplied: false,
      categoryCounts: {},
      maskedSpans: [],
      ephemeralMap: new Map(),
    };
  }

  const ephemeralMap = new Map<string, string>();
  const categoryCounts: Record<string, number> = {};
  const replacementCounters: Record<string, number> = {};

  function getNextPlaceholder(category: string, original: string): string {
    // Check if we already have a stable placeholder for this exact value
    for (const [ph, orig] of ephemeralMap.entries()) {
      if (orig === original) {
        return ph;
      }
    }
    const idx = (replacementCounters[category] || 0) + 1;
    replacementCounters[category] = idx;
    const ph = `[${category}_${idx}]`;
    ephemeralMap.set(ph, original);
    categoryCounts[category.toLowerCase()] = (categoryCounts[category.toLowerCase()] || 0) + 1;
    return ph;
  }

  let text = input;
  const detectedSpans: Array<{
    start: number;
    end: number;
    original: string;
    category: string;
  }> = [];

  // =========================================================================
  // STAGE 1: DETERMINISTIC DETECTORS
  // =========================================================================

  // 1. Credit Cards with Luhn Check
  const ccRegex = /\b(?:\d[ -]*?){13,19}\b/g;
  let match: RegExpExecArray | null;
  while ((match = ccRegex.exec(text)) !== null) {
    const raw = match[0];
    const digitsOnly = raw.replace(/\D/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && isValidLuhn(digitsOnly)) {
      detectedSpans.push({
        start: match.index,
        end: match.index + raw.length,
        original: raw,
        category: 'CREDIT_CARD',
      });
    }
  }

  // 2. Emails
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  while ((match = emailRegex.exec(text)) !== null) {
    detectedSpans.push({
      start: match.index,
      end: match.index + match[0].length,
      original: match[0],
      category: 'EMAIL',
    });
  }

  // 3. International & National Phone Numbers
  // Matches +1-555-555-5555, +62 812-3456-7890, (555) 123-4567, 555-123-4567, etc.
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g;
  while ((match = phoneRegex.exec(text)) !== null) {
    const raw = match[0].trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      // Avoid masking plain years or simple counts
      detectedSpans.push({
        start: match.index,
        end: match.index + match[0].length,
        original: raw,
        category: 'PHONE',
      });
    }
  }

  // 4. Indonesian NIK & NPWP
  const nikNpwpRegex = /\b\d{2}\.?\d{3}\.?\d{3}\.?\d{1}-?\d{3}\.?\d{3}\b|\b\d{16}\b/g;
  while ((match = nikNpwpRegex.exec(text)) !== null) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    if (isValidIndonesianNIK(digits)) {
      detectedSpans.push({
        start: match.index,
        end: match.index + raw.length,
        original: raw,
        category: 'INDONESIAN_NIK',
      });
    } else if (isValidIndonesianNPWP(raw)) {
      detectedSpans.push({
        start: match.index,
        end: match.index + raw.length,
        original: raw,
        category: 'INDONESIAN_NPWP',
      });
    }
  }

  // 5. IBAN (International Bank Account Number)
  const ibanRegex = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
  while ((match = ibanRegex.exec(text)) !== null) {
    detectedSpans.push({
      start: match.index,
      end: match.index + match[0].length,
      original: match[0],
      category: 'IBAN',
    });
  }

  // 6. URLs with Tokens, Secrets, or API Keys in Query String
  const urlTokenRegex = /https?:\/\/[^\s]+(?:\?|&)(?:token|access_token|key|api_key|secret|auth)=[^\s&]+/gi;
  while ((match = urlTokenRegex.exec(text)) !== null) {
    detectedSpans.push({
      start: match.index,
      end: match.index + match[0].length,
      original: match[0],
      category: 'URL_SECRET',
    });
  }

  // 7. Indonesian Street Addresses (Jl./Jalan/Gg./Komplek/Kav./Blok/RT/RW + kelurahan/kecamatan/kota)
  const indonesianAddressRegex =
    /\b(?:Jl\.?|Jalan|Gg\.?|Gang|Komplek|Kompleks|Kav\.?|Kavling|Blok)\s+[A-Za-z0-9\.\s\-]+?(?:\s+(?:No\.?|Nomor|Kav\.?|Kavling|Blok|RT|RW|Lt\.?|Lantai)\s*[A-Za-z0-9\-\/\.]+)*(?:,\s*(?:(?:RT|RW)\.?\s*\d{1,3}(?:\s*[\/\-]\s*(?:RT|RW)\.?\s*\d{1,3})?|Kel(?:urahan)?\.?\s+[A-Za-z0-9\s]+|Kec(?:amatan)?\.?\s+[A-Za-z0-9\s]+|Kota\s+[A-Za-z0-9\s]+|Kab(?:upaten)?\.?\s+[A-Za-z0-9\s]+|Jakarta(?:\s+(?:Selatan|Pusat|Barat|Timur|Utara))?|Bandung|Surabaya|Medan|Semarang|Yogyakarta|Jogja|Depok|Tangerang(?:\s+Selatan)?|Bekasi|Bogor|Denpasar|Makassar|Palembang|Batam|Pekanbaru|Malang|Bali)(?:\s+\d{5})?)+|\b(?:Jl\.?|Jalan|Gg\.?|Gang|Komplek|Kompleks|Kav\.?|Kavling|Blok)\s+[A-Za-z0-9\.\s\-]+?\s+(?:No\.?|Nomor|Kav\.?|Kavling|Blok|RT|RW)\s*[A-Za-z0-9\-\/\.]+(?:\s*,\s*[A-Za-z\s]+)?/gi;
  while ((match = indonesianAddressRegex.exec(text)) !== null) {
    detectedSpans.push({
      start: match.index,
      end: match.index + match[0].length,
      original: match[0],
      category: 'ADDRESS',
    });
  }

  // 8. International Street Addresses (e.g. 742 Evergreen Terrace, 10 Downing St, 1600 Amphitheatre Pkwy)
  const streetRegex = /\b\d{1,5}\s+[A-Za-z0-9\.\s]{2,25}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Way|Court|Ct|Plaza|Plz|Terrace|Ter)\b(?:\s+(?:Apt|Suite|Unit|Ste|Floor|Fl)\s+[A-Za-z0-9\-]+)?/gi;
  while ((match = streetRegex.exec(text)) !== null) {
    detectedSpans.push({
      start: match.index,
      end: match.index + match[0].length,
      original: match[0],
      category: 'ADDRESS',
    });
  }

  // =========================================================================
  // STAGE 2: STRICT ENTITY PASS (Person, Organization, Location names)
  // =========================================================================
  if (mode === 'strict') {
    // Strict pattern matching for explicit contextual names (e.g. "Dr. John Doe", "spoke with Alice Smith", "at Google")
    const namedEntityRegex = /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b|\b(?:with|to|from|by|at|call|meet)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+))\b/g;
    while ((match = namedEntityRegex.exec(text)) !== null) {
      const full = match[0];
      const name = match[1] || full;
      detectedSpans.push({
        start: match.index + (full.length - name.length),
        end: match.index + full.length,
        original: name,
        category: 'PERSON',
      });
    }
  }

  // =========================================================================
  // SORT & DEDUPLICATE OVERLAPPING DETECTIONS
  // =========================================================================
  detectedSpans.sort((a, b) => a.start - b.start || b.end - a.end);

  const nonOverlapping: typeof detectedSpans = [];
  let lastEnd = 0;
  for (const span of detectedSpans) {
    if (span.start >= lastEnd) {
      nonOverlapping.push(span);
      lastEnd = span.end;
    }
  }

  // =========================================================================
  // CONSTRUCT REDACTED TEXT & MASKED SPANS
  // =========================================================================
  let result = '';
  let cursor = 0;
  const maskedSpans: MaskedSpan[] = [];

  for (const span of nonOverlapping) {
    result += text.slice(cursor, span.start);
    const placeholder = getNextPlaceholder(span.category, span.original);
    const placeholderStart = result.length;
    result += placeholder;
    const placeholderEnd = result.length;

    maskedSpans.push({
      start: placeholderStart,
      end: placeholderEnd,
      category: span.category,
      placeholder,
      maskedPreview:
        span.original.length > 6
          ? `${span.original.slice(0, 2)}•••${span.original.slice(-2)}`
          : '••••••',
    });

    cursor = span.end;
  }
  result += text.slice(cursor);

  return {
    redactedText: result,
    redactionApplied: maskedSpans.length > 0,
    categoryCounts,
    maskedSpans,
    ephemeralMap,
  };
}

/**
 * Rehydrates an AI model response by reversing the ephemeral placeholder map.
 * Executed solely in server memory before streaming to user or persisting.
 */
export function rehydrateModelOutput(
  modelText: string,
  ephemeralMap: Map<string, string>
): string {
  if (!modelText || ephemeralMap.size === 0) {
    return modelText;
  }

  let rehydrated = modelText;
  for (const [placeholder, original] of ephemeralMap.entries()) {
    rehydrated = rehydrated.replaceAll(placeholder, original);
  }
  return rehydrated;
}
