import { capabilitiesOf } from '@smp/platform-rules';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { createLinkedInAdapter } from './create-linkedin-adapter';
import { linkedInContext, publishRequest } from './testing/context';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeLinkedIn } from './testing/fake-linkedin';

// Guide step 4.12, "Fertig, wenn": the contract suite with fixtures. It runs for a company page,
// the account type on which LinkedIn lets the adapter read its posts back (reconcile, deleted
// posts, statistics). A personal profile cannot read its posts without the closed permission
// r_member_social; linkedin-adapter.test.ts covers that path.

describeAdapterContract(
  { describe, it, expect },
  'linkedin page (fixtures)',
  () => {
    const fake = new FakeLinkedIn();
    return createLinkedInAdapter({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      version: '202611',
      features: { organizations: true },
      fetch: fake.fetch,
      mediaFetch: fake.fetch,
      wait: () => Promise.resolve(),
    });
  },
  {
    accountTypes: ['PAGE', 'PROFILE'],
    context: (options = {}) =>
      linkedInContext({
        type: 'PAGE',
        ...(options.failStatus === undefined
          ? {}
          : {
              token: `fail-${String(options.failStatus)}${
                options.retryAfterSeconds === undefined ? '' : `-${String(options.retryAfterSeconds)}`
              }`,
            }),
      }),
    validRequest: () => publishRequest('Unsere neue Werkstatt in Kiel ist fertig. #Handwerk'),
    invalidRequest: () => publishRequest('x'.repeat(capabilitiesOf('LINKEDIN').text.maxLength + 1)),
  },
);
