// Starter keyword dictionary (English and Arabic). Loaded into hd_keywords on first run and then
// edited in the app (Helpdesk setup > Keywords). Weight 1-5: how strongly a phrase points at the type.
// Arabic is written naturally here; both sides are normalised the same way when matching.

export const DEFAULT_KEYWORDS = {
  unrecognized_charge: {
    en: [
      ['unrecognized charge', 5], ['unrecognised charge', 5], ['unrecognized transaction', 5], ['unrecognised transaction', 5], ['unknown charge', 5],
      ['unknown transaction', 4], ['unauthorized charge', 5], ['unauthorised charge', 5], ['unauthorized transaction', 5], ['unauthorised transaction', 5],
      ['did not authorize', 4], ["didn't authorize", 4], ['did not authorise', 4], ["didn't authorise", 4], ['not authorized', 3],
      ['i do not recognize', 4], ["i don't recognize", 4], ['i do not recognise', 4], ["i don't recognise", 4], ['not familiar with this charge', 4],
      ['suspicious charge', 4], ['suspicious transaction', 4], ['charged twice', 4], ['double charged', 4], ['double charge', 4], ['charged me twice', 4],
      ['wrongly charged', 4], ['wrong charge', 4], ['incorrect charge', 4], ['unexpected charge', 4], ['unexpected deduction', 4],
      ['deducted from my card', 3], ['charge on my card', 3], ['charged to my card', 3], ['amount deducted', 2],
      ['dispute the charge', 4], ['dispute this charge', 4], ['explain the charge', 4], ['what is this charge', 4], ['why was i charged', 4],
      ['why was my card charged', 4], ['chargeback', 3], ['charge back', 2],
    ],
    ar: [
      ['خصم غير معروف', 5], ['خصم غير مبرر', 5], ['مبلغ غير معروف', 5], ['عملية غير معروفة', 5], ['معاملة غير معروفة', 5], ['لم أقم بهذه العملية', 5],
      ['لا أعرف هذا المبلغ', 5], ['لا اعرف هذا الخصم', 5], ['رسوم غير مبررة', 5], ['رسوم غير معروفة', 5], ['تم خصم مبلغ', 3], ['خصم من بطاقتي', 3],
      ['خصم من البطاقة', 3], ['تم خصم', 2], ['خصم مرتين', 4], ['خصم مزدوج', 4], ['سحب من بطاقتي', 3], ['مبلغ خاطئ', 3], ['اعتراض على الخصم', 5],
      ['اعتراض على المبلغ', 4], ['توضيح الخصم', 4], ['سبب الخصم', 4], ['لم أوافق على', 3],
    ],
  },
  preauth_followup: {
    en: [
      ['pre-authorization', 5], ['pre authorization', 5], ['preauthorization', 5], ['pre-authorisation', 5], ['pre authorisation', 5], ['preauth', 5], ['pre-auth', 5],
      ['authorization hold', 5], ['authorisation hold', 5], ['hold on my card', 5], ['card hold', 5], ['hold on the card', 5], ['hold released', 4],
      ['release the hold', 5], ['release my hold', 5], ['release of the hold', 5], ['amount on hold', 4], ['amount held', 4], ['amount blocked', 4],
      ['blocked amount', 4], ['amount is blocked', 4], ['still blocked', 3], ['still on hold', 4], ['still held', 3], ['not been released', 4],
      ['not released', 3], ['held on my card', 4], ['frozen on my card', 4], ['pending transaction', 3], ['pending authorization', 4], ['deposit hold', 3],
    ],
    ar: [
      ['تفويض مسبق', 5], ['الحجز المسبق', 5], ['حجز مبلغ', 4], ['حجز المبلغ', 4], ['المبلغ المحجوز', 5], ['مبلغ محجوز', 5], ['محجوز على بطاقتي', 5],
      ['محجوز في بطاقتي', 5], ['تجميد المبلغ', 4], ['مبلغ مجمد', 4], ['فك الحجز', 5], ['رفع الحجز', 5], ['الإفراج عن المبلغ', 5], ['الإفراج عن الحجز', 5],
      ['ما زال محجوز', 4], ['لا يزال محجوز', 4], ['الحجز على البطاقة', 5], ['حجز على البطاقة', 5], ['معاملة معلقة', 3],
    ],
  },
  invoice_request: {
    en: [
      ['invoice', 3], ['tax invoice', 5], ['vat invoice', 5], ['copy of the invoice', 5], ['copy of invoice', 5], ['send me the invoice', 5], ['send the invoice', 5],
      ['send invoice', 5], ['need an invoice', 5], ['need invoice', 5], ['require an invoice', 5], ['request an invoice', 5], ['invoice request', 5],
      ['invoice for contract', 5], ['invoice for the contract', 5], ['invoice for my rental', 5], ['final invoice', 4], ['company invoice', 4],
      ['invoice in the name of', 5], ['invoice to our company', 5], ['receipt', 2], ['payment receipt', 4], ['tax receipt', 4], ['vat certificate', 3],
    ],
    ar: [
      ['فاتورة', 3], ['فاتورة ضريبية', 5], ['نسخة من الفاتورة', 5], ['إرسال الفاتورة', 5], ['ارسل لي الفاتورة', 5], ['أريد فاتورة', 5], ['احتاج فاتورة', 5],
      ['طلب فاتورة', 5], ['الفاتورة الضريبية', 5], ['فاتورة باسم', 5], ['فاتورة للعقد', 5], ['فاتورة العقد', 5], ['إيصال', 2], ['إيصال الدفع', 4],
    ],
  },
  deposit_refund: {
    en: [
      ['security deposit', 5], ['deposit refund', 5], ['refund of the deposit', 5], ['refund of my deposit', 5], ['refund my deposit', 5], ['refund the deposit', 5],
      ['deposit has not been refunded', 5], ['deposit not refunded', 5], ["deposit hasn't been refunded", 5], ['return of my deposit', 5], ['return of the deposit', 5],
      ['return my deposit', 5], ['deposit return', 5], ['get my deposit back', 5], ['when will i get my deposit', 5], ['deposit back', 4],
      ['still waiting for my deposit', 5], ['deposit', 2], ['refund', 2], ['refund pending', 3], ['refund status', 3], ['awaiting refund', 3],
    ],
    ar: [
      ['مبلغ التأمين', 5], ['التأمين', 3], ['استرداد التأمين', 5], ['استرجاع التأمين', 5], ['إرجاع التأمين', 5], ['إعادة التأمين', 5], ['لم يتم استرداد', 4],
      ['لم يتم استرجاع', 4], ['استرداد المبلغ', 3], ['وديعة', 3], ['استرداد الوديعة', 5], ['تأمين السيارة', 3], ['مبلغ الضمان', 4], ['استرداد الضمان', 4],
    ],
  },
  vehicle_collection: {
    en: [
      ['collect the vehicle', 5], ['collect the car', 5], ['collect my vehicle', 5], ['collection of the vehicle', 5], ['collection of the car', 5], ['vehicle collection', 5],
      ['car collection', 5], ['collection request', 5], ['arrange collection', 5], ['arrange a collection', 5], ['arrange for collection', 5], ['schedule collection', 5],
      ['schedule a collection', 5], ['pick up the car', 4], ['pick up the vehicle', 4], ['pickup the car', 4], ['pick-up the car', 4], ['pick up from my location', 5],
      ['collect from my location', 5], ['collect it from', 4], ['come and collect', 5], ['send someone to collect', 5], ['send a driver to collect', 5],
      ['end my rental', 3], ['terminate the contract', 3], ['return the car', 2], ['return the vehicle', 2], ['collection', 3],
    ],
    ar: [
      ['استلام السيارة', 5], ['استلام المركبة', 5], ['إرسال شخص لاستلام', 5], ['إرسال مندوب لاستلام', 5], ['مندوب لاستلام', 5], ['استلام من موقعي', 5],
      ['استلام من الموقع', 4], ['سحب السيارة', 4], ['أريد استلام', 3], ['إنهاء العقد', 3], ['ترتيب استلام', 5], ['موعد الاستلام', 3], ['استلام السيارة من', 5],
    ],
  },
  fine_dispute: {
    en: [
      ['traffic fine', 4], ['salik', 4], ['toll charge', 3], ['speeding fine', 4], ['parking fine', 4], ['fine dispute', 5], ['not my fine', 5], ['dispute the fine', 5],
      ['fine was not mine', 5], ['admin fee on the fine', 4], ['violation', 3], ['traffic violation', 4], ['radar', 3],
    ],
    ar: [['مخالفة مرورية', 5], ['مخالفة', 3], ['مخالفات', 3], ['سالك', 4], ['اعتراض على المخالفة', 5], ['رسوم سالك', 5], ['رسوم إدارية على المخالفة', 4]],
  },
  damage_dispute: {
    en: [
      ['damage charge', 5], ['damage claim', 5], ['scratch', 3], ['dent', 3], ['cleaning fee', 4], ['fuel charge', 4], ['refuelling charge', 4], ['dispute the damage', 5],
      ['damage was already there', 5], ['pre-existing damage', 5], ['was already damaged', 4],
    ],
    ar: [['رسوم الضرر', 5], ['رسوم الأضرار', 5], ['خدش', 3], ['تلفيات', 4], ['رسوم تنظيف', 4], ['رسوم وقود', 4], ['الضرر كان موجود', 5]],
  },
  refund_request: {
    en: [
      ['overcharged', 4], ['overcharge', 4], ['duplicate payment', 5], ['paid twice', 5], ['cancellation refund', 5], ['refund for the cancelled booking', 5],
      ['refund of the difference', 5], ['refund the extra', 4], ['money back', 3], ['refund', 2], ['refund request', 4],
    ],
    ar: [['دفعت مرتين', 5], ['استرداد قيمة الإلغاء', 5], ['استرجاع المبلغ', 3], ['مبلغ مسترد', 3], ['استرداد المبلغ', 3], ['تم خصم أكثر', 3]],
  },
  contract_extension: {
    en: [
      ['extend the contract', 5], ['extend my rental', 5], ['extend the rental', 5], ['extension', 3], ['extend for', 3], ['extra days', 3], ['additional days', 3],
      ['shorten the rental', 4], ['change the dates', 3], ['change my booking', 3],
    ],
    ar: [['تمديد العقد', 5], ['تمديد الإيجار', 5], ['تمديد', 3], ['أيام إضافية', 3], ['تغيير موعد', 3]],
  },
  contract_copy: {
    en: [['copy of the contract', 5], ['contract copy', 5], ['rental agreement copy', 5], ['copy of the agreement', 5], ['statement of account', 5], ['account statement', 5], ['send the contract', 4]],
    ar: [['نسخة من العقد', 5], ['كشف حساب', 5], ['صورة من العقد', 5]],
  },
  vehicle_issue: {
    en: [
      ['broke down', 5], ['breakdown', 5], ['break down', 4], ["won't start", 5], ['warning light', 4], ['flat tyre', 5], ['flat tire', 5], ['puncture', 4], ['accident', 4],
      ['replacement car', 5], ['replacement vehicle', 5], ['stranded', 4], ['battery is dead', 4], ['engine', 2], ['towing', 3],
    ],
    ar: [['تعطلت', 5], ['السيارة متعطلة', 5], ['السيارة لا تعمل', 5], ['عطل', 4], ['حادث', 4], ['سيارة بديلة', 5], ['بنشر', 5], ['ثقب في الإطار', 4], ['ونش', 3]],
  },
  service_complaint: {
    en: [
      ['complaint', 4], ['complain', 4], ['unacceptable', 4], ['terrible service', 5], ['poor service', 5], ['bad service', 5], ['worst service', 5], ['very disappointed', 4],
      ['disappointed', 3], ['not happy', 3], ['unhappy', 3], ['no one responded', 4], ['nobody replied', 4], ['no response', 3], ['waiting for hours', 3], ['escalate', 3],
    ],
    ar: [['شكوى', 5], ['أشتكي', 4], ['سوء الخدمة', 5], ['خدمة سيئة', 5], ['تجربة سيئة', 5], ['غير مقبول', 4], ['مستاء', 4], ['غير راض', 4], ['لم يتم الرد', 3], ['لا أحد يرد', 4]],
  },
  staff_complaint: {
    en: [['rude', 4], ['impolite', 4], ['staff behaviour', 5], ['staff behavior', 5], ['unprofessional', 4], ['shouted at', 4], ['disrespect', 4]],
    ar: [['موظف غير محترم', 5], ['سوء معاملة', 5], ['تعامل سيء', 5], ['بطريقة غير لائقة', 4], ['عدم احترام', 4]],
  },
  vehicle_condition_complaint: {
    en: [['dirty car', 5], ['car was dirty', 5], ['not clean', 3], ['bad smell', 3], ['not the car i booked', 5], ['wrong vehicle', 4], ['bad condition', 4], ['poor condition', 4], ['not as booked', 4], ['downgrade', 3]],
    ar: [['سيارة وسخة', 5], ['غير نظيفة', 4], ['رائحة', 3], ['سيارة مختلفة', 4], ['حالة سيئة', 4], ['ليست السيارة المحجوزة', 5]],
  },
  billing_complaint: {
    en: [['hidden fees', 5], ['hidden charges', 5], ['overpriced', 3], ['higher than quoted', 5], ['more than agreed', 4], ['billing error', 5], ['wrong invoice', 5], ['invoice is wrong', 5], ['incorrect invoice', 5], ['price was different', 4]],
    ar: [['رسوم مخفية', 5], ['أعلى من المتفق', 5], ['خطأ في الفاتورة', 5], ['فاتورة خاطئة', 5], ['أسعار مختلفة', 3]],
  },
  general_inquiry: {
    en: [
      ['quotation', 3], ['availability', 3], ['opening hours', 3], ['branch location', 3], ['monthly rental', 3], ['long term rental', 3], ['inquiry', 3], ['enquiry', 3],
      ['i would like to know', 2], ['what documents', 3], ['age requirement', 3], ['one way rental', 3], ['do you have', 2], ['how much', 2], ['rates', 2],
    ],
    ar: [['استفسار', 4], ['أريد معرفة', 2], ['كم سعر', 3], ['هل لديكم', 3], ['ساعات العمل', 3], ['إيجار شهري', 3], ['المستندات المطلوبة', 3], ['أسعار', 2]],
  },
  spam_or_auto: {
    en: [
      ['unsubscribe', 4], ['newsletter', 4], ['out of office', 5], ['automatic reply', 5], ['auto-reply', 5], ['autoreply', 5], ['delivery has failed', 5], ['undeliverable', 5],
      ['mailer-daemon', 5], ['special offer', 3], ['limited time offer', 4], ['seo services', 5], ['guest post', 5], ['partnership proposal', 3], ['job application', 3], ['cv attached', 3],
    ],
    ar: [['رد تلقائي', 5], ['خارج المكتب', 5]],
  },
};

