import { describe, expect, it } from 'vitest';

import { drift, FlowError, isFlowError } from './flow-error';

// Guide step 6.3: a failing flow names its code and, for a drift, the entry of the selector map.

describe('FlowError', () => {
  it('carries the code, the selector and the wait of X', () => {
    const limited = new FlowError('RATE_LIMITED', 'X asks to wait.', { retryAfterMs: 60_000 });
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', selector: null, retryAfterMs: 60_000 });
    expect(isFlowError(limited)).toBe(true);
    expect(isFlowError(new Error('other'))).toBe(false);
  });

  it('names the entry of the selector map for a drift', () => {
    const error = drift('composer.textbox');
    expect(error).toMatchObject({
      name: 'FlowError',
      code: 'SELECTOR_DRIFT',
      selector: 'composer.textbox',
      message: 'The selector composer.textbox no longer matches.',
    });
  });
});
