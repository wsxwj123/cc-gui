// 协议夹具：一个最小的 OpenAI 兼容上游，给 R28「非官方分支沿用实际上游模型读取」用例用。
// 它只回答 GET /v1/models，并**只记录请求头名字**（不记录任何取值），用来做
// 「不得向非 Claude provider 注入 Anthropic 专用参数」的反向断言。
import http from 'node:http';

export function startModelsStub({ port, models = ['r2528-stub-model'] } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    requests.push({ method: request.method, path: url.pathname, headerNames: Object.keys(request.headers).map(h => h.toLowerCase()) });
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const body = JSON.stringify({
        object: 'list',
        data: models.map(id => ({ id, object: 'model', created: 1789096000, owned_by: 'r2528-stub' })),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port,
        models,
        requests,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

/** 端口被占用时给出可执行的处置，而不是静默复用别的桩。 */
export function stubBusyHint(port) {
  return `端口 ${port} 已被占用：停掉占用者，或用 R2528_STUB_PORT 换端口并同步更新夹具里的 stubProvider.baseURL 与实例上该 provider 的地址`;
}
