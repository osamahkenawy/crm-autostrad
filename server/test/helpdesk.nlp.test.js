// Classification, extraction and priority checks on independently written emails (English and Arabic).
// Run: npm test --prefix server
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultKeywordRows } from '../src/helpdesk/dictionary.js';
import { buildDictionary, classify } from '../src/helpdesk/classify.js';
import { extractEntities } from '../src/helpdesk/extract.js';
import { scorePriority } from '../src/helpdesk/priority.js';
import { detectLanguage, normalize, redact, stripQuoted } from '../src/helpdesk/text.js';

const dict = buildDictionary(defaultKeywordRows());

// [expected sub_key, subject, body]
const SAMPLES = [
  // ---- unrecognized charge ----
  ['unrecognized_charge', 'Strange charge on my credit card', 'Hi team, I noticed AED 1,250 deducted from my card on 3 October and I do not recognise this transaction. My rental ended in September. Please explain the charge.'],
  ['unrecognized_charge', 'Charged twice for contract AST-100412', 'I have been double charged for the rental. Two payments of AED 890 appear on my bank statement. Please refund one of them.'],
  ['unrecognized_charge', 'Dispute charge', "I didn't authorise an extra amount of AED 300 on my card. What is this charge for?"],
  ['unrecognized_charge', 'خصم غير مبرر من بطاقتي', 'السلام عليكم، تم خصم مبلغ 600 درهم من بطاقتي بدون علمي ولا أعرف هذا الخصم. أرجو التوضيح. رقم العقد 100412'],
  ['unrecognized_charge', 'اعتراض على مبلغ', 'لاحظت عملية غير معروفة بقيمة ٣٢٠ درهم على بطاقتي بعد إرجاع السيارة، أرجو إفادتي بتفاصيلها.'],
  // ---- pre-authorization ----
  ['preauth_followup', 'Pre-auth not released', 'The pre-authorization of AED 2,000 is still on my card three weeks after I returned the car. When will you release the hold?'],
  ['preauth_followup', 'Hold on my card', 'Could you please release the hold on my card? My bank says the amount is still blocked by Autostrad. Contract number 558120.'],
  ['preauth_followup', 'Follow up on blocked amount', 'I returned the vehicle on 10/10/2026 and the blocked amount of AED 1500 has not been released yet.'],
  ['preauth_followup', 'المبلغ المحجوز على البطاقة', 'السلام عليكم، لا يزال مبلغ ١٥٠٠ درهم محجوزاً على بطاقتي منذ إرجاع السيارة. متى سيتم فك الحجز؟'],
  ['preauth_followup', 'تفويض مسبق', 'أرجو الإفراج عن المبلغ الخاص بالتفويض المسبق للعقد رقم 774201 فقد مضى أكثر من أسبوعين.'],
  // ---- invoice ----
  ['invoice_request', 'Invoice needed', 'Good morning, kindly send me the tax invoice for my rental contract AST-100777. We need it for our accounts department.'],
  ['invoice_request', 'Request for VAT invoice', 'Please issue a VAT invoice in the name of Gulf Trading LLC for the November rental. TRN 100234567800003.'],
  ['invoice_request', 'Copy of invoice', 'Can I get a copy of the invoice for last month?'],
  ['invoice_request', 'طلب فاتورة', 'مرحباً، أحتاج الفاتورة الضريبية للعقد رقم 667788 لتقديمها للمحاسبة في شركتنا. شكراً لكم'],
  ['invoice_request', 'فاتورة باسم الشركة', 'أرجو إرسال فاتورة باسم شركة الأفق للتجارة عن فترة الإيجار الأخيرة.'],
  // ---- deposit refund ----
  ['deposit_refund', 'Security deposit refund', 'I returned the car on 1 September and my security deposit of AED 1,000 has still not been refunded. Contract AST-100231.'],
  ['deposit_refund', 'Deposit not received', "When will I get my deposit back? It's been over a month."],
  ['deposit_refund', 'Refund of my deposit', 'Please refund the deposit for contract number 442210 to my card.'],
  ['deposit_refund', 'استرداد مبلغ التأمين', 'السلام عليكم، لم يتم استرداد مبلغ التأمين (١٠٠٠ درهم) رغم مرور شهر على إرجاع السيارة. رقم العقد 442210'],
  ['deposit_refund', 'استرجاع التأمين', 'أرجو إفادتي بموعد استرجاع التأمين الخاص بعقدي.'],
  // ---- vehicle collection ----
  ['vehicle_collection', 'Car collection request', 'Please arrange collection of the vehicle from my office in Business Bay tomorrow at 5pm. Contract AST-100889.'],
  ['vehicle_collection', 'Collect the car', 'I am leaving the country tonight. Can someone come and collect the car from Dubai Marina today?'],
  ['vehicle_collection', 'End rental and collect', 'We would like to end the rental early. Kindly send a driver to collect the vehicle from Al Quoz.'],
  ['vehicle_collection', 'استلام السيارة', 'السلام عليكم، أرغب في ترتيب استلام السيارة من موقعي في الشارقة غداً الساعة 4 عصراً. رقم العقد 889900'],
  ['vehicle_collection', 'ارسال مندوب لاستلام السيارة', 'أرجو إرسال مندوب لاستلام السيارة من أبوظبي اليوم لأنني مسافر.'],
  // ---- other categories ----
  ['fine_dispute', 'Traffic fine not mine', 'The traffic fine TF-1234567 with admin fee is not my fine, I was not driving on that day. I want to dispute it.'],
  ['fine_dispute', 'Salik charges', 'There are Salik charges that I do not think are correct for the dates of my rental.'],
  ['damage_dispute', 'Damage charge', 'You charged me AED 800 for a scratch on the bumper but the damage was already there when I picked up the car.'],
  ['contract_extension', 'Extend rental', 'I would like to extend my contract by 5 more days. Is the same car available?'],
  ['contract_extension', 'تمديد العقد', 'أرغب في تمديد العقد لمدة أسبوع إضافي.'],
  ['contract_copy', 'Statement of account', 'Please send me the statement of account and a copy of the contract for the period.'],
  ['vehicle_issue', 'Car broke down', 'My rental car broke down on Sheikh Zayed Road and I am stranded. Need a replacement vehicle urgently.'],
  ['vehicle_issue', 'السيارة متعطلة', 'السيارة لا تعمل وتعطلت في الطريق، أحتاج سيارة بديلة.'],
  ['service_complaint', 'Complaint about service', 'This is unacceptable. I have been waiting for hours at the airport branch and nobody replied to my calls. Very disappointed.'],
  ['service_complaint', 'شكوى', 'أود تقديم شكوى بخصوص سوء الخدمة وعدم الرد على اتصالاتي.'],
  ['staff_complaint', 'Rude employee', 'The staff member at the counter was very rude and unprofessional. I want to report this.'],
  ['vehicle_condition_complaint', 'Dirty car', 'The car was dirty and had a bad smell when I received it. This is not the car I booked.'],
  ['billing_complaint', 'Wrong invoice', 'The invoice is wrong. The price is higher than quoted and there are hidden fees I was never told about.'],
  ['general_inquiry', 'Monthly rental rates', 'Hello, what are the rates for a monthly rental of a small SUV? Also what documents do I need as a tourist?'],
  ['general_inquiry', 'استفسار', 'السلام عليكم، هل لديكم سيارات للإيجار الشهري وما هي المستندات المطلوبة؟'],
  ['spam_or_auto', 'Automatic reply: Out of office', 'I am out of office until Monday and will reply when I return.'],
  ['spam_or_auto', 'Boost your SEO ranking', 'We offer SEO services and guest post opportunities. Unsubscribe any time.'],
];

