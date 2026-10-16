-- Reference data that every environment needs, production included (guide step 2.1). The demo
-- seed never runs in production, so these rows come with the migrations.
--
-- Changing a preset or a price means a new migration. A preset's instructions must match the
-- style catalog of the system prompt (packages/ai); a test compares them.

-- Style presets: no workspace, readable by every tenant (architecture 5.2, 6.2). The UI shows
-- them under translated names (i18n key styles.presets.<key>); name is the English label used
-- in prompts. The policies admit no rows without a workspace, and FORCE applies them to the
-- owner too, so the migration lifts FORCE for the insert and restores it right after.
ALTER TABLE post_style NO FORCE ROW LEVEL SECURITY;
INSERT INTO post_style (id, workspace_id, key, name, instructions, sort_order, updated_at) VALUES
  ('01a144a9-a274-7767-993c-73a19b361453', NULL, 'professional', 'Professional',
   'Clear, confident and factual. Lead with the key point in the first sentence, keep paragraphs short and the wording precise, use concrete specifics from the brief, and avoid slang, hype and filler.',
   10, CURRENT_TIMESTAMP),
  ('01a144a9-a277-7273-a2fa-9fd56a6d87a7', NULL, 'storytelling', 'Storytelling',
   'Tell a short, concrete story. Open inside a specific moment, build to a turning point and close with the takeaway for the reader. Keep it personal and vivid, and use only details the brief provides.',
   20, CURRENT_TIMESTAMP),
  ('01a144a9-a277-7273-a2fa-9fd67e3eb9a0', NULL, 'casual', 'Casual',
   'Relaxed and conversational, like talking to a peer. Short sentences, plain words, a light touch of humor where it fits, and no corporate phrasing.',
   30, CURRENT_TIMESTAMP),
  ('01a144a9-a277-7273-a2fa-9fd7a5b1ff58', NULL, 'educational', 'Educational',
   'Teach one useful thing. Explain why it matters, give steps or a short list the reader can apply right away, and explain any term the audience may not know.',
   40, CURRENT_TIMESTAMP),
  ('01a144a9-a277-7273-a2fa-9fd81ad83735', NULL, 'thought_leadership', 'Thought leadership',
   'Take a clear, reasoned position on a trend or a common belief in the industry. Offer an original angle, support it with arguments grounded in the brief, and invite the reader to discuss.',
   50, CURRENT_TIMESTAMP),
  ('01a144a9-a277-7273-a2fa-9fd9e910fab4', NULL, 'promotional', 'Promotional',
   'Present the offer and its concrete benefit for the target audience: what it is, who it is for and why now. End with one clear call to action. No exaggerated claims and no invented numbers.',
   60, CURRENT_TIMESTAMP);
ALTER TABLE post_style FORCE ROW LEVEL SECURITY;

-- Model prices in micro-USD per million tokens (1 USD = 1,000,000 micro-USD), checked against
-- the pricing page on 2026-10-16. Besides the default model, the targets that the server-side
-- fallback of claude-opus-5-5 can use (Claude Opus 5 and Claude Opus 4.8): a fallback attempt is
-- billed at the price of the model that ran it. No long-context surcharge applies to these models.
INSERT INTO price_book (id, model, valid_from, input_micros_per_mtok, output_micros_per_mtok,
                        cache_read_micros_per_mtok, cache_write_5m_micros_per_mtok,
                        cache_write_1h_micros_per_mtok, source, checked_at) VALUES
  ('01a144a9-a277-7273-a2fa-9fda1114e9ca', 'claude-opus-5-5', '2026-10-16 00:00:00+00',
   4000000, 20000000, 200000, 5000000, 8000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-16'),
  ('01a144a9-a277-7273-a2fa-9fdb8b722d54', 'claude-opus-5', '2026-10-16 00:00:00+00',
   5000000, 25000000, 500000, 6250000, 10000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-16'),
  ('01a144a9-a277-7273-a2fa-9fdc4bdbced1', 'claude-opus-4-8', '2026-10-16 00:00:00+00',
   5000000, 25000000, 500000, 6250000, 10000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-16');
