// AI assistant for the portal ("Ask the assistant"): answers questions about the facility's compliance work in plain
// words and points to the next step. It reads the portal's own data through a few READ-ONLY tools (overview, register
// entries, policies, DoH circulars) - it never changes anything.
//
// The AI model is Claude (Anthropic API, official SDK). An administrator enters the API key in
// Administration -> Schedule & email -> AI assistant; it is kept in the portal's local secrets file, never sent to the
// browser. Without a key the assistant still works in a simple offline mode (fixed answers from the same data).
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, loadGlobalConfig, readSecrets, writeSecrets } from './config.js';
import { readMaster, registerHealth } from './master.js';
import { generatedFiles, listTemplates, readiness } from './policyprep.js';
import { hrGenerated } from './hrforms.js';
import { Store } from './store.js';

export const ASSISTANT_MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 6;

// ---------------------------------------------------------------------------------------------------
// API key (local secrets)
// ---------------------------------------------------------------------------------------------------
const apiKey = () => readSecrets(loadGlobalConfig()).anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
export const assistantConfigured = () => !!apiKey();
export function setAssistantKey(key) {
  const g = loadGlobalConfig();
  const secrets = readSecrets(g);
  const k = String(key || '').trim();
  if (k && !/^sk-ant-[\w-]{20,}$/.test(k)) throw new Error('That does not look like an Anthropic API key (it starts with sk-ant-)');
  if (k) secrets.anthropicApiKey = k; else delete secrets.anthropicApiKey;
  writeSecrets(g, secrets);
  return { configured: !!k };
}

// ---------------------------------------------------------------------------------------------------
// Portal data (read-only) - shared by the AI tools and the offline mode
// ---------------------------------------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const daysLeft = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? Math.round((Date.parse(iso) - Date.parse(today())) / 864e5) : null);

async function registerItems(cfg) {
  if (!cfg.register.path) return { items: [], error: 'No LEGAL REGISTER is linked to this facility yet' };
  try { return { items: (await readMaster(cfg)).filter(i => !i.fixed) }; }
  catch (e) { return { items: [], error: `The register could not be read (${e.message})` }; }
}

function policyState(cfg) {
  const files = generatedFiles(cfg);
  return {
    masterPolicies: listTemplates().length,
    wordFiles: files.word.length, pdfFiles: files.pdf.length,
    linkedToRegister: cfg._facility.policyPrep?.linkedAt || null,
    stillNeeded: readiness(cfg),
  };
}

function dohState(cfg) {
  const store = new Store(cfg);
  const last = store.data.runs[0] || null;
  const circ = store.circulars();
  return {
    lastSuccessfulCheck: store.meta.lastSuccess || null,
    lastCheck: last ? { at: last.finished || last.started || null, result: last.statusLabel || last.status, newCirculars: last.newCount ?? 0 } : null,
    circularsInRegister: circ.filter(c => c.excelRow).length,
    waitingForApproval: circ.filter(c => c.status === 'awaiting_approval' || c.status === 'pending_excel').length,
    schedule: cfg.schedule?.nightlyCron || null,
  };
}

/** The process step to do now (same order as the portal's Start -> 1 -> 2 -> 3 -> Finished guide). */
function nextStep(pol, health, doh, hr = null) {
  if (!pol.wordFiles) return { step: 1, page: 'Prepare policies', action: pol.stillNeeded.length ? `Fill in the policy details (still needed: ${pol.stillNeeded.join(', ')})` : 'Create the policies (Word + PDF)' };
  if (!hr?.count) return { step: 2, page: 'HR & checklist', action: 'Create the HR & onboarding documents ("Create all HR documents")' };
  if (!pol.linkedToRegister) return { step: 3, page: 'Prepare policies', action: 'Final step: link the policies to the LEGAL REGISTER (Step 4 of Prepare policies)' };
  if (health && (health.expired || health.expiring)) return { step: 3, page: 'LEGAL REGISTER', action: `Renew ${health.expired} expired and ${health.expiring} expiring item(s) - upload the new document or photo` };
  if (health && health.missing) return { step: 3, page: 'LEGAL REGISTER', action: `Add the missing dates for ${health.missing} item(s)` };
  if (!doh.lastSuccessfulCheck) return { step: 3, page: 'DoH updates', action: 'Run the first DoH check ("Check DoH now")' };
  return { step: 4, page: 'Dashboard', action: 'Nothing to do - everything is up to date' };
}

