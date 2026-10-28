// The five roles, for forms and filters. What each role may DO is decided on the server (server/src/roles.js) and arrives
// with the signed-in person as `caps`; this list only names them.
export const ROLE_OPTIONS = [
  { value: 'it', label: 'IT (super admin)' },
  { value: 'admin', label: 'Admin' },
  { value: 'operations', label: 'Operations' },
  { value: 'customer_service', label: 'Customer service' },
  { value: 'finance', label: 'Finance' },
];
export const roleName = (value) => (ROLE_OPTIONS.find((r) => r.value === value) || {}).label || value;
