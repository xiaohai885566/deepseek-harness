# 在 Cloudflare 上部署 DeepSeek Harness

[English](README.md)

`dsh web` 是一个 Node 程序：它自己持有 `node:http` 监听、会 `spawn` shell 工具、会加载原生插件（`native/system`）。这些能力在 Worker 的 V8 isolate 里都不存在，所以**不能**把它编译成一个 Worker。Cloudflare 上唯一能跑真身的形态是 **Containers**：容器跑完整的 `dsh web`，前面的 Worker 只做路由。

本目录就是这一层改造，不修改上游任何包的行为。

```
浏览器 ──HTTPS/WSS──► Worker (cloudflare/worker/src/index.ts)
                        │  可选 HTTP Basic 门禁
                        └─► Durable Object "main"（单实例，持有会话与磁盘）
                              └─► Container:8080  cloudflare/edge-proxy.mjs
                                    └─► 127.0.0.1:3080  dsh web（真身）
```

## 三个必须处理的问题

| 问题 | 处理方式 | 位置 |
| --- | --- | --- |
| `dsh web` 的 Host/Origin 围栏只接受 loopback、监听地址或 `--trusted-host`，而容器在平台侧的外部域名启动时未知 | 边缘代理把每个请求的 `Host` 改成 `127.0.0.1:3080`，`Origin` 同步改写，于是围栏恒定通过；`--public-url` 只用于显示，不授予信任 | `cloudflare/edge-proxy.mjs` |
| 启动 URL 带进程级 token，容器日志之外的入口拿不到 | 代理从 stdout 抓 `dsh web: …?token=…`，`GET /__dsh/launch` 与"未认证访问 `/`"都 302 到 `/?token=…`，由监听器自己签发 cookie | `cloudflare/edge-proxy.mjs` |
| 容器就绪前转发会打进半挂载的插件树 | 代理只在抓到启动行之后让 `/health` 返回 200，Durable Object 轮询它再放流量 | `cloudflare/edge-proxy.mjs`、`cloudflare/worker/src/index.ts` |

## 前置条件

- Cloudflare 账号开通 **Workers 付费版**（Containers 属于付费能力），并记下 Account ID。
- 本机有 **Docker**：`wrangler deploy` 用本地 Docker 构建镜像并推送到 Cloudflare 自己的 registry。
- Node.js 24（只用来跑 wrangler，镜像里自带 Node）。

## 部署

```sh
# 1. 登录
npx wrangler@4 login

# 2. 模型密钥（也可用 DEEPSEEK_API_KEY=sk-xxx ./cloudflare/deploy.sh 一步做完）
npx wrangler@4 secret put DEEPSEEK_API_KEY

# 3. 可选：整站 HTTP Basic 门禁（不设 Access 时建议设）
npx wrangler@4 secret put DSH_BASIC_AUTH      # 输入 user:password

# 4. 构建镜像 + 部署 Worker（首次 10–20 分钟，之后走层缓存）
./cloudflare/deploy.sh
```

`wrangler deploy` 会在仓库根目录读取 `wrangler.jsonc`，用 `build_context: "."` 把整个 monorepo 交给 `cloudflare/Dockerfile`。

## 部署之后

1. 打开 `https://<worker 域名>/__dsh/launch`。它 302 到 `/?token=…`，监听器签发 cookie 后再跳回 `/`，页面正常加载。
2. 首次请求会拉起容器，冷启动 1–3 分钟（镜像里已有构建产物，不需要现场编译）。
3. 想看容器日志：`npx wrangler@4 tail`，或 Dashboard → Workers → Containers。

## 配置

`wrangler.jsonc` 的 `vars`：

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_INSTANCE` | `standard-2` | 1 vCPU / 6 GiB / 12 GB 磁盘。镜像含完整 pnpm workspace，`standard-1` 的 8 GB 磁盘放不下 |
| `DSH_IDLE_TIMEOUT_MS` | `7200000` | 空闲多久停容器。调大省冷启动，调小省钱 |
| `DSH_PUBLIC_URL` | 取首个请求的 origin | 只影响显示、`DSH_WEB_URL` 和启动行，不影响信任判定 |

Secrets（`wrangler secret put`）：

| 名称 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 模型密钥，启动时注入容器 |
| `DSH_BASIC_AUTH` | `user:password`，Worker 层的 HTTP Basic 门禁；不设则不加门禁 |
| `DSH_EDGE_KEY` | 若设置，`/__dsh/*` 控制端点要求 `?key=…` |
| `DSH_EXTRA_ENV` | JSON 对象，额外容器环境变量，例如 `{"HTTPS_PROXY":"http://…"}` |

## 已知限制（都是平台属性，不是缺陷）

- **单实例**：`max_instances: 1`，所有请求进同一个 Durable Object。会话、workspace、cookie 密钥都在这一份磁盘上，多开会把一个对话拆到两个文件系统。
- **磁盘是实例级、不是持久卷**：容器停止后实例被回收就回到镜像状态。`/workspace` 与 `/data/home` 在实例存活期间保留。要真正持久，把 R2 桶按 FUSE 挂进容器（见 Cloudflare 的 `r2-fuse-mount` 示例），或定期把 `/data` 打包推到 R2。
- **成本**：按容器 vCPU/内存/磁盘的存活时间计费，另加 Worker 请求。调小 `DSH_IDLE_TIMEOUT_MS` 是最直接的省钱手段。
- **镜像较大**：完整 workspace 加依赖，首次推送慢；后续 deploy 只推变化的层。
- **公网可达**：容器里跑的是能执行任意 shell 的 agent。务必设 `DSH_BASIC_AUTH`，或把 Worker 域名放进 Cloudflare Access（Zero Trust）后面。

## 备选：纯浏览器版（不跑容器）

仓库自带 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`，产物是「浏览器 Web Worker 里跑 host + 内存 VFS」的静态页，可以直接 `wrangler pages deploy apps/web/dist`。代价是：没有真 shell、没有真文件系统、模型密钥在浏览器里、且需要浏览器直连模型 API（跨域受限）。要完整体验就用上面的容器方案。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| Worker 返回 502 `harness listener unreachable` | 容器进程起来了但 `dsh web` 没监听：`wrangler tail` 看容器 stdout 里的报错 |
| 页面 401 且 `/__dsh/launch` 也 401 | cookie 域名或时间不对：清掉该域名的 cookie 再走一次 `/__dsh/launch` |
| 一直 503 | 代理没抓到启动行：多半是 `dsh web` 启动失败（缺 `DEEPSEEK_API_KEY` 不会导致失败，缺 dist 会） |
| `wrangler deploy` 卡在 image build | 本机 Docker 没起，或首次拉 `node:24-bookworm-slim` 很慢 |
