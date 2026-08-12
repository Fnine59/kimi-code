/**
 * `capability` domain types — built-in product capabilities (kimi-cu,
 * kimi-webbridge) that bundle a binary runtime + agent wiring + manual
 * user steps. A capability is NOT a plugin: plugins are declarative
 * contributions to a session, while capabilities own imperative install
 * orchestration and a layered readiness state machine for product-specific
 * runtimes (macOS app + launchd service + TCC permissions; Windows signed
 * runtime; local HTTP daemon + browser extension). Steps marked `optional`
 * never block `ready`; `install.note` is a machine key clients localize.
 */

export type CapabilityId = 'kimi-cu' | 'kimi-webbridge';

export type CapabilityReadiness = 'not_installed' | 'partial' | 'ready' | 'unsupported';

export type CapabilityStepState = 'ok' | 'missing' | 'failed';

export interface CapabilityStep {
  readonly id: string;
  readonly state: CapabilityStepState;
  readonly detail?: string;
  readonly optional?: boolean;
}

export interface CapabilityInstallProgress {
  readonly running: boolean;
  readonly step?: string;
  readonly percent?: number;
  readonly error?: string;
  /**
   * Machine-key note from the last completed install (e.g.
   * 'user-skill-migrated' — a pre-existing user-source skill was replaced by
   * the plugin-managed copy). Clients localize it; cleared on the next
   * attempt.
   */
  readonly note?: string;
}

export interface CapabilityDetectResult {
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
}

export interface CapabilityStatus {
  readonly id: CapabilityId;
  /** Plugin identifier used to provide this capability's agent wiring. */
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly state: CapabilityReadiness;
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
  readonly install: CapabilityInstallProgress;
}

export type CapabilityInstallReporter = (step: string, percent?: number) => void;

export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  detect(): Promise<CapabilityDetectResult>;
  /**
   * Resolves with an optional machine-key note surfaced through
   * `CapabilityInstallProgress.note` (e.g. 'user-skill-migrated').
   */
  install(report: CapabilityInstallReporter): Promise<string | undefined>;
}
