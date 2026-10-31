// Deterministic fake webhook secrets in the OpenBot shape (whsec_ + 43 base64url chars).
// Never a real credential.
export function fakeSecret(tag = 'fake') {
  const body = String(tag).replace(/[^A-Za-z0-9_-]/g, '-');
  return 'whsec_' + (body + 'A'.repeat(43)).slice(0, 43);
}
