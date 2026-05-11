# 侨情检测地图应用

这是一个 Vite + React + Express 的地图问答应用。前端负责地图展示和交互，后端负责调用基础大模型抽取地点坐标，并可选接入 RAGFlow 知识库生成回答。

## 本地开发

1. 安装依赖：

```bash
npm install
```

2. 复制环境变量模板：

```bash
cp .env.example .env
```

3. 填写 `.env` 里的模型和知识库配置。

4. 启动开发服务：

```bash
npm run dev
```

默认访问地址：

```text
http://localhost:3000
```

## 环境变量

必填：

- `OPENAI_API_KEY`：基础模型 API Key
- `OPENAI_BASE_URL`：OpenAI 兼容接口地址，例如 `https://your-endpoint/v1`
- `OPENAI_MODEL`：用于地点抽取和坐标生成的模型
- `OPENAI_TIMEOUT_MS`：基础模型请求超时时间，默认 `30000`
- `OPENAI_ANSWER_TIMEOUT_MS`：大模型兜底回答超时时间，默认 `60000`
- `OPENAI_MAX_RETRIES`：基础模型 SDK 自动重试次数，默认 `0`

可选：

- `PORT`：容器内部服务端口，默认 `3000`
- `HOST_PORT`：Docker Compose 暴露到服务器宿主机的端口，默认 `3000`
- `RAGFLOW_ENABLED`：是否启用 RAGFlow，默认按配置是否完整判断
- `RAGFLOW_BASE_URL`：RAGFlow 服务地址
- `RAGFLOW_API_KEY`：RAGFlow API Key
- `RAGFLOW_CHAT_ID`：RAGFlow chat assistant ID，不是 dataset ID
- `RAGFLOW_MODEL`：RAGFlow 模型标识
- `RAGFLOW_TIMEOUT_MS`：RAGFlow 请求超时时间，默认 `60000`
- `RAGFLOW_SESSION_REUSE_ENABLED`：是否复用 RAGFlow 会话，默认 `true`
- `RAGFLOW_SESSION_TTL_MS`：RAGFlow 会话复用时间，默认 `1800000`
- `QUERY_CACHE_TTL_MS`：同一问题结果缓存时间，默认 `600000`
- `QUERY_CACHE_MAX_ENTRIES`：问答缓存最大条数，默认 `120`
- `KNOWLEDGE_FALLBACK_DELAY_MS`：知识库检索超过多久后提前启动大模型兜底，默认 `2500`
- `LOCATION_EXTRACTION_SOFT_TIMEOUT_MS`：地点抽取最多阻塞回答多久，默认 `8000`

## 问答性能优化

后端问答链路做了三项优化：

- 耗时日志：每次 `/api/extractCities` 请求都会输出阶段耗时，便于定位慢在知识库、模型还是缓存。
- 并行处理：地点抽取和 RAGFlow 知识库问答会同时执行，减少串行等待。
- 延迟兜底：知识库检索超过短阈值还没返回时，大模型回答会提前启动；知识库未命中时不再从零开始等兜底。
- 软超时：地点抽取超时不会拖住问答主响应，超过阈值会先返回答案，地图点可为空。
- 复用与缓存：RAGFlow session 默认短时复用，相同问题会缓存一段时间，重复查询可以更快返回。

如果担心 RAGFlow 会话上下文影响不同问题，可以在 `.env` 中设置：

```bash
RAGFLOW_SESSION_REUSE_ENABLED=false
```

注意：`.env` 不要提交到 GitHub，仓库只提交 `.env.example`。

## 推送到 GitHub

首次上传：

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-org-or-user>/<repo-name>.git
git push -u origin main
```

如果仓库已经存在，只需要：

```bash
git remote add origin https://github.com/<your-org-or-user>/<repo-name>.git
git push -u origin main
```

GitHub Actions 已配置在 `.github/workflows/ci.yml`，每次 push 或 PR 会自动运行：

```bash
npm ci
npm run lint
npm run build
```

## Docker 本地验证

确认 `.env` 已填写后运行：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f qiaoqing-map
```

健康检查：

```bash
curl http://localhost:3000/healthz
```

停止服务：

```bash
docker compose down
```

## 服务器部署

服务器需要先安装 Git、Docker 和 Docker Compose。

1. 拉取代码：

```bash
git clone https://github.com/<your-org-or-user>/<repo-name>.git
cd <repo-name>
```

2. 创建生产环境变量：

```bash
cp .env.example .env
```

然后编辑 `.env`，填入真实的 API Key、RAGFlow 地址和端口。

3. 启动：

```bash
docker compose up -d --build
```

4. 后续更新：

```bash
git pull
docker compose up -d --build
```

## Nginx 反向代理示例

如果要用域名访问，可以让 Nginx 代理到容器暴露的 `3000` 端口：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

生产环境建议再配置 HTTPS，例如使用 Certbot 或服务器面板自动签发证书。

## 构建验证

提交前建议运行：

```bash
npm run lint
npm run build
```

Docker 镜像使用多阶段构建：先安装依赖并执行前端/后端构建，最终镜像只运行 `dist/server.js`。
