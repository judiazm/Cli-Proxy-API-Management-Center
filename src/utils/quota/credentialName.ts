/**
 * Credential file names carry the account's email address, which is the one
 * thing on this page nobody wants on a shared screen or in a screenshot. The
 * quota list masks it by default and reveals it behind an explicit toggle.
 *
 * The mask keeps everything that identifies the *credential* — provider
 * prefix, account hash, plan suffix, extension — and blanks only the parts
 * that identify the *person*: the mailbox and the domain name. Enough shape
 * survives (first and last letter, the TLD) to tell two accounts apart.
 *
 * Pure and clock-free; `tests/quotaCredentialName.test.ts` is the contract.
 */

/** The elision glyph — three bullets, matching the mono figures around it. */
export const CREDENTIAL_MASK_DOTS = '•••';

/** File extensions stripped before masking so `.json` is not read as a TLD. */
const KNOWN_EXTENSIONS = ['.json'];

const maskSegment = (value: string): string => {
  if (value.length === 0) return value;
  if (value.length === 1) return `${value}${CREDENTIAL_MASK_DOTS}`;
  return `${value[0]}${CREDENTIAL_MASK_DOTS}${value[value.length - 1]}`;
};

/**
 * `claude-3701ed41-judiazm@outlook.com.json` → `claude-3701ed41-j•••m@o•••.com.json`.
 *
 * Names with no `@` are returned untouched: there is no address in them to
 * hide, and blanking an opaque id would only make the list harder to read.
 */
export function maskCredentialName(name: string): string {
  const atIndex = name.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === name.length - 1) return name;

  const beforeAt = name.slice(0, atIndex);
  const afterAt = name.slice(atIndex + 1);

  // The mailbox starts after the last separator: provider prefix and account
  // hash (`codex-ae5d455f-`) stay legible, they identify the file not the user.
  const separatorIndex = Math.max(beforeAt.lastIndexOf('-'), beforeAt.lastIndexOf('_'));
  const prefix = beforeAt.slice(0, separatorIndex + 1);
  const localPart = beforeAt.slice(separatorIndex + 1);
  if (localPart.length === 0) return name;

  const extension = KNOWN_EXTENSIONS.find((candidate) => afterAt.toLowerCase().endsWith(candidate));
  const domain = extension ? afterAt.slice(0, afterAt.length - extension.length) : afterAt;
  if (domain.length === 0) return name;

  // Keep the public suffix (`.com`, `.ai-pro`): it is not identifying and it
  // is what lets a reader tell a work account from a personal one.
  const dotIndex = domain.lastIndexOf('.');
  const maskedDomain =
    dotIndex > 0
      ? `${domain[0]}${CREDENTIAL_MASK_DOTS}${domain.slice(dotIndex)}`
      : maskSegment(domain);

  return `${prefix}${maskSegment(localPart)}@${maskedDomain}${extension ?? ''}`;
}

/** Masked unless the viewer has explicitly asked to see addresses. */
export const displayCredentialName = (name: string, showEmails: boolean): string =>
  showEmails ? name : maskCredentialName(name);
