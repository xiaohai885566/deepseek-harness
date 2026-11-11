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

## 免费账户

**不行**——Containers 只在 Workers 付费版（$5/月）提供，免费账户创建不了容器，所以"跑真身"这条路免费账户走不了。

免费账户能走的是 `cloudflare/static/`：静态资源 + 浏览器 Web Worker 里跑 host + 内存 VFS，不产生任何服务端进程。代价要说清楚：

- **没有真 shell**：`bash` 工具在虚拟文件系统里执行，碰不到宿主机，也 clone 不了真实仓库
- **没有持久化**：刷新页面后会话和文件都在内存里，模型凭据要重填
- **密钥在你自己的浏览器里**：浏览器直连 `api.deepseek.com`（该接口回 `access-control-allow-origin: <你的源>`，可以直连，不需要代理 Worker）
- **静态资源限制**：单文件 25 MiB、单次部署 20,000 个文件（脚本会先检查再部署）

```sh
./cloudflare/static/deploy.sh      # pnpm install → build → build:preview → 整形 → wrangler deploy
```

要真身又不想给 Cloudflare 付费：`cloudflare/Dockerfile` 是标准镜像，Koyeb / Render / Fly.io / Hugging Face Spaces / Google Cloud Run 都能直接跑同一份，把容器端口设成 8080、环境变量设 `DEEPSEEK_API_KEY` 即可。`edge-proxy.mjs` 那一层与平台无关，只要求容器内能监听一个端口。

## 访问保护

静态版默认是**完全公开**的：assets-only Worker 没有服务端，谁能拿到 URL 谁就拿到全部字节。所以前面挂了一个密码门（`cloudflare/worker/src/static-gate.ts`）：

| 行为 | 结果 |
| --- | --- |
| 未登录访问任何页面 | 302 到 `/__gate`（带 `next`，登录后回到原路径） |
| 未登录抓子资源（JS/CSS/vfs 镜像） | 401 JSON，不是 200 |
| 密码正确 | 303 + `dsh_gate` cookie：`HttpOnly; Secure; SameSite=Lax`，HMAC-SHA256 签名，30 天有效，cookie 里不含密码 |
| 密码错误 | 401，同页提示；超过 10 次锁 60 秒（每个 isolate 各自计数，不是全局限流） |
| `/__gate/logout` | 清 cookie |
| 轮换 `DSH_SITE_SECRET` | 所有已发 cookie 立刻失效 |
| 两个 secret 都没配 | **失败关闭**：全部请求 503，不会裸奔 |

换密码：

```sh
npx wrangler@4 secret put DSH_SITE_PASSWORD -c cloudflare/static/wrangler.jsonc
```

代价：`run_worker_first: true` 让每个请求都先过 Worker，所以静态资源也计入免费额度（10 万请求/天）。这条门只保护"能不能拿到页面"，模型密钥始终在各访问者自己的浏览器里。

### 模型端点中转 `/__proxy/`

浏览器版的所有模型请求都是**页面发出的跨域 `fetch`**。所以端点不返回 CORS 头、或者端点是 `http://` 而页面是 `https://`，都会失败——浏览器只给一个不透明的 `TypeError: Failed to fetch`，SDK 把它显示成一句 `Connection error.`，没有 host、没有状态码、没有原因。

这个部署自带同源中转，而且**自动生效**：worker 里的 `globalThis.fetch` 被包了一层（`webworker-runtime/src/fetch-relay.ts`），跨域请求自动改走 `<本站>/__proxy/<原 URL>`，由 Worker 替浏览器外呼。baseURL 照填端点原样，不用改。

```
baseURL: https://api.example.com/v1          ← 照常填
实际请求: https://<本站>/__proxy/https://api.example.com/v1/chat/completions
```

判断中转是否生效：中转的每个响应都带 `x-dsh-relay: 1`。没有这个头，说明部署里没有中转，wrapper 会把原请求再发一次（每个进程只多这一次），行为和以前一样。

也可以手动指定，两者等价：

```
https://<你的部署域名>/__proxy/https://api.example.com/v1
```

| 行为 | 结果 |
| --- | --- |
| 中转路径 | `/__proxy/<完整上游 URL>`，路径其余部分原样拼给上游 |
| 需要登录 | 是，和 assets 同一条 cookie；没 cookie 直接 401 |
| 转发头 | 只带 `authorization`、`x-api-key`、`content-type`、`accept`、`anthropic-*`、`openai-*`、`user-agent`；**不带** cookie / origin / referer |
| 响应 | 双向流式，SSE 逐 token 回传；`content-encoding`、`content-length`、`set-cookie` 一律剥掉 |
| 上游不可达 | 502，body 里写明上游 origin 和原因 |
| 限定可中转的主机 | 设 `DSH_PROXY_ALLOW=api.example.com,other.example`（逗号分隔，空=不限） |

不设 `DSH_PROXY_ALLOW` 时，任何拿到密码的人都能借这个 Worker 访问任意 http(s) 地址；单人部署可接受，多人共用建议设上。

