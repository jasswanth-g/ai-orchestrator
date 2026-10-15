import { describe, expect, test } from 'bun:test';
import { decodeDescription, encodeDescription } from '../src/store/meta.ts';

describe('description footer', () => {
  test('round-trips notes and meta', () => {
    const d = encodeDescription('From Ravi, re TCP', { source: 'mail', link: 'https://x/1' });
    expect(d).toBe('From Ravi, re TCP\n---\nsource: mail\nlink: https://x/1');
    expect(decodeDescription(d)).toEqual({ notes: 'From Ravi, re TCP', meta: { source: 'mail', link: 'https://x/1' } });
  });

  test('meta only, no notes', () => {
    const d = encodeDescription(undefined, { path: '/a/b.md' });
    expect(decodeDescription(d)).toEqual({ notes: undefined, meta: { path: '/a/b.md' } });
  });

  test('a user "---" with non-meta lines stays as notes', () => {
    const d = 'line one\n---\nsomething else';
    expect(decodeDescription(d)).toEqual({ notes: d, meta: {} });
  });

  test('plain description has no meta', () => {
    expect(decodeDescription('just notes')).toEqual({ notes: 'just notes', meta: {} });
  });
});

test('a multi-line approach survives the one-line footer', () => {
  const approach = 'Step 1: ask TCPL\nStep 2: a path like C:\\new stays intact';
  const description = encodeDescription('notes', { source: 'teams', approach });
  expect(description.split('\n')).toHaveLength(4);
  expect(decodeDescription(description)).toEqual({ notes: 'notes', meta: { source: 'teams', approach } });
});