test('classification accuracy on the sample set is at least 90%', () => {
  let ok = 0;
  const wrong = [];
  for (const [expected, subject, body] of SAMPLES) {
    const r = classify({ subject, body }, dict);
    if (r.sub_key === expected) ok++; else wrong.push(`${subject} => ${r.sub_key} (expected ${expected}, ${r.confidence})`);
  }
  const accuracy = ok / SAMPLES.length;
  assert.ok(accuracy >= 0.9, `accuracy ${(accuracy * 100).toFixed(1)}%\n${wrong.join('\n')}`);
});

test('all five first-wave request types are classified correctly', () => {
  for (const key of ['unrecognized_charge', 'preauth_followup', 'invoice_request', 'deposit_refund', 'vehicle_collection']) {
    for (const [expected, subject, body] of SAMPLES.filter((s) => s[0] === key)) {
      assert.equal(classify({ subject, body }, dict).sub_key, expected, subject);
    }
  }
});

test('confidence is high for clear emails and low for vague ones', () => {
  assert.ok(classify({ subject: 'Unrecognized charge on my card', body: 'I do not recognize this charge.' }, dict).confidence >= 0.7);
  assert.ok(classify({ subject: 'Hello', body: 'Can you call me back please' }, dict).confidence < 0.4);
});

