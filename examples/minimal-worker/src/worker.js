export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      service: 'agentmesh-minimal-worker',
      ok: true,
      path: url.pathname,
    });
  },
};
