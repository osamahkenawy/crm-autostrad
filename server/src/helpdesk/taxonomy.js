// The helpdesk vocabulary: categories, request types ("sub-categories"), impact, priority, departments.
// Categories follow the Daily Log CH columns in the scope of work (Complaint, Service Request,
// Pre-Authorization, Refund, Dispute, Other). The five request types the scope names as the first
// automation targets are flagged `top5`.

export const CATEGORIES = ['Complaint', 'Service Request', 'Pre-Authorization', 'Refund', 'Dispute', 'Other'];
export const PRIORITIES = ['Critical', 'High', 'Average', 'Low'];
export const STATUSES = ['open', 'pending_customer', 'pending_internal', 'closed'];
export const ACTIVE_STATUSES = ['open', 'pending_customer', 'pending_internal'];
/** Statuses where the clock runs against us (waiting for the customer pauses the SLA). */
export const WORKING_STATUSES = ['open', 'pending_internal'];
export const IMPACTS = ['Financial', 'Service disruption', 'Customer experience', 'Legal or compliance', 'Administrative'];
export const DEPARTMENTS = ['Customer Happiness', 'Accounts', 'Branch', 'Operations', 'Management'];

export const CLOSURE_REASONS = [
  { value: 'resolved', label: 'Resolved, customer informed' },
  { value: 'action_completed', label: 'Action completed (refund, invoice, collection)' },
  { value: 'customer_confirmed', label: 'Customer confirmed it is resolved' },
  { value: 'no_response', label: 'No response from the customer' },
  { value: 'duplicate', label: 'Duplicate of another case' },
  { value: 'not_applicable', label: 'Not a customer service case (spam or auto reply)' },
  { value: 'referred', label: 'Referred to another team or channel' },
];

export const SUBCATEGORIES = [
  // ---- the five first-wave request types (62.3% of 2026 cases) ----
  { key: 'unrecognized_charge', name: 'Unrecognized Charge', category: 'Dispute', impact: 'Financial', department: 'Accounts', sensitive: true, top5: true,
    desc: 'The customer does not recognise, or disputes, a charge or deduction on their card or invoice.' },
  { key: 'preauth_followup', name: 'Pre-Authorization Follow-Up', category: 'Pre-Authorization', impact: 'Financial', department: 'Accounts', sensitive: false, top5: true,
    desc: 'The customer asks about a card hold (pre-authorization) that has not been released yet.' },
  { key: 'invoice_request', name: 'Invoice Request', category: 'Service Request', impact: 'Administrative', department: 'Customer Happiness', sensitive: false, top5: true,
    desc: 'The customer asks for an invoice, tax invoice or receipt for a contract.' },
  { key: 'deposit_refund', name: 'Security Deposit Refund', category: 'Refund', impact: 'Financial', department: 'Accounts', sensitive: true, top5: true,
    desc: 'The customer asks when the security deposit will be refunded, or says it has not been returned.' },
  { key: 'vehicle_collection', name: 'Vehicle Collection', category: 'Service Request', impact: 'Service disruption', department: 'Branch', sensitive: false, top5: true,
    desc: 'The customer asks Autostrad to collect the vehicle from a location, or to end the rental with a collection.' },
  // ---- other request types ----
  { key: 'fine_dispute', name: 'Fine or Salik Dispute', category: 'Dispute', impact: 'Financial', department: 'Accounts', sensitive: true,
    desc: 'The customer disputes a traffic fine, a Salik toll or the admin fee added to it.' },
  { key: 'damage_dispute', name: 'Damage or Fuel Charge Dispute', category: 'Dispute', impact: 'Financial', department: 'Branch', sensitive: true,
    desc: 'The customer disputes a damage, scratch, cleaning or fuel charge.' },
  { key: 'refund_request', name: 'Refund Request', category: 'Refund', impact: 'Financial', department: 'Accounts', sensitive: true,
    desc: 'The customer asks for a refund of an overcharge, a duplicate payment or a cancellation (not the security deposit).' },
  { key: 'contract_extension', name: 'Contract Extension or Change', category: 'Service Request', impact: 'Administrative', department: 'Customer Happiness', sensitive: false,
    desc: 'The customer wants to extend, shorten or change the rental period or details.' },
  { key: 'contract_copy', name: 'Contract or Statement Copy', category: 'Service Request', impact: 'Administrative', department: 'Customer Happiness', sensitive: false,
    desc: 'The customer asks for a copy of the contract, a statement of account or another document.' },
  { key: 'vehicle_issue', name: 'Breakdown or Vehicle Issue', category: 'Service Request', impact: 'Service disruption', department: 'Operations', sensitive: false,
    desc: 'Breakdown, accident, warning light, puncture or a request for a replacement vehicle.' },
  { key: 'service_complaint', name: 'Service Complaint', category: 'Complaint', impact: 'Customer experience', department: 'Customer Happiness', sensitive: false,
    desc: 'A general complaint about service quality, delays or lack of response.' },
  { key: 'staff_complaint', name: 'Staff Behaviour Complaint', category: 'Complaint', impact: 'Customer experience', department: 'Management', sensitive: false,
    desc: 'A complaint about the behaviour of a member of staff.' },
  { key: 'vehicle_condition_complaint', name: 'Vehicle Condition Complaint', category: 'Complaint', impact: 'Customer experience', department: 'Branch', sensitive: false,
    desc: 'The vehicle was dirty, damaged, in poor condition or not the car that was booked.' },
  { key: 'billing_complaint', name: 'Billing Complaint', category: 'Complaint', impact: 'Financial', department: 'Accounts', sensitive: true,
    desc: 'A complaint about pricing, hidden fees or a wrong invoice.' },
  { key: 'general_inquiry', name: 'General Inquiry', category: 'Other', impact: 'Administrative', department: 'Customer Happiness', sensitive: false,
    desc: 'A question about rates, availability, branches, documents or policies.' },
  { key: 'spam_or_auto', name: 'Spam or Automatic Reply', category: 'Other', impact: 'Administrative', department: 'Customer Happiness', sensitive: false,
    desc: 'Marketing, spam, newsletters, out-of-office or delivery failure notices.' },
];

export const SUB_BY_KEY = Object.fromEntries(SUBCATEGORIES.map((s) => [s.key, s]));
export const subByName = (name) => SUBCATEGORIES.find((s) => s.name === name) || null;
export const TOP5 = SUBCATEGORIES.filter((s) => s.top5);
