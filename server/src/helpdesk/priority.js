// Priority detection: Critical / High / Average / Low from urgency, request type and customer impact.
// Every decision comes with the reasons, so staff can see (and challenge) why a case is rated as it is.
import { normalize } from './text.js';

const BASE = {
  unrecognized_charge: 3, preauth_followup: 3, invoice_request: 1, deposit_refund: 3, vehicle_collection: 3, fine_dispute: 2, damage_dispute: 2,
  refund_request: 2, contract_extension: 2, contract_copy: 1, vehicle_issue: 6, service_complaint: 3, staff_complaint: 3,
  vehicle_condition_complaint: 3, billing_complaint: 3, general_inquiry: 1, spam_or_auto: 0,
};

const has = (norm, list) => list.find((w) => new RegExp(/[؀-ۿ]/.test(w) ? w : `(?<![a-z])${w}(?![a-z])`).test(norm));
const list = (s) => s.split('|').map((w) => normalize(w));

const URGENT_STRONG = list("urgent|urgently|asap|immediately|emergency|stranded|right now|as soon as possible|عاجل|عاجلا|فورا|طارئ|حالا|في اسرع وقت");
const URGENT_SOFT = list('today|tonight|this evening|tomorrow morning|this morning|اليوم|الليله|غدا صباحا');
const LEGAL = list('police|lawyer|legal action|legal|court|consumer protection|ministry|central bank|report you|social media|media|trading standards|شرطه|محامي|قانوني|قانونيه|محكمه|حمايه المستهلك|الجهات المختصه|وزاره|المصرف المركزي|تصعيد');
const REPEAT = list("second time|third time|again|still waiting|still no|still not|no response|no reply|not replied|following up|follow up|follow-up|reminder|chasing|weeks ago|many times|several times|للمره الثانيه|مره اخرى|ما زلت انتظر|لا زلت انتظر|لم يتم الرد|متابعه|تذكير|اكثر من مره");
const EMOTION = list('unacceptable|furious|outraged|disgusted|terrible|worst|ridiculous|fed up|disgraceful|غير مقبول|سيء جدا|اسوأ|مستفز');

const SCORE_TO_PRIORITY = (n) => (n >= 8 ? 'Critical' : n >= 5 ? 'High' : n >= 3 ? 'Average' : 'Low');

/**
 * ctx: { subKey, subject, body, amount, tier, segment, openRelated (number of other open cases for the
 *        same contract or sender) }
 * -> { priority, score, reasons[], urgent }
 */
export function scorePriority({ subKey, subject = '', body = '', amount = null, tier = null, segment = null, openRelated = 0 } = {}) {
  const norm = normalize(`${subject}\n${body}`);
  const reasons = [];
  let score = BASE[subKey] ?? 1;
  reasons.push(`Request type (${score})`);
  let urgent = false;

  const strong = has(norm, URGENT_STRONG);
  const onTheRoad = subKey === 'vehicle_issue' || subKey === 'vehicle_collection';
  if (strong) { const pts = onTheRoad ? 2 : 1; score += pts; urgent = true; reasons.push(`Urgent wording "${strong}" (+${pts})`); }
  else if (has(norm, URGENT_SOFT)) { score += 1; reasons.push('Needed today (+1)'); }

  const legal = has(norm, LEGAL);
  if (legal) { score += 2; reasons.push(`Legal or escalation wording "${legal}" (+2)`); }
  const repeat = has(norm, REPEAT);
  if (repeat) { score += 1; reasons.push(`Customer is chasing "${repeat}" (+1)`); }
  if (has(norm, EMOTION)) { score += 1; reasons.push('Strong dissatisfaction (+1)'); }

  const a = Number(amount) || 0;
  if (a >= 10000) { score += 2; reasons.push('Amount of AED 10,000 or more (+2)'); }
  else if (a >= 2000) { score += 1; reasons.push('Amount of AED 2,000 or more (+1)'); }

  if (tier === 'Platinum' || tier === 'Gold' || segment === 'Corporate') { score += 1; reasons.push(`${segment === 'Corporate' ? 'Corporate account' : `${tier} customer`} (+1)`); }
  if (openRelated > 0) { score += 1; reasons.push('Another open case for the same contract or sender (+1)'); }

  let priority = SCORE_TO_PRIORITY(score);
  // an on-the-road emergency or a same-day collection is never rated below High
  if (urgent && (subKey === 'vehicle_issue' || subKey === 'vehicle_collection') && (priority === 'Average' || priority === 'Low')) {
    priority = 'High';
    reasons.push('Vehicle on the road and urgent (minimum High)');
  }
  if (subKey === 'spam_or_auto') priority = 'Low';
  return { priority, score, reasons, urgent };
}

export const priorityRank = (p) => ({ Critical: 0, High: 1, Average: 2, Low: 3 }[p] ?? 2);
export const raisePriority = (p, steps = 1) => ['Low', 'Average', 'High', 'Critical'][Math.min(3, ['Low', 'Average', 'High', 'Critical'].indexOf(p) + steps)] || p;
