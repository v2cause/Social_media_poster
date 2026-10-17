// The conditions of the X browser (architecture 4.3, guide step 6.1). It runs in a workspace
// only when the deployment offers it (FEATURE_X_BROWSER_GLOBAL), the kill switch is off, the plan
// of the organization allows it (until phase 7 a switch of the platform admins), the workspace
// switched it on, and an owner or admin acknowledged the risk text of the current version. A new
// version of the text needs a new acknowledgement.

/** The key of the flags: the global row is the kill switch, an organization row the plan gate. */
export const X_BROWSER_FLAG = 'x_browser_automation';
/** The subject of the risk acknowledgements of the X browser. */
export const X_BROWSER_RISK_SUBJECT = 'x_browser';

export const X_BROWSER_BLOCKS = [
  'deployment',
  'kill_switch',
  'plan',
  'workspace',
  'acknowledgement',
] as const;
export type XBrowserBlock = (typeof X_BROWSER_BLOCKS)[number];

/** The flags that apply to a workspace; null where no row exists. */
export interface XBrowserFlags {
  /** false: the kill switch is on. No row: it is off. */
  global: boolean | null;
  /** true: the organization may use the X browser. No row: it may not. */
  organization: boolean | null;
  /** true: the workspace switched the X browser on. No row: it is off. */
  workspace: boolean | null;
}

export interface XBrowserConditions {
  offered: boolean;
  flags: XBrowserFlags;
  /** The text version of the acknowledgement in force, or null. */
  acknowledgedVersion: string | null;
  currentVersion: string;
}

/** The conditions that do not hold, in the order the settings explain them. */
export function xBrowserBlocks(conditions: XBrowserConditions): XBrowserBlock[] {
  const blocks: XBrowserBlock[] = [];
  if (!conditions.offered) {
    blocks.push('deployment');
  }
  if (conditions.flags.global === false) {
    blocks.push('kill_switch');
  }
  if (conditions.flags.organization !== true) {
    blocks.push('plan');
  }
  if (conditions.flags.workspace !== true) {
    blocks.push('workspace');
  }
  if (conditions.acknowledgedVersion !== conditions.currentVersion) {
    blocks.push('acknowledgement');
  }
  return blocks;
}

/** The blocks a workspace cannot lift itself; switching on needs none of them. */
export const OUTSIDE_BLOCKS: readonly XBrowserBlock[] = ['deployment', 'kill_switch', 'plan'];
