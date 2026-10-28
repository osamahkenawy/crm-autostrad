// Realistic demo emails (English and Arabic) built from the CRM's own customers and contracts, so a
// demo mailbox behaves like the real one: contract numbers resolve, some senders use a different
// address, some emails carry no contract number at all. Used by the demo mailbox and the seed.
import { db } from '../db.js';

const T = {
  unrecognized_charge: {
    en: [
      ['Unrecognized charge on my card - contract {contract}', 'Hello,\n\nI noticed a charge of AED {amount} on my card ending {last4} on {date} and I do not recognise it. My rental contract number is {contract}. Please explain what this charge is for.\n\nRegards,\n{name}'],
      ['Charged twice?', 'Hi,\n\nI think I was double charged for my rental. There are two payments of AED {amount} on my statement.\nContract: {contract}\nPlease check and refund the extra one.\n\nThanks\n{name}'],
      ['Dispute a charge', 'Dear Autostrad,\n\nI did not authorise an additional amount of AED {amount} that was deducted from my card (last 4 digits {last4}) after I returned the car. Kindly provide a breakdown of this charge. If I do not get a response I will raise a chargeback with my bank.\n\n{name}'],
    ],
    ar: [
      ['استفسار عن خصم غير معروف - عقد {contract}', 'السلام عليكم،\n\nلاحظت خصم مبلغ {amount} درهم من بطاقتي (تنتهي بـ {last4}) بتاريخ {date} ولم أتعرف على هذه العملية. رقم العقد {contract}. أرجو توضيح سبب الخصم.\n\nمع الشكر،\n{name}'],
      ['خصم مرتين', 'مرحباً،\n\nتم خصم مبلغ {amount} درهم مرتين من بطاقتي عن الإيجار رقم {contract}. أرجو مراجعة الأمر وإعادة المبلغ الزائد.\n\n{name}'],
    ],
  },
  preauth_followup: {
    en: [
      ['Hold still on my card', 'Hello,\n\nI returned the car on {date} (contract {contract}) but the pre-authorization of AED {amount} is still on my card. Can you please release the hold?\n\nThanks,\n{name}'],
      ['Follow up: pre-auth not released', 'Hi team,\n\nThis is my second email about the blocked amount of AED {amount} on my card. It has been {days} days. Please release it urgently.\nContract: {contract}\n\n{name}'],
      ['Card hold', 'Dear team,\n\nMy bank says the amount of AED {amount} is still on hold by Autostrad for contract {contract}. When will it be released?\n\nBest regards\n{name}'],
    ],
    ar: [
      ['المبلغ المحجوز على بطاقتي', 'السلام عليكم،\n\nلا يزال مبلغ {amount} درهم محجوزاً على بطاقتي منذ إرجاع السيارة بتاريخ {date}. رقم العقد {contract}. متى سيتم فك الحجز؟\n\nشكراً،\n{name}'],
      ['متابعة التفويض المسبق', 'مرحباً،\n\nهذه المرة الثانية التي أتواصل فيها بخصوص الحجز على بطاقتي (التفويض المسبق) للعقد {contract}. مضى {days} يوماً ولم يتم الإفراج عن المبلغ. أرجو الاهتمام.\n\n{name}'],
    ],
  },
  invoice_request: {
    en: [
      ['Invoice request - {contract}', 'Good morning,\n\nCould you please send me the tax invoice for contract {contract}? I need it for my company accounts.\n\nThank you,\n{name}'],
      ['Need VAT invoice', 'Hello,\n\nPlease issue a VAT invoice in the name of Gulf Horizon Trading LLC (TRN 100{trn}) for my rental from {date}.\n\nRegards,\n{name}'],
      ['Copy of invoice', 'Hi,\n\nCan I get a copy of the invoice for my last rental? Contract {contract}.\n\nThanks\n{name}'],
    ],
    ar: [
      ['طلب فاتورة ضريبية', 'السلام عليكم،\n\nأرجو إرسال الفاتورة الضريبية للعقد رقم {contract} لتقديمها للمحاسبة. شكراً لكم\n\n{name}'],
      ['فاتورة باسم الشركة', 'مرحباً،\n\nأحتاج فاتورة باسم الشركة عن فترة الإيجار الأخيرة (العقد {contract}). الرقم الضريبي 100{trn}.\n\n{name}'],
    ],
  },
  deposit_refund: {
    en: [
      ['Security deposit not refunded', 'Hello,\n\nI returned the vehicle on {date} (contract {contract}) and my security deposit of AED {amount} has still not been refunded. It has been {days} days. When will I receive it?\n\n{name}'],
      ['Deposit refund', 'Dear team,\n\nPlease refund my deposit for contract {contract} to my card. I returned the car {days} days ago.\n\nThanks,\n{name}'],
      ['Still waiting for my deposit', 'Hi,\n\nThis is my third email. I am still waiting for my deposit (AED {amount}). This is unacceptable, please escalate this to your manager.\nContract: {contract}\n\n{name}'],
    ],
    ar: [
      ['استرداد مبلغ التأمين', 'السلام عليكم،\n\nأرجو إفادتي بموعد استرداد مبلغ التأمين ({amount} درهم) للعقد رقم {contract}، فقد مضى {days} يوماً على إرجاع السيارة.\n\nمع الشكر،\n{name}'],
      ['لم يتم استرجاع التأمين', 'مرحباً،\n\nلم يتم استرجاع مبلغ التأمين حتى الآن رغم أنني أرجعت السيارة بتاريخ {date}. رقم العقد {contract}.\n\n{name}'],
    ],
  },
  vehicle_collection: {
    en: [
      ['Please collect the car', 'Hello,\n\nI need to end my rental early. Could you arrange collection of the vehicle from {location} tomorrow afternoon? Contract {contract}.\n\nThanks,\n{name}'],
      ['Car collection request - urgent', 'Hi,\n\nI am leaving the country tonight. Please send someone to collect the car from {location} today. It is urgent.\nContract: {contract}\n\n{name}'],
    ],
    ar: [
      ['طلب استلام السيارة', 'السلام عليكم،\n\nأرغب في ترتيب استلام السيارة من موقعي في {location} غداً. رقم العقد {contract}.\n\nمع الشكر،\n{name}'],
      ['استلام السيارة اليوم', 'مرحباً،\n\nأحتاج إرسال مندوب لاستلام السيارة من {location} اليوم لأنني مسافر. عاجل. العقد {contract}.\n\n{name}'],
    ],
  },
  fine_dispute: {
    en: [['Traffic fine not mine', 'Hello,\n\nThe traffic fine {fine} that was added to my invoice is not mine. I was not driving on that date. I want to dispute it. Contract {contract}.\n\n{name}']],
    ar: [['اعتراض على مخالفة', 'السلام عليكم،\n\nأعترض على المخالفة المرورية رقم {fine} المضافة على فاتورتي، فلم أكن أقود السيارة في ذلك اليوم. العقد {contract}.\n\n{name}']],
  },
  damage_dispute: {
    en: [['Damage charge', 'Hi,\n\nYou charged me AED {amount} for a scratch on the bumper but the damage was already there when I picked up the car. Contract {contract}. Please review.\n\n{name}']],
    ar: [['رسوم الضرر', 'مرحباً،\n\nتم تحميلي {amount} درهم رسوم ضرر وخدش في المصد لكن الضرر كان موجود قبل استلامي للسيارة. العقد {contract}.\n\n{name}']],
  },
  refund_request: {
    en: [['Overcharged on my rental', 'Hello,\n\nI was overcharged by AED {amount} on contract {contract} compared with my booking confirmation. Please refund the difference.\n\n{name}']],
    ar: [['استرداد مبلغ زائد', 'السلام عليكم،\n\nتم تحصيل مبلغ زائد {amount} درهم على العقد {contract} مقارنة بتأكيد الحجز. أرجو استرداد الفرق.\n\n{name}']],
  },
  contract_extension: {
    en: [['Extend rental', 'Hello,\n\nI would like to extend my contract {contract} by 5 more days. Is the same car available?\n\n{name}']],
    ar: [['تمديد العقد', 'السلام عليكم،\n\nأرغب في تمديد العقد رقم {contract} لمدة أسبوع إضافي.\n\n{name}']],
  },
  contract_copy: {
    en: [['Statement of account', 'Hi,\n\nPlease send me the statement of account and a copy of the contract {contract}.\n\n{name}']],
    ar: [['كشف حساب', 'السلام عليكم،\n\nأرجو إرسال كشف حساب ونسخة من العقد رقم {contract}.\n\n{name}']],
  },
  vehicle_issue: {
    en: [['Car broke down', 'Hello,\n\nMy rental car (contract {contract}) broke down near {location} and I am stranded. I need a replacement vehicle urgently.\n\n{name}']],
    ar: [['السيارة متعطلة', 'السلام عليكم،\n\nالسيارة متعطلة في الطريق قرب {location} وأحتاج سيارة بديلة عاجلاً. رقم العقد {contract}.\n\n{name}']],
  },
  service_complaint: {
    en: [['Complaint about service', 'This is unacceptable. I waited for hours at the {location} branch and nobody replied to my calls. Very disappointed with the service on contract {contract}.\n\n{name}']],
    ar: [['شكوى', 'أود تقديم شكوى بخصوص سوء الخدمة في فرع {location} وعدم الرد على اتصالاتي. العقد {contract}.\n\n{name}']],
  },
  staff_complaint: {
    en: [['Rude employee', 'The staff member at the counter in {location} was very rude and unprofessional. I want to report this. Contract {contract}.\n\n{name}']],
    ar: [['موظف غير محترم', 'تعامل موظف الاستقبال في {location} كان سيء ويفتقر للاحترام. أرغب في الإبلاغ عن ذلك. العقد {contract}.\n\n{name}']],
  },
  vehicle_condition_complaint: {
    en: [['Dirty car', 'The car was dirty and had a bad smell when I received it (contract {contract}). This is not the car I booked.\n\n{name}']],
    ar: [['سيارة غير نظيفة', 'استلمت السيارة وهي غير نظيفة وبها رائحة سيئة (العقد {contract}). وهي ليست السيارة التي حجزتها.\n\n{name}']],
  },
  billing_complaint: {
    en: [['Wrong invoice', 'The invoice for contract {contract} is wrong. The price is higher than quoted and there are hidden fees I was never told about.\n\n{name}']],
    ar: [['خطأ في الفاتورة', 'الفاتورة الخاصة بالعقد {contract} خاطئة والسعر أعلى من المتفق عليه وبها رسوم مخفية لم يتم إبلاغي بها.\n\n{name}']],
  },
  general_inquiry: {
    en: [['Monthly rental rates', 'Hello,\n\nWhat are the rates for a monthly rental of a small SUV? Also what documents do I need as a tourist?\n\nThanks,\n{name}']],
    ar: [['استفسار', 'السلام عليكم،\n\nهل لديكم سيارات للإيجار الشهري وما هي المستندات المطلوبة؟\n\n{name}']],
  },
  spam_or_auto: {
    en: [['Boost your SEO ranking', 'We offer SEO services and guest post opportunities for your website. Unsubscribe any time.']],
    ar: [['رد تلقائي: خارج المكتب', 'أنا خارج المكتب حتى يوم الاثنين وسأرد عند عودتي. (رد تلقائي)']],
  },
};

