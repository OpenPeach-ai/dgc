// Connected account IDs are opaque provider identities, never an email or alias.
// Discovery also binds current toolkit-prefixed IDs to their reported toolkit.
const pattern = /^(?:(?:ca|coup)_[A-Za-z0-9_-]{1,120}|[a-z][a-z0-9]{1,39}_[A-Za-z0-9_-]{8,120})$/;
export function validAccountId(value, toolkit) {
  if (typeof value !== 'string' || !pattern.test(value)) return false;
  return !toolkit || value.startsWith('ca_') || value.startsWith('coup_') || value.startsWith(`${toolkit}_`);
}
