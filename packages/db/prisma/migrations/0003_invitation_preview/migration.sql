-- The holder of an invitation link sees the name of the inviting organization before accepting
-- (guide step 1.9, invite/[token]). The invitation itself is readable through its token_holder
-- policy, so the subquery finds it only with the matching hash in the context.
CREATE POLICY invitation_preview ON organization FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM invitation i
    WHERE i.organization_id = organization.id
      AND i.token_hash = NULLIF(current_setting('app.invitation_token_hash', true), '')
  ));
