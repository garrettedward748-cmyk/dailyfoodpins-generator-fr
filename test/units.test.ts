import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, maskSecret } from '../src/lib/crypto.js';
import { parseCsv, parseCsvTable } from '../src/lib/csv.js';
import { parseJson, requireFields, stripFences, LlmJsonError } from '../src/pipeline/json.js';
import { missingVariables, render } from '../src/pipeline/prompts.js';

describe('crypto', () => {
  const key = randomBytes(32);

  it('round-trips a value', () => {
    const secret = 'rtk_abc123_super_secret_token';
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('passes empty strings through untouched', () => {
    expect(encrypt('', key)).toBe('');
    expect(decrypt('', key)).toBe('');
  });

  it('refuses to decrypt with the wrong key', () => {
    const payload = encrypt('secret', key);
    expect(() => decrypt(payload, randomBytes(32))).toThrow(/ENCRYPTION_KEY changed/);
  });

  it('detects tampering', () => {
    const parts = encrypt('secret', key).split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
  });

  it('masks secrets without revealing them', () => {
    const masked = maskSecret('rtk_1234567890abcdef');
    expect(masked).toContain('rtk_');
    expect(masked).not.toContain('567890');
  });
});

describe('csv', () => {
  it('parses a simple table', () => {
    const { headers, rows } = parseCsvTable('a,b\n1,2\n3,4\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles quoted fields containing commas and newlines', () => {
    const rows = parseCsv('a,b\n"hello, world","line1\nline2"\n');
    expect(rows[1]).toEqual(['hello, world', 'line1\nline2']);
  });

  it('handles escaped quotes', () => {
    expect(parseCsv('a\n"say ""hi"""\n')[1]).toEqual(['say "hi"']);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    expect(parseCsvTable('﻿seed_keyword,x\nchicken,1\n').headers[0]).toBe('seed_keyword');
  });

  it('ignores blank trailing lines', () => {
    expect(parseCsvTable('a,b\n1,2\n\n').rows).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvTable('a,b\r\n1,2\r\n').rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsvTable('').rows).toHaveLength(0);
  });
});

describe('LLM JSON handling', () => {
  it('parses plain JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts JSON surrounded by commentary', () => {
    expect(parseJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('repairs trailing commas', () => {
    expect(parseJson('{"a":1,}')).toEqual({ a: 1 });
    expect(parseJson('{"a":[1,2,]}')).toEqual({ a: [1, 2] });
  });

  it('throws a typed error with the raw text attached', () => {
    try {
      parseJson('not json at all', 'Part 1 output');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmJsonError);
      expect((err as LlmJsonError).message).toContain('Part 1 output');
    }
  });

  it('rejects empty output', () => {
    expect(() => parseJson('')).toThrow(/empty/);
  });

  it('reports every missing required field at once', () => {
    expect(() => requireFields({ a: 1 }, ['a', 'b', 'c'], 'Test')).toThrow(/b, c/);
  });
});

describe('prompt rendering', () => {
  it('substitutes dotted paths', () => {
    expect(render('Title: {{seo.title}}', { seo: { title: 'Chicken' } })).toBe('Title: Chicken');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('{{ seo.title }}', { seo: { title: 'X' } })).toBe('X');
  });

  it('renders a missing value as an empty string rather than the placeholder', () => {
    expect(render('[{{nope.missing}}]', {})).toBe('[]');
  });

  it('JSON-encodes non-string values', () => {
    expect(render('{{list}}', { list: [1, 2] })).toBe('[1,2]');
  });

  it('leaves text without placeholders untouched', () => {
    expect(render('no placeholders', {})).toBe('no placeholders');
  });

  it('reports unsatisfied placeholders for diagnostics', () => {
    const missing = missingVariables('{{a.b}} {{c}}', { a: { b: 1 } });
    expect(missing).toEqual(['c']);
  });
});
