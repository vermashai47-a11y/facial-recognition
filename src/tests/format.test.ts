import { describe, it, expect } from 'vitest';
import { minutesToHours, toCsv, csvEscape } from '../lib/format';

describe('minutesToHours', () => {
  it('formats hours and minutes', () => {
    expect(minutesToHours(485)).toBe('8h 05m');
    expect(minutesToHours(45)).toBe('45m');
  });

  it('shows a dash rather than 0m for no time worked', () => {
    expect(minutesToHours(0)).toBe('—');
    expect(minutesToHours(null)).toBe('—');
    expect(minutesToHours(undefined)).toBe('—');
  });
});

describe('csv', () => {
  it('quotes fields containing commas, quotes or newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(null)).toBe('');
  });

  it('emits a header row and CRLF line endings', () => {
    const csv = toCsv([
      { name: 'Asha', hours: 8 },
      { name: 'Bo, Jr.', hours: 7.5 },
    ]);
    expect(csv).toBe('name,hours\r\nAsha,8\r\n"Bo, Jr.",7.5\r\n');
  });

  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});
