/**
 * codex-acp 2.2.2 session setup reduced to the usage patch's anchors
 * (dist/index.js:34797 CodexAcpClient.initialize, :35335 newSession). The
 * patch must opt thread/start into raw events or rawResponse/completed never
 * arrives; resume and fork have no such parameter.
 */
export const CODEX_SESSION_BOUNDARY = `
  async initialize(request) {
    const response = await this.codexClient.initialize({
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      },
      clientInfo: request.clientInfo
    });
    return response;
  }
  async newSession(request) {
    const response = await this.codexClient.threadStart({
      config: request.config,
      cwd: request.cwd
    });
    return response.thread.id;
  }
`;
