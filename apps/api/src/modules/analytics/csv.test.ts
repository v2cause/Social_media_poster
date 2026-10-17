import { describe, expect, it } from 'vitest';

import { CSV_HEADER, csvLine, csvRow, csvText } from './csv';

// Guide step 5.4: the CSV export keeps missing metrics empty, quotes what needs quotes and
// defuses texts that start like a formula.

describe('analytics CSV', () => {
  it('quotes separators, quotes and line breaks and defuses formulas', () => {
    expect(csvText('Mira Mock')).toBe('Mira Mock');
    expect(csvText('Kiel, Hafen')).toBe('"Kiel, Hafen"');
    expect(csvText('Der "Laden"')).toBe('"Der ""Laden"""');
    expect(csvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText('-1')).toBe("'-1");
  });

  it('writes a row per account and day with empty cells for metrics that are not reported', () => {
    expect(csvLine([...CSV_HEADER])).toBe(`${CSV_HEADER.join(',')}\r\n`);
    expect(
      csvRow({
        accountId: 'a',
        accountName: 'Mira, Mock',
        platform: 'X',
        day: '2026-10-15',
        impressions: 200,
        postReach: null,
        views: null,
        likes: 8,
        comments: 1,
        shares: 1,
        clicks: null,
        saves: null,
        engagements: 10,
        postsPublished: 1,
        followers: null,
        accountReach: null,
        profileViews: null,
      }),
    ).toBe('2026-10-15,X,"Mira, Mock",200,,,8,1,1,,,10,0.050000,1,,,\r\n');
  });
});
