export const DEFAULT_REVIEW_ARTIFACT = '.agentmesh-deploy/reviews/latest.json';
export const DEFAULT_DIFF_ARTIFACT = '.agentmesh-deploy/diffs/latest.json';
export const DEFAULT_HANDOFF_ARTIFACT = '.agentmesh-deploy/handoffs/latest.json';

export function approvalGateFlags() {
  return [
    '--require-review',
    DEFAULT_REVIEW_ARTIFACT,
    '--require-diff',
    DEFAULT_DIFF_ARTIFACT,
  ];
}
