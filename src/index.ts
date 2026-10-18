/**
 * PayGuard (AgentAllowance)
 * Milestone M0: Foundations & Spikes
 *
 * Core application entry point stub.
 */

export const PAYGUARD_VERSION = '0.1.0';
export const PROJECT_NAME = 'PayGuard';

export function getProjectInfo(): { name: string; version: string; milestone: string } {
  return {
    name: PROJECT_NAME,
    version: PAYGUARD_VERSION,
    milestone: 'M0',
  };
}
