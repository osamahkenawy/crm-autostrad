// Who can do what. The one place that decides it: the API enforces it on every request, and the web app reads the same
// answer from /api/auth/me, so the screens and the server cannot disagree. To change what a role may do, change this file.
//
// Five roles:
//   it                IT, the super admin: runs the system and can do everything
//   admin             sees everything and can work in all of it, but does not run the system (accounts, mailbox and AI switches)
//   operations        bookings, trips, fleet, maintenance, fines, branches, customers
//   customer_service  the helpdesk and customers; sees bookings, invoices and fines to answer questions
//   finance           invoices, fines and money; approves replies to sensitive financial requests

export const ROLES = [
  { key: 'it', label: 'IT (super admin)', blurb: 'Runs the system: user accounts and roles, the mailbox and AI switches, every setting. Can see and do everything.' },
  { key: 'admin', label: 'Admin', blurb: 'Sees everything in the CRM and the helpdesk and can work in all of it. Does not manage user accounts or the mailbox and AI switches.' },
  { key: 'operations', label: 'Operations', blurb: 'Bookings, trips, fleet, maintenance, fines, branches and customers. Works helpdesk cases.' },
  { key: 'customer_service', label: 'Customer service', blurb: 'Works the helpdesk and looks after customers. Can see bookings, invoices and fines to answer questions, not change them.' },
  { key: 'finance', label: 'Finance', blurb: 'Invoices, fines and customer money. Approves replies to sensitive financial requests. Works helpdesk cases.' },
];
export const ROLE_KEYS = ROLES.map((r) => r.key);
export const roleLabel = (key) => (ROLES.find((r) => r.key === key) || {}).label || key;

const V = 'view';
const E = 'edit';
const N = null;
//                it  admin ops  cs   finance
const row = (it, admin, operations, customer_service, finance) => ({ it, admin, operations, customer_service, finance });

/** CRM areas by API resource name: null = no access, 'view' = read only, 'edit' = read and change. */
export const ACCESS = {
  dashboard:   row(V, V, V, N, V),
  bookings:    row(E, E, E, V, V),
  trips:       row(E, E, E, V, V),
  vehicles:    row(E, E, E, N, V),     // the fleet
  maintenance: row(E, E, E, N, V),
  fines:       row(E, E, E, V, E),
  customers:   row(E, E, E, E, V),
  leads:       row(E, E, V, N, N),     // corporate leads
  activities:  row(E, E, E, E, E),     // tasks
  invoices:    row(E, E, V, V, E),
  branches:    row(E, E, E, V, V),
  team:        row(E, V, N, N, N),     // staff accounts and roles
  settings:    row(E, E, N, N, V),     // company profile, VAT, fees
};

/** Helpdesk abilities: the roles that have each one. */
export const HELPDESK = {
  view: ROLE_KEYS,                                  // dashboard, cases, reports
  work: ROLE_KEYS,                                  // reply, approve ordinary replies, close, notes, take a case
  approve_sensitive: ['it', 'admin', 'finance'],    // replies to charges, refunds, deposits, card changes
  lab: ['it', 'admin'],                             // AI lab
  setup: ['it', 'admin'],                           // see the helpdesk setup screens
  rules: ['it', 'admin'],                           // reply wording, keywords, routing, timing, channel counts
  system: ['it'],                                   // mailbox mode, AI, write-back, safety switches
};

/** can('it', 'bookings.edit'), can('finance', 'helpdesk.approve_sensitive') */
export function can(role, cap) {
  const [area, what] = String(cap).split('.');
  if (area === 'helpdesk') return Boolean(HELPDESK[what] && HELPDESK[what].includes(role));
  const level = ACCESS[area] && ACCESS[area][role];
  if (!level) return false;
  return what === 'view' ? true : level === E;
}

/** Every capability a role has, as strings (sent to the web app). */
export function capsFor(role) {
  const out = [];
  for (const [area, byRole] of Object.entries(ACCESS)) {
    if (byRole[role]) out.push(`${area}.view`);
    if (byRole[role] === E) out.push(`${area}.edit`);
  }
  for (const [what, roles] of Object.entries(HELPDESK)) if (roles.includes(role)) out.push(`helpdesk.${what}`);
  return out;
}

export const rolesWith = (cap) => ROLE_KEYS.filter((r) => can(r, cap));

/** The "who can do what" table shown on the Team page. */
export function guide() {
  const area = (key, label) => ({ key, label, levels: Object.fromEntries(ROLE_KEYS.map((r) => [r, ACCESS[key][r] || 'none'])) });
  const hd = (key, label) => ({ key: `helpdesk.${key}`, label, levels: Object.fromEntries(ROLE_KEYS.map((r) => [r, HELPDESK[key].includes(r) ? 'yes' : 'none'])) });
  return {
    roles: ROLES,
    areas: [
      area('dashboard', 'CRM dashboard (revenue, fleet, KPIs)'), area('bookings', 'Bookings'), area('trips', 'Trips'), area('vehicles', 'Fleet'), area('maintenance', 'Maintenance'),
      area('fines', 'Fines and Salik'), area('customers', 'Customers'), area('leads', 'Corporate leads'), area('activities', 'Tasks'), area('invoices', 'Invoices'),
      area('branches', 'Branches'), area('team', 'Team accounts and roles'), area('settings', 'Company settings'),
      hd('view', 'Helpdesk: dashboard, cases and reports'), hd('work', 'Helpdesk: reply, close and work cases'), hd('approve_sensitive', 'Helpdesk: approve replies to sensitive financial requests'),
      hd('lab', 'Helpdesk: AI lab'), hd('rules', 'Helpdesk setup: reply wording, keywords, routing and timing'), hd('system', 'Helpdesk setup: mailbox, AI and safety switches'),
    ],
  };
}
