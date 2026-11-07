// DoH compliance metadata for the register columns F-J, plus IT / ADHICS screening.
//
// Rules were derived from how the existing 1,366 register rows were filled
// (F: "Fully Complaince" 1,161 / "Not Applicable" 205; G: always the facility's
// responsible person; J: always "DOH"; H/I: "Immediate" for recalls historically,
// "_" when no target date / reporting frequency applies) and adapted to the
// facility profile (medical centre with pharmacy) and to the IT-provider role:
//
//  1. Not applicable  - the circular addresses a service the facility does not provide
//                       (home care, ambulance, hospitals/surgery, IVF, insurers only, ...).
//  2. IT-related      - the circular imposes IT / information-security / health-information-system
//                       work (ADHICS, Malaffi, cloud, backup, data submission ...). These are
//                       implemented by the 3rd-party IT service provider, so G = the fixed
//                       IT Department entry; F uses one of the two allowed statuses.
// Only two compliance statuses exist: "Fully Compliant" (register spelling) and "Not Applicable".
//  3. Recall / alert  - pharmacy-relevant product alert: compliant, target "Immediate".
//  4. Everything else - compliant (the facility's established practice); H/I filled from the
//                       circular text when it states a deadline or a reporting frequency.
// Every automatic decision is recorded with its reason and can be overridden in the portal.
import { cleanText } from './normalize.js';
import { IT_DEPARTMENT } from './config.js';

/** The only two compliance statuses (DoH, medical centre & pharmacy). */
export const complianceOptions = cfg => [cfg.compliance.labels.compliant, cfg.compliance.labels.notApplicable];

/** Map a user/legacy value to one of the two allowed statuses (null if unknown). */
export function normalizeCompliance(value, cfg) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/^not\s*applicable|^n\/?a$/.test(v)) return cfg.compliance.labels.notApplicable;
  if (/^fully\s*compl/.test(v) || v === 'compliant') return cfg.compliance.labels.compliant;
  return null;
}

const IT_STRONG = [
  'adhics', 'cyber', 'cybersecurity', 'information security', 'data protection', 'personal data', 'patient data', 'health data',
  'privacy', 'malaffi', 'health information exchange', 'electronic medical record', 'emr', 'ehr', 'electronic health record',
  'e-prescription', 'eprescription', 'electronic prescription', 'e-claim', 'eclaim', 'shafafiya', 'riayati', 'sahana', 'hl7', 'fhir',
  'interoperability', 'information system', 'digital platform', 'platform', 'portal', 'cloud', 'multi-cloud', 'backup', 'back-up',
  'disaster recovery', 'business continuity', 'access control', 'multi-factor', 'authentication', 'user account', 'uae pass',
  'encryption', 'firewall', 'network security', 'vulnerability', 'malware', 'ransomware', 'phishing', 'data submission',
  'submission of data', 'data standardization', 'data standardisation', 'minimum data set', 'integration', 'connectivity',
  'api', 'software', 'electronic system', 'automation system', 'third party', 'outsourc', 'hosting', 'data sharing',
];

const word = kw => new RegExp(`(?<![a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()}${kw.trim().length <= 5 || !/[a-z]$/.test(kw) ? '(?![a-z0-9])' : ''}`, 'i');
const hits = (list, text) => list.filter(k => k.trim() && word(k).test(text));

/** Extract plain text from a downloaded document (PDF or HTML). */
export async function documentText(buffer, kind, maxPages = 20) {
  if (!buffer) return { text: '', status: 'No document' };
  try {
    if (kind === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 }); // silence font warnings
      const { text } = await extractText(pdf, { mergePages: true });
      const body = (Array.isArray(text) ? text.join('\n') : text).slice(0, 200000);
      if (body.trim().length < 40) return { text: body, status: 'Scanned PDF (no text) - read manually' };
      return { text: body, status: `PDF text extracted (${Math.min(pdf.numPages, maxPages)} page(s))` };
    }
    if (kind === 'html') return { text: cleanText(buffer.toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')), status: 'HTML text extracted' };
  } catch (e) {
    return { text: '', status: `Text extraction failed: ${e.message}` };
  }
  return { text: '', status: `Unsupported document (${kind})` };
}

const FREQ = [
  [/\b(daily|every day|each day)\b/i, 'Daily'],
  [/\b(weekly|every week|each week)\b/i, 'Weekly'],
  [/\b(monthly|every month|each month)\b/i, 'Monthly'],
  [/\b(quarterly|every (three|3) months)\b/i, '3 Months'],
  [/\b(semi-?annual(ly)?|bi-?annual(ly)?|every (six|6) months)\b/i, '6 Months'],
  [/\b(annually|yearly|every year|each year)\b/i, 'Annually'],
];

/** Reporting frequency stated in the circular (only in sentences about reporting/submitting). */
export function reportingFrequency(text) {
  for (const sentence of (text || '').split(/(?<=[.;:])\s+|\n+/)) {
    if (!/\b(report|reporting|submit|submission|submitted|upload|notify|send)\b/i.test(sentence)) continue;
    for (const [re, label] of FREQ) if (re.test(sentence)) return label;
  }
  return null;
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const MONTH_INDEX = m => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.slice(0, 3).toLowerCase());

