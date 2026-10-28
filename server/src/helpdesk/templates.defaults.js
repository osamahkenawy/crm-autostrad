// Sample reply wording for the five first-wave request types, plus a general acknowledgement.
// IMPORTANT: this is starter wording so the pilot works on day one. Customer Happiness should replace it
// with Autostrad's approved text (Helpdesk setup > Templates) and approve it there; only approved,
// active templates are ever used to draft a reply.
//
// Placeholders: {{name}}. Optional text: {{#name}}shown when name has a value{{/name}} and
// {{^name}}shown when it does not{{/name}}.

const FOOT_EN = `Kind regards,
{{agent_name}}
Customer Happiness | {{company_name}}
{{support_phone}}`;

const FOOT_AR = `مع أطيب التحيات،
{{agent_name}}
قسم إسعاد العملاء | {{company_name}}
{{support_phone}}`;

export const DEFAULT_TEMPLATES = [
  /* ------------------------------------------------------------ unrecognized charge */
  {
    sub_key: 'unrecognized_charge', kind: 'initial', language: 'en', name: 'Unrecognized charge: first reply',
    body: `Dear {{customer_first_name}},

Thank you for contacting {{company_name}}. We have received your query about the charge{{#amount_text}} of {{amount_text}}{{/amount_text}}{{#contract_no}} related to contract {{contract_no}}{{/contract_no}}, and we understand how worrying an unfamiliar charge can be.

Your case reference is {{case_no}}. Our Accounts team is reviewing the transaction and will confirm what it relates to, with the supporting details, within {{sla_text}}.

To help us trace it quickly, please reply with:
{{^contract_no}}- Your rental contract number
{{/contract_no}}- The date of the charge and the last four digits of the card used{{#card_last4}} (we have noted a card ending {{card_last4}}){{/card_last4}}
- A copy of the bank or card statement showing the charge (you may hide any other transactions)

If the charge turns out to be incorrect, we will correct it and confirm this to you in writing.

${FOOT_EN}`,
  },
  {
    sub_key: 'unrecognized_charge', kind: 'followup', language: 'en', name: 'Unrecognized charge: reminder',
    body: `Dear {{customer_first_name}},

We are following up on your query about the charge{{#amount_text}} of {{amount_text}}{{/amount_text}} (case {{case_no}}).

We have not yet received the information we asked for, so we cannot complete our review. Please reply with the date of the charge, the last four digits of the card and, if possible, a copy of the statement.

If we do not hear from you by {{close_date}}, we will close this case. You can reply to this email at any time to reopen it.

${FOOT_EN}`,
  },
  {
    sub_key: 'unrecognized_charge', kind: 'initial', language: 'ar', name: 'خصم غير معروف: الرد الأول',
    body: `السلام عليكم {{customer_first_name}}،

شكراً لتواصلكم مع {{company_name}}. استلمنا استفساركم بخصوص المبلغ{{#amount_text}} ({{amount_text}}){{/amount_text}}{{#contract_no}} المتعلق بالعقد رقم {{contract_no}}{{/contract_no}}، ونتفهم قلقكم من أي خصم غير معروف.

رقم طلبكم هو {{case_no}}. يقوم فريق الحسابات حالياً بمراجعة العملية، وسيوافيكم بتوضيح سبب الخصم مع المستندات الداعمة خلال {{sla_text}}.

لتسريع التحقق، نرجو التكرم بتزويدنا بما يلي:
{{^contract_no}}- رقم عقد الإيجار
{{/contract_no}}- تاريخ الخصم وآخر أربعة أرقام من البطاقة{{#card_last4}} (سجلنا بطاقة تنتهي بـ {{card_last4}}){{/card_last4}}
- نسخة من كشف الحساب البنكي توضح العملية (يمكنكم إخفاء أي عمليات أخرى)

وإذا تبين أن الخصم غير صحيح، فسنقوم بتصحيحه وإبلاغكم بذلك كتابياً.

${FOOT_AR}`,
  },
  {
    sub_key: 'unrecognized_charge', kind: 'followup', language: 'ar', name: 'خصم غير معروف: تذكير',
    body: `السلام عليكم {{customer_first_name}}،

نتابع معكم بخصوص استفساركم عن المبلغ{{#amount_text}} ({{amount_text}}){{/amount_text}} (رقم الطلب {{case_no}}).

لم نستلم حتى الآن المعلومات التي طلبناها، ولذلك لا يمكننا إكمال المراجعة. نرجو إرسال تاريخ الخصم وآخر أربعة أرقام من البطاقة، وإن أمكن نسخة من كشف الحساب.

إذا لم نتلق رداً منكم قبل {{close_date}} فسنقوم بإغلاق الطلب، ويمكنكم الرد على هذه الرسالة في أي وقت لإعادة فتحه.

${FOOT_AR}`,
  },

  /* ------------------------------------------------------------ pre-authorization */
  {
    sub_key: 'preauth_followup', kind: 'initial', language: 'en', name: 'Pre-authorization: status update',
    body: `Dear {{customer_first_name}},

Thank you for your email about the pre-authorization (card hold){{#amount_text}} of {{amount_text}}{{/amount_text}}{{#contract_no}} on contract {{contract_no}}{{/contract_no}}. Your case reference is {{case_no}}.

{{#preauth_status}}Our records show: {{preauth_status}}.

{{/preauth_status}}A pre-authorization is a temporary hold on your card that secures the rental. It is not a charge. Once the vehicle is returned and the contract is closed, we release the hold, and your bank then needs {{release_days}} to show the funds as available again. That period is set by the issuing bank.

{{#preauth_released}}We released the hold on {{preauth_released}}. If it still shows on your card after {{release_days}}, please contact your bank and let us know, and we will provide the release confirmation.

{{/preauth_released}}Our Accounts team is keeping this case open and we will update you by {{next_update}}.

${FOOT_EN}`,
  },
  {
    sub_key: 'preauth_followup', kind: 'followup', language: 'en', name: 'Pre-authorization: reminder',
    body: `Dear {{customer_first_name}},

We are following up on your pre-authorization query (case {{case_no}}).

{{#preauth_status}}Latest status: {{preauth_status}}.

{{/preauth_status}}Banks usually need {{release_days}} to show a released hold. If the amount is still blocked after that time, please reply with a screenshot of the hold from your banking app and we will request written confirmation of the release for you.

If your card is now clear, please let us know so that we can close the case.

${FOOT_EN}`,
  },
  {
    sub_key: 'preauth_followup', kind: 'initial', language: 'ar', name: 'تفويض مسبق: تحديث الحالة',
    body: `السلام عليكم {{customer_first_name}}،

شكراً لرسالتكم بخصوص التفويض المسبق (حجز المبلغ على البطاقة){{#amount_text}} ({{amount_text}}){{/amount_text}}{{#contract_no}} الخاص بالعقد رقم {{contract_no}}{{/contract_no}}. رقم طلبكم {{case_no}}.

{{#preauth_status}}حسب سجلاتنا: {{preauth_status}}.

{{/preauth_status}}التفويض المسبق هو حجز مؤقت على البطاقة لضمان الإيجار، وهو ليس خصماً. بعد إرجاع المركبة وإغلاق العقد نقوم بإلغاء الحجز، ثم يحتاج البنك المصدر للبطاقة إلى {{release_days}} لإظهار المبلغ كمتاح مرة أخرى، وهذه المدة يحددها البنك.

{{#preauth_released}}قمنا بإلغاء الحجز بتاريخ {{preauth_released}}. وإذا استمر ظهوره على بطاقتكم بعد {{release_days}}، فنرجو التواصل مع البنك وإبلاغنا لنزوّدكم بما يثبت الإلغاء.

{{/preauth_released}}يتابع فريق الحسابات هذا الطلب، وسنوافيكم بالمستجدات قبل {{next_update}}.

${FOOT_AR}`,
  },
  {
    sub_key: 'preauth_followup', kind: 'followup', language: 'ar', name: 'تفويض مسبق: تذكير',
    body: `السلام عليكم {{customer_first_name}}،

نتابع معكم بخصوص استفساركم عن التفويض المسبق (رقم الطلب {{case_no}}).

{{#preauth_status}}آخر حالة: {{preauth_status}}.

{{/preauth_status}}تحتاج البنوك عادة إلى {{release_days}} لإظهار المبلغ بعد إلغاء الحجز. وإذا ظل المبلغ محجوزاً بعد هذه المدة، نرجو إرسال لقطة شاشة للحجز من تطبيق البنك لنطلب لكم تأكيداً كتابياً بالإلغاء.

وإذا أصبحت البطاقة متاحة الآن، نرجو إبلاغنا لنتمكن من إغلاق الطلب.

${FOOT_AR}`,
  },

  /* ------------------------------------------------------------ invoice request */
  {
    sub_key: 'invoice_request', kind: 'initial', language: 'en', name: 'Invoice request: first reply',
    body: `Dear {{customer_first_name}},

Thank you for contacting {{company_name}}. Your case reference is {{case_no}}.

{{#invoice_no}}As requested, please find the tax invoice {{invoice_no}}{{#contract_no}} for contract {{contract_no}}{{/contract_no}}{{#invoice_total}} (total {{invoice_total}}, including 5% VAT){{/invoice_total}} attached to this email.

{{/invoice_no}}{{^invoice_no}}We are preparing your tax invoice{{#contract_no}} for contract {{contract_no}}{{/contract_no}} and will send it within {{sla_text}}. To make sure it is issued correctly, please confirm the company name and tax registration number (TRN) that should appear on it, if applicable.

{{/invoice_no}}If any detail on the invoice needs to change, reply to this email and we will issue a corrected copy.

${FOOT_EN}`,
  },
  {
    sub_key: 'invoice_request', kind: 'followup', language: 'en', name: 'Invoice request: reminder',
    body: `Dear {{customer_first_name}},

We are following up on your invoice request (case {{case_no}}). Please confirm that you received the invoice, or tell us what we should correct, such as the company name or the TRN.

If we do not hear from you by {{close_date}}, we will close this case. You can reply at any time to reopen it.

${FOOT_EN}`,
  },
  {
    sub_key: 'invoice_request', kind: 'initial', language: 'ar', name: 'طلب فاتورة: الرد الأول',
    body: `السلام عليكم {{customer_first_name}}،

شكراً لتواصلكم مع {{company_name}}. رقم طلبكم {{case_no}}.

{{#invoice_no}}بناءً على طلبكم، مرفق مع هذه الرسالة الفاتورة الضريبية رقم {{invoice_no}}{{#contract_no}} الخاصة بالعقد رقم {{contract_no}}{{/contract_no}}{{#invoice_total}} (الإجمالي {{invoice_total}} شاملاً ضريبة القيمة المضافة 5%){{/invoice_total}}.

{{/invoice_no}}{{^invoice_no}}نقوم حالياً بإعداد الفاتورة الضريبية{{#contract_no}} الخاصة بالعقد رقم {{contract_no}}{{/contract_no}} وسنرسلها لكم خلال {{sla_text}}. ولضمان إصدارها بشكل صحيح، نرجو تأكيد اسم الشركة والرقم الضريبي (TRN) المطلوب إدراجهما، إن وجد.

{{/invoice_no}}وإذا كان هناك أي تعديل مطلوب على الفاتورة، فيرجى الرد على هذه الرسالة وسنصدر نسخة معدلة.

${FOOT_AR}`,
  },
  {
    sub_key: 'invoice_request', kind: 'followup', language: 'ar', name: 'طلب فاتورة: تذكير',
    body: `السلام عليكم {{customer_first_name}}،

نتابع معكم بخصوص طلب الفاتورة (رقم الطلب {{case_no}}). نرجو تأكيد استلام الفاتورة، أو إبلاغنا بما يجب تعديله مثل اسم الشركة أو الرقم الضريبي.

إذا لم نتلق رداً قبل {{close_date}} فسنقوم بإغلاق الطلب، ويمكنكم الرد في أي وقت لإعادة فتحه.

${FOOT_AR}`,
  },

  /* ------------------------------------------------------------ security deposit refund */
  {
    sub_key: 'deposit_refund', kind: 'initial', language: 'en', name: 'Deposit refund: first reply',
    body: `Dear {{customer_first_name}},

Thank you for your email about the security deposit{{#deposit_amount}} of {{deposit_amount}}{{/deposit_amount}}{{#contract_no}} for contract {{contract_no}}{{/contract_no}}. Your case reference is {{case_no}}.

{{#deposit_status}}Current status: {{deposit_status}}.

{{/deposit_status}}Security deposits are refunded to the original payment card after the vehicle inspection and after any fines, Salik tolls or charges linked to the rental have been settled. Our Accounts team has been asked to review your refund and will confirm the status within {{sla_text}}. Once the refund is released, banks normally take {{release_days}} to show it.

If your card has changed or you would like to discuss another refund method, please do not send card or bank details by email. We will tell you how to share them securely.

${FOOT_EN}`,
  },
  {
    sub_key: 'deposit_refund', kind: 'followup', language: 'en', name: 'Deposit refund: update',
    body: `Dear {{customer_first_name}},

We are following up on your security deposit refund (case {{case_no}}).

{{#deposit_status}}Latest status: {{deposit_status}}.

{{/deposit_status}}Our Accounts team is completing the final checks on the contract{{#contract_no}} {{contract_no}}{{/contract_no}}. We will confirm as soon as the refund has been released, and your bank may then need {{release_days}} to show it. We will update you by {{next_update}}.

${FOOT_EN}`,
  },
  {
    sub_key: 'deposit_refund', kind: 'initial', language: 'ar', name: 'استرداد التأمين: الرد الأول',
    body: `السلام عليكم {{customer_first_name}}،

شكراً لرسالتكم بخصوص مبلغ التأمين{{#deposit_amount}} ({{deposit_amount}}){{/deposit_amount}}{{#contract_no}} الخاص بالعقد رقم {{contract_no}}{{/contract_no}}. رقم طلبكم {{case_no}}.

{{#deposit_status}}الحالة الحالية: {{deposit_status}}.

{{/deposit_status}}يتم استرداد مبلغ التأمين إلى بطاقة الدفع الأصلية بعد فحص المركبة وبعد تسوية أي مخالفات أو رسوم سالك أو مبالغ أخرى مرتبطة بالإيجار. طلبنا من فريق الحسابات مراجعة طلبكم، وسنؤكد لكم الحالة خلال {{sla_text}}. وبعد إتمام الاسترداد تحتاج البنوك عادة إلى {{release_days}} لإظهاره في الحساب.

وإذا تغيرت بطاقتكم أو أردتم مناقشة طريقة استرداد أخرى، فنرجو عدم إرسال بيانات البطاقة أو الحساب البنكي بالبريد الإلكتروني، وسنوضح لكم طريقة آمنة لمشاركتها.

${FOOT_AR}`,
  },
  {
    sub_key: 'deposit_refund', kind: 'followup', language: 'ar', name: 'استرداد التأمين: تحديث',
    body: `السلام عليكم {{customer_first_name}}،

نتابع معكم بخصوص استرداد مبلغ التأمين (رقم الطلب {{case_no}}).

{{#deposit_status}}آخر حالة: {{deposit_status}}.

{{/deposit_status}}يقوم فريق الحسابات بإكمال المراجعة النهائية للعقد{{#contract_no}} {{contract_no}}{{/contract_no}}. وسنؤكد لكم فور إتمام الاسترداد، وقد يحتاج البنك بعدها إلى {{release_days}} لإظهاره. وسنوافيكم بالمستجدات قبل {{next_update}}.

${FOOT_AR}`,
  },

  /* ------------------------------------------------------------ vehicle collection */
  {
    sub_key: 'vehicle_collection', kind: 'initial', language: 'en', name: 'Vehicle collection: first reply',
    body: `Dear {{customer_first_name}},

Thank you for contacting {{company_name}}. We have received your request to collect the vehicle{{#location}} from {{location}}{{/location}}{{#contract_no}} (contract {{contract_no}}){{/contract_no}}. Your case reference is {{case_no}}.

{{#branch_name}}Our {{branch_name}} team will contact you to confirm the collection time.{{/branch_name}}{{^branch_name}}Our branch team will contact you to confirm the collection time.{{/branch_name}} To arrange it, please reply with:
- The best phone number to reach you
- The exact collection location (a map pin helps) and a preferred time window
- The condition of the fuel level and any personal belongings still in the vehicle

Please make sure the vehicle is parked safely at the agreed location with the keys available. The rental ends once our team has inspected and collected the vehicle.

${FOOT_EN}`,
  },
  {
    sub_key: 'vehicle_collection', kind: 'followup', language: 'en', name: 'Vehicle collection: reminder',
    body: `Dear {{customer_first_name}},

We are following up on your vehicle collection request (case {{case_no}}). We have not yet been able to confirm a collection time.

Please reply with your phone number, the exact location and a preferred time window, and our team will arrange it right away.

${FOOT_EN}`,
  },
  {
    sub_key: 'vehicle_collection', kind: 'initial', language: 'ar', name: 'استلام المركبة: الرد الأول',
    body: `السلام عليكم {{customer_first_name}}،

شكراً لتواصلكم مع {{company_name}}. استلمنا طلبكم باستلام المركبة{{#location}} من {{location}}{{/location}}{{#contract_no}} (العقد رقم {{contract_no}}){{/contract_no}}. رقم طلبكم {{case_no}}.

{{#branch_name}}سيتواصل معكم فريق فرع {{branch_name}} لتأكيد موعد الاستلام.{{/branch_name}}{{^branch_name}}سيتواصل معكم فريق الفرع لتأكيد موعد الاستلام.{{/branch_name}} ولترتيب ذلك نرجو إرسال:
- أنسب رقم هاتف للتواصل معكم
- موقع الاستلام بدقة (يفضل إرسال الموقع على الخريطة) والوقت المناسب
- مستوى الوقود وأي أغراض شخصية متبقية في المركبة

نرجو التأكد من ركن المركبة في مكان آمن في الموقع المتفق عليه ومعها المفاتيح. وينتهي الإيجار بعد أن يقوم فريقنا بفحص المركبة واستلامها.

${FOOT_AR}`,
  },
  {
    sub_key: 'vehicle_collection', kind: 'followup', language: 'ar', name: 'استلام المركبة: تذكير',
    body: `السلام عليكم {{customer_first_name}}،

نتابع معكم بخصوص طلب استلام المركبة (رقم الطلب {{case_no}}). لم نتمكن حتى الآن من تأكيد موعد الاستلام.

نرجو إرسال رقم هاتفكم وموقع الاستلام بدقة والوقت المناسب، وسيقوم فريقنا بالترتيب فوراً.

${FOOT_AR}`,
  },

  /* ------------------------------------------------------------ everything else */
  {
    sub_key: '*', kind: 'initial', language: 'en', name: 'General acknowledgement',
    body: `Dear {{customer_first_name}},

Thank you for contacting {{company_name}}. We have received your email{{#contract_no}} regarding contract {{contract_no}}{{/contract_no}}, and your case reference is {{case_no}}.

Our {{department}} team is reviewing it and will reply within {{sla_text}}. If you have more details or documents, please reply to this email and quote the case reference.

${FOOT_EN}`,
  },
  {
    sub_key: '*', kind: 'followup', language: 'en', name: 'General reminder',
    body: `Dear {{customer_first_name}},

We are following up on your case {{case_no}}. We are waiting for your reply to complete the next step. If we do not hear from you by {{close_date}}, we will close the case, and you can reply at any time to reopen it.

${FOOT_EN}`,
  },
  {
    sub_key: '*', kind: 'initial', language: 'ar', name: 'إشعار استلام عام',
    body: `السلام عليكم {{customer_first_name}}،

شكراً لتواصلكم مع {{company_name}}. استلمنا رسالتكم{{#contract_no}} بخصوص العقد رقم {{contract_no}}{{/contract_no}}، ورقم طلبكم {{case_no}}.

يقوم فريق {{department}} بمراجعتها وسيرد عليكم خلال {{sla_text}}. وإذا كانت لديكم تفاصيل أو مستندات إضافية، فنرجو الرد على هذه الرسالة مع ذكر رقم الطلب.

${FOOT_AR}`,
  },
  {
    sub_key: '*', kind: 'followup', language: 'ar', name: 'تذكير عام',
    body: `السلام عليكم {{customer_first_name}}،

نتابع معكم بخصوص طلبكم رقم {{case_no}}. نحن بانتظار ردكم لإكمال الخطوة التالية. وإذا لم نتلق رداً قبل {{close_date}} فسنغلق الطلب، ويمكنكم الرد في أي وقت لإعادة فتحه.

${FOOT_AR}`,
  },
];

export const TEMPLATE_VARIABLES = [
  'customer_first_name', 'customer_name', 'case_no', 'contract_no', 'amount_text', 'card_last4', 'location', 'fine_ref', 'vehicle',
  'invoice_no', 'invoice_total', 'deposit_amount', 'deposit_status', 'preauth_status', 'preauth_released', 'sla_text', 'release_days',
  'next_update', 'close_date', 'branch_name', 'department', 'agent_name', 'support_phone', 'company_name',
];
