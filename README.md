# ohmygame-game-dev-deploy

用 [OhMyGame](https://github.com/WhiteTowerAI/ohmygame)（开源 AI 游戏创作工作台）生成网页游戏，并发布到 `cargo20.com/games/` 供外网试玩。

这是 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的一个 **skill**：把「AI 生成游戏 → 构建 → 上线」这条链路固化成可复用的流程。

## 能力

```
OhMyGame Daemon (Linux headless)
  → External MCP (HTTP, 19 工具)
  → Hermes 调用 mcp_ohmygame_* 工具
  → Agent 生成 vite + TypeScript 游戏工程
  → npm run build → dist/ 静态产物
  → scp → 服务器 /var/www/games.local/<slug>/
  → nginx /games/ 路径 → https://cargo20.com/games/<slug>/
```

**关键设计**：web-game 项目构建产物是纯静态文件，资源用相对路径引用，因此挂到任意子路径都无需改代码。

## 目录结构

```
.
├── SKILL.md                 # skill 主体：完整流程、命令、Pitfall、验证清单
├── scripts/
│   ├── deploy-game.py       # 一键发版：打包 → scp → 解压 → chown → 外网自校验
│   └── inject-games-nginx.py # nginx /games/ 块注入（幂等 + 自动备份 + 失败回滚）
└── references/
    └── setup.md             # 服务器 / Daemon / MCP 配置参考
```

## 快速使用

### 1. 建项目并发任务

```bash
mkdir -p ~/omg-projects/<slug>
curl -s -X POST http://127.0.0.1:43110/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"游戏名","type":"web-game","workspacePath":"/home/xxx/omg-projects/<slug>"}'
```

### 2. 让 Agent 写代码

```bash
curl -s -X POST http://127.0.0.1:43110/projects/<PID>/conversations \
  -H "Content-Type: application/json" \
  -d '{"model":{"provider":"<PROVIDER_ID>","id":"MiniMax-M3"}}'

curl -s -X POST http://127.0.0.1:43110/projects/<PID>/conversations/<CID>/turns \
  -H "Content-Type: application/json" \
  -d '{"prompt":"做一个 XXX 小游戏…"}'
```

### 3. 构建并发布

```bash
cd ~/omg-projects/<slug> && npm install && npm run build
python3 scripts/deploy-game.py ~/omg-projects/<slug> <slug>
```

## 已验证的实测结论

| 结论 | 说明 |
|---|---|
| Agent 在 Linux 上完全可用 | 能 read / write / bash / 跑构建 / 改已有工程 |
| `game_use` 不可用 | 需要 Electron 桌面端预览窗口 |
| 图片 provider 默认不可用 | OpenRouter 零充值、Ark 需 endpoint ID；改用 SVG/CSS 程序化绘制 |
| 视频 provider 可用 | MiniMax China（`minimax-video-cn`） |
| discover 接口有坑 | 只补 `apiKey` 不补 `api`，必须传完整连接信息 |
| MiniMax 模型发现漏标 | 需手动设 `usages.language=true` |

## 安装到 Hermes

```bash
cp -r ohmygame-game-dev-deploy ~/.hermes/skills/
```

或直接在 Hermes 里用 `skill_manage` 创建 / patch。

## 许可证

MIT