/** Compliance deadline stated in the circular ("no later than 31 December 2026" ...). */
export function targetDate(text, issued) {
  const t = (text || '').replace(/\s+/g, ' ');
  const lead = '(?:no later than|not later than|on or before|before|by|deadline(?: is| of)?|until|effective(?: from| as of| date)?|starting from|from|with effect from)';
  const patterns = [
    new RegExp(`${lead}\\s*:?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})[a-z]*,?\\s+(20\\d{2})`, 'gi'),
    new RegExp(`${lead}\\s*:?\\s*(${MONTHS})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, 'gi'),
    new RegExp(`${lead}\\s*:?\\s*(\\d{1,2})[/.-](\\d{1,2})[/.-](20\\d{2})`, 'gi'),
  ];
  const found = [];
  patterns.forEach((re, i) => {
    for (const m of t.matchAll(re)) {
      let y, mo, d;
      if (i === 0) [d, mo, y] = [+m[1], MONTH_INDEX(m[2]), +m[3]];
      else if (i === 1) [mo, d, y] = [MONTH_INDEX(m[1]), +m[2], +m[3]];
      else [d, mo, y] = [+m[1], +m[2] - 1, +m[3]];
      const dt = new Date(Date.UTC(y, mo, d));
      if (!isNaN(dt) && dt.getUTCDate() === d) found.push(dt.toISOString().slice(0, 10));
    }
  });
  const future = found.filter(d => !issued || d >= issued).sort();
  return future[0] || null;
}

/**
 * Decide F-J for a circular. Returns { values: {compliance, responsible, targetDate, frequency, authority},
 * decision, itRelated, itMatches, reason }.
 */
export function complianceMetadata(c, text, cfg) {
  const rules = cfg.compliance;
  const L = rules.labels;
  const title = c.name || '';
  const body = text || '';
  const cats = c.categories?.length ? c.categories : (c.category || '').split(/;\s*/).filter(Boolean);
  const naCats = new Set(rules.notApplicableCategories.map(s => s.toLowerCase()));
  const allNaCats = cats.length > 0 && cats.every(x => naCats.has(x.toLowerCase()));
  const naKw = hits(rules.notApplicableKeywords, title);
  const itTitle = hits(IT_STRONG, title);
  const itBody = [...new Set(hits(IT_STRONG, body.slice(0, 30000)))];
  const itRelated = itTitle.length > 0 || itBody.includes('adhics') || itBody.length >= 4;
  const recall = hits(rules.recallKeywords, title).length > 0 || /\bsafety alert\b|\bfield safety\b/i.test(title);
  const freq = reportingFrequency(body);
  const deadline = targetDate(body, c.date);
  const base = { responsible: cfg.branch?.responsible ?? rules.responsible, authority: rules.authority };
  const v = x => x ?? rules.noValue;

  if (allNaCats || naKw.length) {
    return {
      decision: 'not_applicable', itRelated, itMatches: [...itTitle, ...itBody],
      reason: allNaCats ? `Addressed only to: ${cats.join(', ')} (not this facility's service type)`
        : `Concerns a service not provided by a ${cfg.facility.profile}: ${naKw.join(', ')}`,
      values: { ...base, compliance: L.notApplicable, targetDate: rules.noValue, frequency: rules.noValue },
    };
  }
  if (itRelated && cfg.facility.itProviderRole) {
    return {
      decision: 'it_related', itRelated, itMatches: [...new Set([...itTitle, ...itBody])],
      reason: `IT / information-system obligation (${[...new Set([...itTitle, ...itBody])].slice(0, 5).join(', ')}): ` +
        'assigned to the IT Department (3rd-party IT service provider)' + (deadline ? `; deadline ${deadline}` : ''),
      values: { ...base, compliance: L.compliant, responsible: IT_DEPARTMENT,
        targetDate: deadline ? { date: deadline } : rules.noValue, frequency: v(freq) },
    };
  }
  if (recall) {
    return {
      decision: 'recall', itRelated, itMatches: itBody,
      reason: 'Product recall / safety alert relevant to pharmacy stock: act immediately',
      values: { ...base, compliance: L.compliant, targetDate: deadline ? { date: deadline } : rules.recallTargetDate, frequency: freq || rules.recallFrequency },
    };
  }
  return {
    decision: 'compliant', itRelated, itMatches: itBody,
    reason: 'Applicable to the facility; recorded per the register\'s established practice' +
      (deadline ? `; deadline ${deadline} found in circular` : '') + (freq ? `; reporting ${freq.toLowerCase()}` : ''),
    values: { ...base, compliance: L.compliant, targetDate: deadline ? { date: deadline } : rules.noValue, frequency: v(freq) },
  };
}

/** Map metadata values onto register column letters. */
export function toColumns(values, reg, dateStyleH) {
  const col = reg.columns;
  const out = {};
  for (const [k, val] of Object.entries(values)) {
    if (!col[k]) continue;
    out[col[k]] = val && typeof val === 'object' && val.date ? { date: val.date, style: dateStyleH } : val;
  }
  return out;
}