// Second pass, after the first accuracy check on hand-written emails: general phrasing families the
// starter list did not cover (how customers actually word these requests). Third value 'regex' = pattern.
const MORE = {
  unrecognized_charge: {
    en: [
      ['payment to autostrad', 3], ['payment from autostrad', 3], ['charge from autostrad', 3], ['charged by autostrad', 2], ['do not understand this charge', 4], ["don't understand this charge", 4],
      ['do not understand this payment', 4], ['payment i do not understand', 4], ['unknown payment', 4], ['unrecognized payment', 5], ['unrecognised payment', 5], ['unfamiliar charge', 4],
      ['unfamiliar payment', 4], ['payment on my visa', 3], ['payment on my card', 3], ['charge on my visa', 3], ['identical charges', 4], ['duplicate charge', 4], ['duplicate charges', 4],
      ['charged again', 3], ['extra charge on my card', 4], ['transaction i do not', 3], ['reverse the duplicate', 4], ['reverse the charge', 4], ['dispute it with my bank', 3],
    ],
    ar: [['لا أعرف سبب', 4], ['لا أعرف سبب هذا الخصم', 5], ['بخصم مبلغ', 3], ['خصم لا أعرف', 4], ['دفعة لا أعرفها', 4], ['مبلغ لا أعرفه', 4], ['خصمين', 3], ['عملية لا أعرفها', 5]],
  },
  contract_copy: {
    en: [
      ['copy of my rental agreement', 5], ['copy of rental agreement', 5], ['copy of the rental agreement', 5], ['copy of my contract', 5], ['copy of my agreement', 5], ['copy of my signed', 4],
      ['signed rental agreement', 4], ['signed contract', 3], ['send me the contract', 4], ['send me a copy of', 3], ['contract document', 3], ['copy of my statement', 4], ['rental agreement', 2],
    ],
    ar: [['نسخة من عقد', 5], ['صورة من عقد', 5], ['نسخة عقد', 4], ['نسخة من الاتفاقية', 4], ['نسخة من عقد الإيجار', 5], ['عقد الإيجار الخاص بي', 2], ['كشف الحساب', 4]],
  },
  staff_complaint: {
    en: [
      ['was extremely rude', 5], ['was very rude', 5], ['employee was rude', 5], ['rude employee', 5], ['rude staff', 5], ['behaved badly', 4], ['behaviour of', 3], ['behavior of', 3],
      ['disrespectful', 4], ['treated me badly', 4], ['treated me rudely', 5], ['shouted', 3], ['bad attitude', 4], ['attitude of the', 3],
    ],
    ar: [['تعامل غير لائق', 5], ['أسلوب غير لائق', 5], ['غير محترم', 4], ['أسلوب غير محترم', 5], ['تعامل غير محترم', 5], ['قلة احترام', 4], ['أحد موظفي', 2], ['موظف الفرع', 2]],
  },
  vehicle_condition_complaint: {
    en: [
      ['was dirty', 4], ['dirty inside', 5], ['smelled of smoke', 5], ['smelled of', 3], ['air conditioning', 3], ['air conditioner', 3], ['ac did not work', 5], ['ac was not working', 5], ['ac not working', 5],
      ['ac barely worked', 5], ["ac didn't work", 5], ['stained seats', 4], ['not what i paid for', 3],
    ],
    ar: [['متسخة', 4], ['متسخ', 4], ['قذرة', 4], ['المكيف لا يعمل', 5], ['المكيف ما يشتغل', 5], ['المكيف ضعيف', 4], ['المكيف', 2], ['رائحة كريهة', 4]],
  },
  refund_request: {
    en: [
      ['cancel my booking', 4], ['cancel the booking', 4], ['cancel my reservation', 4], ['cancellation', 2], ['cancel and refund', 5], ['refund the prepaid', 5], ['prepaid amount', 4],
      ['get a refund', 3], ['refund my booking', 5], ['refund for my booking', 5], ['refund of the prepaid', 5],
    ],
    ar: [['إلغاء الحجز', 5], ['إلغاء حجزي', 5], ['استرداد المبلغ المدفوع', 5], ['المبلغ المدفوع مسبقا', 5], ['المبلغ المدفوع مسبقاً', 5]],
  },
  billing_complaint: {
    en: [
      ['higher than the quote', 5], ['higher than the quoted', 5], ['higher than quote', 5], ['higher than the price', 4], ['compared to my quote', 5], ['compared to the quote', 5], ['different from the quote', 4],
      ['more than the quote', 4], ['overcharged compared to', 5], ['correct the invoice', 4], ['correct the bill', 4], ['review the bill', 3], ['bill is wrong', 4], ['incorrect bill', 5], ['price i was quoted', 4],
    ],
    ar: [['أعلى من السعر', 5], ['السعر في الفاتورة', 4], ['تصحيح الفاتورة', 5], ['مراجعة الحساب', 3]],
  },
  contract_extension: {
    en: [['please extend', 4], ['extend my booking', 5], ['extend the booking', 5], ['extend by', 3], ['extend my', 3], ['extend it', 3], ['can i extend', 5]],
    ar: [['أود تمديد', 5], ['أرغب في تمديد', 5], ['تمديد عقد', 5], ['زيادة المدة', 3]],
  },
  fine_dispute: {
    en: [
      ['administration fee', 3], ['admin fee', 3], ['administrative fee', 3], ['on top of the traffic fine', 5], ['fine notification', 4], ['fine reference', 4], ['fine ref', 3],
      ['fine for a date', 4], ['fine on my contract', 4], ['tf-\\d{5,}', 4, 'regex'], ['slk-\\d{4,}', 4, 'regex'],
    ],
    ar: [['إشعار مخالفة', 5], ['بمخالفة مرورية', 5], ['قيمة المخالفة', 4], ['خصم المخالفة', 4]],
  },
  damage_dispute: {
    en: [
      ['deducted for damage', 5], ['deducted for the damage', 5], ['damage i did not cause', 5], ['damage that was not', 4], ['not caused by me', 4], ['did not cause the damage', 5],
      ['billed for damage', 5], ['billed for a scratch', 5], ['charged for damage', 5], ['charged for the damage', 5], ['already there when i', 4], ['photos from pickup', 3],
    ],
    ar: [['رسوم أضرار', 5], ['كان موجوداً قبل', 4], ['كان موجودا قبل', 4], ['خدش في', 4], ['ضرر لم أتسبب', 5]],
  },
  invoice_request: {
    en: [['email me the invoice', 4], ['send me the invoice', 4], ['invoice for my last rental', 5], ['invoice under my company', 5], ['company name', 2], ['trn', 3]],
    ar: [['الفاتورة الضريبية', 5], ['فاتورة ضريبية', 5], ['باسم الشركة', 4]],
  },
  vehicle_collection: {
    en: [['collect the vehicle', 5], ['collect the car', 5], ['collection of the car', 5], ['pick up the car from', 4], ['pick up the vehicle', 4], ['end the rental early', 4]],
    ar: [['استلام السيارة من', 5], ['لاستلام السيارة', 5], ['استلام المركبة', 5]],
  },
  spam_or_auto: {
    en: [['delivery status notification', 5], ['mail delivery failed', 5], ['message not delivered', 5], ['address not found', 4], ['undelivered mail', 5], ['returned mail', 4], ['do not reply to this email', 4], ['this is an automated message', 4]],
    ar: [['لم يتم تسليم الرسالة', 5], ['رسالة آلية', 4], ['هذه رسالة تلقائية', 5]],
  },
  general_inquiry: {
    en: [['international driving licence', 3], ['international driving license', 3], ['international license', 3], ['minimum age', 3], ['do you rent', 3], ['can i rent', 3], ['tourists', 2]],
    ar: [['رخصة قيادة دولية', 3], ['هل يمكن استئجار', 3], ['ما هي', 1]],
  },
};
for (const [sub, langs] of Object.entries(MORE)) {
  for (const [lang, list] of Object.entries(langs)) DEFAULT_KEYWORDS[sub][lang].push(...list);
}

/** Flat rows for hd_keywords. */
export function defaultKeywordRows() {
  const rows = [];
  for (const [sub, langs] of Object.entries(DEFAULT_KEYWORDS)) {
    for (const [language, list] of Object.entries(langs)) {
      for (const [term, weight, kind] of list) rows.push({ sub_key: sub, language, term, weight, kind: kind || 'phrase' });
    }
  }
  return rows;
}
