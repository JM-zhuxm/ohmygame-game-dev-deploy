# 服务器与本地环境配置参考

## 目标服务器

| 项 | 值 |
|---|---|
| 域名 | cargo20.com（139.199.194.20） |
| 系统 | Ubuntu 22.04，nginx/1.24.0 |
| SSH 用户 | `ubuntu`（**不是 root**） |
| 密钥 | `~/lh0527.pem` |
| 站点根 | `/var/www/cargo20.com/client/dist` |
| 游戏根 | `/var/www/games.local/` |
| nginx 配置 | `/etc/nginx/sites-enabled/cargo20.com` |

```bash
ssh -i ~/lh0527.pem ubuntu@139.199.194.20
```

**注意**：`~/.hermes/.env` 里的 `SUDO_PASSWORD` 不是这台机器的密码，不要尝试。

## 本机 Daemon

| 项 | 值 |
|---|---|
| 源码 | `/home/mogege/ohmygame` |
| 端口 | `127.0.0.1:43110` |
| 数据 | `/home/mogege/ohmygame/.data` |
| 日志 | `/home/mogege/ohmygame/logs/daemon.log` |
| 项目 | `/home/mogege/omg-projects/<slug>` |

systemd 单元（均已 enabled）：

- `ohmygame-daemon.service` — `Restart=always`，带代理环境变量
- `ohmygame-mcp-sync.service` — `PartOf=ohmygame-daemon.service`，每次 daemon 重启自动把新 token 同步进 `~/.hermes/config.yaml`

Daemon 每次启动会重新生成 External MCP token，这是 sync 单元存在的原因。

## nginx 现有挂载（参考范式）

```nginx
location ^~ /campus/ {
    alias /var/www/campus-trade.local/;
    index index.html;
    try_files $uri $uri/ /campus/index.html;
}
location ~* ^/campus/assets/.*\.(js|css|woff2?|svg|png|jpg|jpeg|gif|webp)$ {
    alias /var/www/campus-trade.local/assets/;
    expires 7d;
    add_header Cache-Control "public, immutable";
    access_log off;
}
```

`/games/` 完全同构。新增挂载时**照抄这个结构**，不要改动已有 location。

## 首次初始化（换机器时）

```bash
# 1. 拉源码 + 装 Bun
git clone --depth 1 https://github.com/WhiteTowerAI/ohmygame
npm install -g bun          # 不要用 curl | bash，会被安全网关拦

# 2. 装依赖 + 构建
cd ohmygame && bun install --frozen-lockfile && bun run build:host

# 3. 预处理预装插件（Daemon 启动必需）
node --import tsx scripts/prepare-preinstalled-plugins.ts

# 4. 拉官方示例（可选，用于起步模板）
node --import tsx scripts/prepare-examples.ts

# 5. 装 systemd 单元
cp <unit files> ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ohmygame-daemon.service
systemctl --user enable --now ohmygame-mcp-sync.service
```

## Hermes MCP 配置

`~/.hermes/config.yaml`：

```yaml
mcp_servers:
  ohmygame:
    url: http://127.0.0.1:43110/external-mcp
    transport: http
    headers:
      Authorization: "Bearer <token>"
    timeout: 300
    connect_timeout: 60
```

token 由 `sync-mcp-token.sh` 自动维护，不要手改。

**注意**：MCP 工具在 Hermes 启动时加载。新增或修改 `mcp_servers` 后需重启 Hermes 才会出现在工具表。