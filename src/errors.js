export class AgentMeshDeployError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentMeshDeployError';
    this.code = code;
  }
}

export function operationError(code, message) {
  return new AgentMeshDeployError(code, message);
}
