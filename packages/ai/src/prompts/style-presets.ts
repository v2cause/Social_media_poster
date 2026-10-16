// The style presets (architecture 5.2). Keys, names and instructions must equal the presets of
// the migration reference_data in packages/db; a test of the API compares them (ADR 0014).

export interface StylePreset {
  key: string;
  name: string;
  instructions: string;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    key: 'professional',
    name: 'Professional',
    instructions:
      'Clear, confident and factual. Lead with the key point in the first sentence, keep paragraphs short and the wording precise, use concrete specifics from the brief, and avoid slang, hype and filler.',
  },
  {
    key: 'storytelling',
    name: 'Storytelling',
    instructions:
      'Tell a short, concrete story. Open inside a specific moment, build to a turning point and close with the takeaway for the reader. Keep it personal and vivid, and use only details the brief provides.',
  },
  {
    key: 'casual',
    name: 'Casual',
    instructions:
      'Relaxed and conversational, like talking to a peer. Short sentences, plain words, a light touch of humor where it fits, and no corporate phrasing.',
  },
  {
    key: 'educational',
    name: 'Educational',
    instructions:
      'Teach one useful thing. Explain why it matters, give steps or a short list the reader can apply right away, and explain any term the audience may not know.',
  },
  {
    key: 'thought_leadership',
    name: 'Thought leadership',
    instructions:
      'Take a clear, reasoned position on a trend or a common belief in the industry. Offer an original angle, support it with arguments grounded in the brief, and invite the reader to discuss.',
  },
  {
    key: 'promotional',
    name: 'Promotional',
    instructions:
      'Present the offer and its concrete benefit for the target audience: what it is, who it is for and why now. End with one clear call to action. No exaggerated claims and no invented numbers.',
  },
];