test('extraction: contract, amount, card digits, fine reference, location and name (English)', () => {
  const e = extractEntities({
    subject: 'Charge on contract AST 100123',
    body: 'Dear team,\nA charge of AED 1,250.50 appeared on my card ending 4242 on 12 October 2026. Fine TF-7654321. Please collect from Dubai Marina.\n\nKind regards,\nSara Ahmed',
    fromName: 'sara.ahmed@gmail.com', fromEmail: 'Sara.Ahmed@gmail.com',
  });
  assert.equal(e.contract_no, 'AST-100123');
  assert.equal(e.amount, 1250.5);
  assert.equal(e.card_last4, '4242');
  assert.equal(e.fine_ref, 'TF-7654321');
  assert.equal(e.location, 'Dubai Marina');
  assert.equal(e.customer_name, 'Sara Ahmed');
  assert.equal(e.customer_email, 'sara.ahmed@gmail.com');
  assert.equal(e.mentioned_date, '2026-10-12');
});

test('extraction handles Arabic digits and labels', () => {
  const e = extractEntities({ subject: 'خصم', body: 'رقم العقد ٥٥٨١٢٠ تم خصم مبلغ ٤٥٠ درهم من بطاقتي التي تنتهي بـ ٤٢٤٢\nمع الشكر\nمحمد علي', fromName: '', fromEmail: 'm@x.ae' });
  assert.equal(e.contract_no, '558120');
  assert.equal(e.amount, 450);
  assert.equal(e.card_last4, '4242');
  assert.equal(e.customer_name, 'محمد علي');
});

test('priority: urgent vehicle issue is critical, plain invoice request is low or average', () => {
  const crash = scorePriority({ subKey: 'vehicle_issue', subject: 'Car broke down', body: 'I am stranded on the highway, please send help immediately' });
  assert.equal(crash.priority, 'Critical');
  const inv = scorePriority({ subKey: 'invoice_request', subject: 'Invoice', body: 'Please send the invoice for last month' });
  assert.ok(['Low', 'Average'].includes(inv.priority), inv.priority);
  const legal = scorePriority({ subKey: 'unrecognized_charge', subject: 'Charge', body: 'If this is not fixed I will contact the police and my lawyer. This is the third time.', amount: 12000 });
  assert.equal(legal.priority, 'Critical');
  assert.ok(legal.reasons.length >= 4);
});

test('priority: Platinum customers and open related cases raise the score', () => {
  const base = scorePriority({ subKey: 'deposit_refund', subject: 'Deposit', body: 'When will I get my deposit' });
  const vip = scorePriority({ subKey: 'deposit_refund', subject: 'Deposit', body: 'When will I get my deposit', tier: 'Platinum', openRelated: 1 });
  assert.ok(vip.score > base.score);
});

test('text: language detection, normalisation, quoted-history removal and redaction', () => {
  assert.equal(detectLanguage('مرحبا أريد فاتورة'), 'ar');
  assert.equal(detectLanguage('Hello I need an invoice'), 'en');
  assert.equal(normalize('أريدُ فاتورةً'), 'اريد فاتوره');
  assert.equal(stripQuoted('Thanks!\n\nOn Mon, 12 Oct 2026 at 10:00, Helpdesk <helpdesk@autostrad.com> wrote:\n> older'), 'Thanks!');
  const r = redact('card 4242 4242 4242 4242 cvv 123');
  assert.ok(r.text.includes('**** **** **** 4242') && !r.text.includes('4242 4242') && /cvv \*\*\*/.test(r.text));
});
