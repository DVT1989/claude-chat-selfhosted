/** Filter for text that goes to another installation: passwords, tokens, keys and .env content are removed. Pure, no imports. */
const GONE = '[verwijderd]';
const SENSITIVE = '(?:pass(?:word|wd|phrase)?|pwd|wachtwoord|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|jwt|database_url|connection[_-]?string|client[_-]?secret|auth|key)';

/** Removes passwords, tokens, keys and .env content from text that goes to another installation. */
export function scrubSecrets(input: string): string {
  let t = String(input ?? '');
  // private key blocks (PEM, PKCS8, OpenSSH)
  t = t.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[privesleutel verwijderd]');
  // .env content: two or more KEY=VALUE lines in a row
  t = t.replace(/(?:^[ \t]*(?:export[ \t]+)?[A-Za-z][A-Za-z0-9_]*[ \t]*=[ \t]*\S.*(?:\r?\n|$)){2,}/gm, '[.env-inhoud verwijderd]\n');
  // credentials in a URL
  t = t.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi, `$1:${GONE}@`);
  // Authorization / Bearer
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${GONE}`);
  // VAR=value and VAR: value with a sensitive name (also quoted, also JSON "token": "...")
  t = t.replace(new RegExp(`(["']?[A-Za-z0-9_.-]*${SENSITIVE}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;}]+)`, 'gi'), (m, p1: string) => {
    return /\[verwijderd\]|\[\.env/.test(m) ? m : `${p1}${GONE}`;
  });
  // sentences: "het wachtwoord is X", "password: X", "token = X", "met wachtwoord X"
  t = t.replace(/\b((?:het|mijn|zijn|haar|de|het nieuwe|the|my|your)?\s*(?:wachtwoord|password|passwd|passphrase|pincode|pin-code|token|sleutel|api[- ]?key|geheime sleutel|secret)\s*(?:is|zijn|was|luidt|=|:|is dan|should be)\s*:?\s*)(?:"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|[^\s"”'’]+)/gi, `$1${GONE}`);
  t = t.replace(/\b((?:met|using|with|gebruik|via)\s+(?:het\s+|de\s+|the\s+)?(?:wachtwoord|password|token|sleutel|pincode)\s+)(?!is\b|van\b|voor\b|en\b|of\b|dat\b|niet\b|in\b|op\b|te\b)["“'‘]?[^\s"”'’.,;]{3,}["”'’]?/gi, `$1${GONE}`);
  // well-known token shapes
  t = t.replace(/\b(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|ccfk_[A-Za-z0-9_-]{10,})\b/g, '[token verwijderd]');
  // long random strings with at least three character classes (a sha1 hash is only lower-case + digits and stays)
  t = t.replace(/(?<![A-Za-z0-9_\-+/=.])[A-Za-z0-9_\-+/=]{40,}(?![A-Za-z0-9_\-+/=])/g, (m) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_\-+/=]/].filter((r) => r.test(m)).length;
    return classes >= 3 && !m.includes('/') ? '[token verwijderd]' : m;
  });
  return t;
}

