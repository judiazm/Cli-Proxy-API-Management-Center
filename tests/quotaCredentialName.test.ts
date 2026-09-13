/**
 * Credential-name masking.
 *
 * The point of the mask is that a screenshot of the quota page leaks no
 * address while still telling two accounts apart, so the cases that matter are
 * "what survives" as much as "what is hidden".
 */

import { describe, expect, test } from 'bun:test';
import { displayCredentialName, maskCredentialName } from '@/utils/quota';

describe('maskCredentialName', () => {
  test('keeps the provider prefix and account hash, masks mailbox and domain', () => {
    expect(maskCredentialName('claude-3701ed41-judiazm@outlook.com.json')).toBe(
      'claude-3701ed41-j•••m@o•••.com.json'
    );
  });

  test('keeps a plan suffix that follows the domain', () => {
    expect(maskCredentialName('codex-f0fb6efc-juliomast16@gmail.com-pro.json')).toBe(
      'codex-f0fb6efc-j•••6@g•••.com-pro.json'
    );
  });

  test('keeps a multi-part public suffix', () => {
    expect(maskCredentialName('codex-6810b467-jdiaz@miamiweb.ai-pro.json')).toBe(
      'codex-6810b467-j•••z@m•••.ai-pro.json'
    );
  });

  test('masks a single-character mailbox without dropping it', () => {
    expect(maskCredentialName('claude-a@example.com.json')).toBe('claude-a•••@e•••.com.json');
  });

  test('leaves names with no address untouched', () => {
    expect(maskCredentialName('kimi-9f2c1b.json')).toBe('kimi-9f2c1b.json');
  });
});

describe('displayCredentialName', () => {
  test('reveals the real name only when asked', () => {
    const name = 'claude-3701ed41-judiazm@outlook.com.json';
    expect(displayCredentialName(name, true)).toBe(name);
    expect(displayCredentialName(name, false)).toBe(maskCredentialName(name));
  });
});