// share of all cases per request type (the five first-wave types are 62.3% of the 2026 workload)
export const MIX = [
  ['unrecognized_charge', 20.5], ['preauth_followup', 18.1], ['invoice_request', 10.6], ['deposit_refund', 9.8], ['vehicle_collection', 3.2],
  ['fine_dispute', 4.5], ['damage_dispute', 3], ['refund_request', 3], ['contract_extension', 4.5], ['contract_copy', 2.5], ['vehicle_issue', 3.5],
  ['service_complaint', 5.5], ['staff_complaint', 1], ['vehicle_condition_complaint', 1.5], ['billing_complaint', 2], ['general_inquiry', 5.5], ['spam_or_auto', 1.3],
];

const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_m, k) => (v[k] !== undefined ? v[k] : `{${k}}`));

export function pickSubKey(rnd) {
  let r = rnd() * MIX.reduce((a, m) => a + m[1], 0);
  for (const [key, w] of MIX) { r -= w; if (r <= 0) return key; }
  return MIX[0][0];
}

const SENDERS = ['maria.santos@mail.com', 'ahmed.k@outlook.com', 'omar.f@gmail.com', 'leena.q@hotmail.com', 'tariq.m@gmail.com', 'priya.n@yahoo.com'];

/**
 * One email. `opts`: subKey, lang ('en'|'ar'), rnd (0..1 function), bookingId, noContract, otherSender, daysAgo.
 * -> { subKey, lang, fromName, fromEmail, subject, body, contract, bookingId }
 */