export async function overview(facilityId) {
  const cfg = loadConfig(facilityId);
  const { items, error } = await registerItems(cfg);
  const health = items.length ? registerHealth(items) : null;
  const pol = policyState(cfg), doh = dohState(cfg);
  return {
    today: today(),
    facility: { name: cfg._facility.name, code: cfg._facility.code },
    policies: pol,
    legalRegister: error ? { error } : { entries: health?.total || 0, valid: health?.valid || 0, expiringWithin30Days: health?.expiring || 0, expired: health?.expired || 0, withoutDates: (health?.missing || 0) + (health?.['no-expiry'] || 0) },
    dohUpdates: doh,
    hrDocuments: (h => (h ? { created: h.count, checkedCorrect: h.passed, at: h.at } : { created: 0 }))(hrGenerated(cfg._facility.id)),
    nextStep: nextStep(pol, health, doh, hrGenerated(cfg._facility.id)),
  };
}

export async function registerEntries(facilityId, status = 'all') {
  const cfg = loadConfig(facilityId);
  const { items, error } = await registerItems(cfg);
  if (error) return { error };
  const want = { expired: ['expired'], expiring: ['expiring'], missing: ['missing', 'no-expiry'], valid: ['valid', 'lifetime'] }[status];
  return {
    status, entries: items.filter(i => !want || want.includes(i.status)).map(i => ({
      name: i.name, status: i.status, issued: i.issued || null, expiry: i.expiry || null, due: i.due || null,
      daysLeft: daysLeft(i.expiry), responsible: i.responsible || null,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Claude (tool use, manual loop)
// ---------------------------------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'get_overview',
    description: 'Current state of the facility: policies (created, linked), LEGAL REGISTER counts (valid, expiring, expired, without dates), the last DoH check, and the next step to do. Call this first for any question about status or what to do.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_register_entries',
    description: 'Licences, certificates and contracts in the LEGAL REGISTER with their dates and days left. Filter by status.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['all', 'expired', 'expiring', 'missing', 'valid'], description: 'expiring = within 30 days; missing = no dates yet' } },
      required: ['status'], additionalProperties: false,
    },
  },
];

const SYSTEM = `You are the assistant inside a healthcare compliance portal used by clinics in Abu Dhabi.
The portal's work goes in this order: Start -> 1 Prepare policies (fill in details, add logo, signature and stamp, create the ADHICS policies as Word + PDF) -> 2 HR & onboarding documents (NDA, orientation, background verification, IT/EMR user form, disciplinary process, acceptable usage acknowledgement, IT quiz, awareness training, exit clearance - each with the facility logo, name and Ref. No. CODE/HR/FORM-NN; plus the ADHICS checklist) -> 3 LEGAL REGISTER, the final step (link the policies; licences, certificates and contracts with issue/expiry dates; renew expired or expiring ones by uploading the new document or a photo) -> Finished. DoH updates run all the time: new Department of Health circulars are checked every week and added to the LEGAL REGISTER.
Pages: Dashboard, Prepare policies, HR & checklist, LEGAL REGISTER, DoH updates, Downloads, Facility settings; administrators also have Administration (Policy templates, Facilities, Users & access, Schedule & email, Activity log).

How to answer:
- Use the tools to look up the facility's real data before answering questions about status, dates or what to do; never guess dates, counts or names.
- Answer in short, simple English (staff may not be native speakers): one or two short paragraphs or a short list. Name the page and the button to use.
- You can only read data. If asked to change something, say which page and button does it.
- Do not state that the facility is compliant or approved by DoH; report what the register shows.
- If a question is unrelated to this portal or its compliance work, say briefly that you help with the portal.`;

async function runTool(name, input, facilityId) {
  if (name === 'get_overview') return overview(facilityId);
  if (name === 'list_register_entries') return registerEntries(facilityId, input?.status || 'all');
  return { error: `Unknown tool ${name}` };
}

/**
 * Answer one question. history: earlier turns [{ role: 'user'|'assistant', text }] (text only, last few).
 * Returns { answer, mode: 'ai'|'offline', model? }.
 */
export async function ask(facilityId, question, history = []) {
  const q = String(question || '').trim().slice(0, 2000);
  if (!q) throw new Error('Type a question');
  if (!assistantConfigured()) return { answer: await offlineAnswer(facilityId, q), mode: 'offline' };

  const client = new Anthropic({ apiKey: apiKey() });
  const messages = [];
  for (const h of history.slice(-10)) {
    const text = String(h?.text || '').trim().slice(0, 4000);
    if (!text || !['user', 'assistant'].includes(h.role)) continue;
    if (!messages.length && h.role !== 'user') continue; // the conversation must start with the user
    messages.push({ role: h.role, content: text });
  }
  if (messages.at(-1)?.role === 'user') messages.pop(); // keep turns alternating
  messages.push({ role: 'user', content: q });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: ASSISTANT_MODEL,
        max_tokens: 16000,
        output_config: { effort: 'low' }, // chat: quick, short answers
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // if the model declines, another Claude model answers instead
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('The AI key was not accepted - an administrator can update it in Administration → Schedule & email');
      if (e instanceof Anthropic.RateLimitError) throw new Error('The AI service is busy - try again in a minute');
      if (e instanceof Anthropic.APIConnectionError) throw new Error('The AI service could not be reached (internet connection?)');
      if (e instanceof Anthropic.APIError) throw new Error(`The AI service returned an error (${e.status})`);
      throw e;
    }
    if (response.stop_reason === 'refusal') return { answer: 'I can’t help with that one. Ask me about your policies, the LEGAL REGISTER or DoH updates.', mode: 'ai', model: response.model };
    if (response.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: response.content }); continue; }
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) {
      const answer = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { answer: answer || 'Sorry, I could not find an answer.', mode: 'ai', model: response.model };
    }
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const t of toolUses) {
      try { results.push({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(await runTool(t.name, t.input, facilityId)) }); }
      catch (e) { results.push({ type: 'tool_result', tool_use_id: t.id, content: e.message, is_error: true }); }
    }
    messages.push({ role: 'user', content: results }); // all tool results in one message
  }
  return { answer: 'That took too many steps – please ask a shorter question.', mode: 'ai' };
}