## 浏览器版的数据保存

浏览器版的文件系统是从构建镜像挂载到内存里的。默认情况下**刷新即清空**：刚添加的模型、设置、会话记录全没了。

现在 worker 会把用户自己的两个子树（`home/`、`workspace/`）镜像进 IndexedDB，下次启动时先挂镜像、再把它们盖回去：

| 项 | 行为 |
| --- | --- |
| 保存范围 | 白名单：`home/profiles/<名字>/cordis.patch.yml`（设置与模型路由）、`home/sessions/`（会话）、`home/storages/`（工作区登记表等持久 KV）、`workspace/` |
| 不保存 | 其余全部。`home/` 里还放着**镜像自己的**引导状态——平台 patch `home/cordis.patch.yml` 和 profile 清单 `home/profiles/<名字>/package.json`——存了会在下次部署后盖住新版本，profile 的 patch 层和 bundle 列表就会跟新代码对不上 |
| 写入时机 | 每次写文件后一个微任务内落库，一次事务一批；`flush()` 可等待 |
| 恢复时机 | 镜像和 overlay 挂载完、profile 读取**之前** |
| 上限 | 单文件 4 MB，总量 64 MB，超了停止镜像并打一条警告 |
| 存不了时 | 报一次警告后停止镜像，写入照常成功（内存已提交） |
| 换数据库名 | `createWorkerHost({ persistence: { database: 'x' } })`；传 `false` 关掉 |
| 一键清空 | 打开 `?reset-vfs=1`（可与 `?preview-fixture=none` 同用），下次启动就是干净镜像 |

数据在浏览器本地（IndexedDB，按 origin 隔离）。要彻底清空：DevTools → Application → IndexedDB → 删 `dsh-web-vfs`。

## 跨设备同步（D1）

上面的 IndexedDB 只让**同一台设备**刷新不丢。要让手机和电脑看到同一份工作区，部署自己得有一份持久副本，这里用 D1：

| 项 | 行为 |
| --- | --- |
| 表结构 | `cloudflare/worker/schema.sql`：`vfs_entries`（一路径一行，目录也是行）+ `vfs_meta`（`revision` 计数） |
| 绑定 | `cloudflare/static/wrangler.jsonc` 的 `d1_databases` → `VFS_DB`；不设绑定则 `/__vfs/` 返回 503，退化成纯本地 |
| 读 | `GET /__vfs/snapshot` → `{ revision, entries: [{ p, d, m, b }] }`，`b` 是 base64 |
| 写 | `POST /__vfs/apply` → `{ mutations: [{ kind, path, mode?, bytes? }] }`，`kind` 为 `write`/`mkdir`/`remove`/`chmod`；`remove` 连子树一起删 |
| 鉴权 | 两个接口都在密码门后面，没有有效 cookie 一律 401 |
| 同步范围 | 和 IndexedDB 同一份白名单（`storage/policy.ts`），两个镜像不会跑偏 |
| 启动顺序 | 先问部署；部署有内容就以它为准，并把内容回写本地当离线缓存。部署为空/不可达才用本地副本 |
| 升级迁移 | 部署可读但为空、而本地有内容时，把本地整份传上去一次——老用户升级后不会从零开始 |
| 冲突 | 按路径后写覆盖。两台设备同时改同一个文件，谁最后落库算谁的 |
| 上限 | 单文件 1.5 MB（D1 单行 2 MB，base64 还要涨三分之一），超了跳过并警告，文件留在本机 |
| 关掉 | `createWorkerHost({ persistence: { remote: false } })` |

首次部署要建库和建表：

```bash
npx wrangler@4 d1 create dsh-vfs                       # 把返回的 database_id 填进 wrangler.jsonc
npx wrangler@4 d1 execute dsh-vfs --remote --file cloudflare/worker/schema.sql -c cloudflare/static/wrangler.jsonc
```

免费额度：5 GB 存储、每天 500 万行读 / 10 万行写——单人多设备远远用不完。

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

就是上面「免费账户」那一条，独立成一个目录：`cloudflare/static/wrangler.jsonc`（assets-only Worker，没有 `main`，不占 Worker 请求额度）+ `cloudflare/static/deploy.sh`。要完整体验就用容器方案。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| Worker 返回 502 `harness listener unreachable` | 容器进程起来了但 `dsh web` 没监听：`wrangler tail` 看容器 stdout 里的报错 |
| 页面 401 且 `/__dsh/launch` 也 401 | cookie 域名或时间不对：清掉该域名的 cookie 再走一次 `/__dsh/launch` |
| 一直 503 | 代理没抓到启动行：多半是 `dsh web` 启动失败（缺 `DEEPSEEK_API_KEY` 不会导致失败，缺 dist 会） |
| `wrangler deploy` 卡在 image build | 本机 Docker 没起，或首次拉 `node:24-bookworm-slim` 很慢 |