export function generateEmail({ subKey, lang = 'en', rnd = Math.random, bookingId = null, noContract = false, otherSender = false } = {}) {
  const booking = bookingId
    ? db.prepare('SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?').get(bookingId)
    : db.prepare(`SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id
                   WHERE b.status IN ('completed', 'active') AND c.segment = 'Individual' ORDER BY ABS(RANDOM() % 997) LIMIT 1`).get();
  const variants = (T[subKey] && (T[subKey][lang] || T[subKey].en)) || T.general_inquiry.en;
  const [subject, body] = variants[Math.floor(rnd() * variants.length)];
  const cities = ['Dubai Marina', 'Business Bay', 'Al Quoz', 'Sharjah', 'Abu Dhabi', 'Deira', 'JLT'];
  const amountFor = { deposit_refund: [500, 1000, 1500, 2000], preauth_followup: [1000, 1500, 2000, 3000] }[subKey];
  // customers quote what is really on their contract (most of the time), so the CRM facts in the case line up with the email
  const fin = booking ? db.prepare('SELECT * FROM hd_contract_financials WHERE contract_no = ?').get(booking.ref) : null;
  const real = booking ? [
    ...db.prepare('SELECT amount, admin_fee FROM fines WHERE booking_id = ?').all(booking.id).map((f) => Number(f.amount) + Number(f.admin_fee || 0)),
    ...db.prepare("SELECT total FROM invoices WHERE booking_id = ? AND status <> 'draft'").all(booking.id).map((i) => Number(i.total)),
  ] : [];
  let amount;
  if (subKey === 'deposit_refund' && fin && rnd() < 0.85) amount = fin.deposit_amount;
  else if (subKey === 'preauth_followup' && fin && rnd() < 0.85) amount = fin.preauth_amount;
  else if (subKey === 'unrecognized_charge' && real.length && rnd() < 0.6) amount = real[Math.floor(rnd() * real.length)];
  else amount = amountFor ? amountFor[Math.floor(rnd() * amountFor.length)] : Math.round(120 + rnd() * 2400);
  const vars = {
    contract: noContract ? '' : (booking ? booking.ref : 'AST-100000'),
    amount,
    last4: fin && fin.card_last4 && rnd() < 0.9 ? fin.card_last4 : String(1000 + Math.floor(rnd() * 8999)),
    date: new Date(Date.now() - (5 + Math.floor(rnd() * 25)) * 86400000).toISOString().slice(0, 10),
    days: 7 + Math.floor(rnd() * 28),
    location: cities[Math.floor(rnd() * cities.length)],
    trn: String(Math.floor(100000000000 + rnd() * 899999999999)).slice(0, 12),
    fine: `TF-${Math.floor(1000000 + rnd() * 8999999)}`,
    name: booking ? booking.name : 'Customer',
  };
  let text = fill(body, vars);
  if (noContract) text = text.replace(/\s*(?:Contract|رقم العقد|العقد)[: ]*\s*\.?/g, ' ').replace(/ \./g, '.');
  const subj = fill(subject, vars).replace(/\s*-\s*(?:contract|عقد)\s*$/i, '');
  const fromEmail = otherSender || !booking || !booking.email ? SENDERS[Math.floor(rnd() * SENDERS.length)] : booking.email;
  return { subKey, lang, fromName: booking ? booking.name : 'Customer', fromEmail, subject: subj, body: text, contract: vars.contract, bookingId: booking ? booking.id : null };
}
