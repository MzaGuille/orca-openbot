// OPENBOT_ORCA_* settings, with one release of backward reading of the old names
// (plan-orca-openbot §4 step 1): when OPENBOT_ORCA_X is unset, OPENBOT_HERDR_X is used.
// `source` is process.env, an env object or the parsed values of config.env.
const NEW_PREFIX = 'OPENBOT_ORCA_';
const OLD_PREFIX = 'OPENBOT_HERDR_';

export function legacyName(name) {
  return String(name).startsWith(NEW_PREFIX) ? OLD_PREFIX + String(name).slice(NEW_PREFIX.length) : null;
}

// The new name wins whenever it is set (even to an empty string); otherwise the
// old name is read. Neither set: undefined, so callers keep their own default.
export function envVar(source, name) {
  const value = source?.[name];
  if (value !== undefined) return value;
  const old = legacyName(name);
  return old === null ? undefined : source?.[old];
}