// ---------------------------------------------------------------------------------------------------
// Offline mode (no API key): fixed answers built from the same data
// ---------------------------------------------------------------------------------------------------
async function offlineAnswer(facilityId, q) {
  const o = await overview(facilityId);
  const lr = o.legalRegister, p = o.policies;
  const s = q.toLowerCase();
  const list = async st => (await registerEntries(facilityId, st)).entries?.map(e => `• ${e.name}${e.expiry ? ` – expiry ${e.expiry}${e.daysLeft != null ? ` (${e.daysLeft < 0 ? `${-e.daysLeft} day${e.daysLeft === -1 ? "" : "s"} ago` : `${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"} left`})` : ''}` : ''}`).join('\n') || '';
  if (/expir|renew|due/.test(s)) {
    const ex = await list('expired'), soon = await list('expiring');
    if (!ex && !soon) return 'Nothing in the LEGAL REGISTER has expired or expires within 30 days.';
    return `${ex ? `Expired:\n${ex}\n` : ''}${soon ? `Expiring within 30 days:\n${soon}\n` : ''}\nTo renew: open LEGAL REGISTER and press "Upload documents" – the new dates are read for you.`;
  }
  if (/missing|no date|without/.test(s)) {
    const m = await list('missing');
    return m ? `These have no dates yet:\n${m}\n\nOpen LEGAL REGISTER → Edit, or upload the document.` : 'Every entry has its dates.';
  }
  if (/polic|word|pdf|sign|stamp|logo/.test(s)) {
    return p.wordFiles
      ? `${p.wordFiles} policies are created (Word) and ${p.pdfFiles} as PDF.${p.linkedToRegister ? ' They are linked to the LEGAL REGISTER.' : ' Next: link them to the LEGAL REGISTER (Prepare policies, step 4).'} Download them from the Downloads page.`
      : `The policies are not created yet.${p.stillNeeded.length ? ` Still needed: ${p.stillNeeded.join(', ')}.` : ''} Open Prepare policies and follow steps 1–4.`;
  }
  if (/doh|circular|check/.test(s)) {
    const d = o.dohUpdates;
    return d.lastSuccessfulCheck ? `The last DoH check was on ${d.lastSuccessfulCheck.slice(0, 10)}; ${d.circularsInRegister} circulars are in the register. It runs every week by itself – or press "Check DoH now" on DoH updates.` : 'DoH has not been checked yet. Open DoH updates and press "Check DoH now".';
  }
  return `Next step: ${o.nextStep.action} (page: ${o.nextStep.page}).\n\nLegal register: ${lr.error || `${lr.valid} valid, ${lr.expiringWithin30Days} expiring, ${lr.expired} expired, ${lr.withoutDates} without dates`}.\nPolicies: ${p.wordFiles ? `${p.wordFiles} created${p.linkedToRegister ? ', linked' : ', not linked yet'}` : 'not created yet'}.\n\n(Simple mode – an administrator can connect the AI model in Administration → Schedule & email.)`;
}
