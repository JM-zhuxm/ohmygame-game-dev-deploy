---
name: ohmygame-game-dev-deploy
description: "Use when making web games with OhMyGame."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [ohmygame, game-dev, mcp, deployment, nginx, web-game]
    related_skills: [native-mcp, git-project-workflow]
---

# OhMyGame 游戏开发与发布

## Overview

用 OhMyGame（开源 AI 游戏创作工作台）从零生成网页游戏，构建后发布到 cargo20.com 的 `/games/` 路径供外网试玩。

本 skill 覆盖的是**已在本机跑通的全链路**：

```
OhMyGame Daemon (Linux headless)
  → External MCP (HTTP, 19 工具)
  → Hermes 调用 mcp_ohmygame_* 工具
  → Agent 生成 vite+TS 游戏工程
  → npm run build → dist/ 静态产物
  → scp → 139.199.194.20:/var/www/games.local/<slug>/
  → nginx /games/ 路径 → https://cargo20.com/games/<slug>/
```

**核心事实**：web-game 项目构建产物是纯静态文件（`dist/index.html` + 相对路径资源），因此挂载到任意子路径都无需改代码。

## When to Use

- 用户要"做个小游戏"并希望外网能玩
- 需要用 AI Agent 生成完整的游戏工程（设计→代码→美术→构建）
- 需要把已构建的游戏发布到 cargo20.com

**Don't use for**:
- 微信/抖音小游戏平台原生包（有专用插件路线，需 AppID 和审核）
- Unity / Unreal / Godot 原生工程（不走 dist/ 静态产物路线）
- 商业级在线游戏（需要后端服务，本 skill 只覆盖静态前端）

## 环境基线（本机已验证）

| 项 | 值 |
|---|---|
| OhMyGame 源码 | `/home/mogege/ohmygame` |
| Daemon 端口 | `127.0.0.1:43110` |
| Daemon 数据目录 | `/home/mogege/ohmygame/.data` |
| systemd 单元 | `ohmygame-daemon.service`、`ohmygame-mcp-sync.service` |
| 项目工作区 | `/home/mogege/omg-projects/<name>`（**必须在 .data/projects 之外**） |
| MCP 工具前缀 | `mcp_ohmygame_*`（需重启 Hermes 才出现在工具表） |
| 目标服务器 | `ubuntu@139.199.194.20`（腾讯云，密钥 `~/lh0527.pem`） |
| 远端站点根 | `/var/www/games.local/` |
| nginx 配置 | `/etc/nginx/sites-enabled/cargo20.com` |

### 关键：项目 workspace 不能在 .data/projects 里

否则 API 报 `OhMyGame's project storage cannot be used as a workspace`。
正确做法：workspace 用 `/home/mogege/omg-projects/<slug>`。

## 标准流程

### 步骤 1：确认 Daemon 活着

```bash
systemctl --user is-active ohmygame-daemon.service
curl -s -m 10 http://127.0.0.1:43110/examples | head -c 200
```

若不活跃：`systemctl --user start ohmygame-daemon.service`

### 步骤 2：建项目

```bash
mkdir -p /home/mogege/omg-projects/<slug>
curl -s -X POST http://127.0.0.1:43110/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"中文名","type":"web-game","workspacePath":"/home/mogege/omg-projects/<slug>"}'
```

返回 201 即成功。记下 `id`。

### 步骤 3：建会话并发任务

```bash
# 建会话（模型用自配的 MiniMax-M3）
curl -s -X POST http://127.0.0.1:43110/projects/<PID>/conversations \
  -H "Content-Type: application/json" \
  -d '{"model":{"provider":"<PROVIDER_ID>","id":"MiniMax-M3"}}'

# 发任务（202 = 已受理）
curl -s -X POST http://127.0.0.1:43110/projects/<PID>/conversations/<CID>/turns \
  -H "Content-Type: application/json" \
  -d '{"prompt":"<完整需求>"}'
```

### 步骤 4：轮询结果

```bash
curl -s http://127.0.0.1:43110/projects/$PID/conversations/$CID \
  | python3 -c "
import json,sys
d=json.load(sys.stdin); t=d['turns'][-1]
print('status:', t.get('status'))
for it in t.get('items',[]):
    if it.get('type')=='agentMessage' and it.get('phase')=='final_answer':
        print(it.get('text'))
"
```

`status` 会走 `inProgress` → `completed`。**Agent 在 Linux 上完全可用**
（能 read / write / bash / 跑构建），只有 `game_use`（盯窗口试玩）需要桌面端。

### 步骤 5：本地验证构建

```bash
cd /home/mogege/omg-projects/<slug>
npm install && npm run build   # 产物在 dist/
npm test                       # 若项目带测试
```

**Law（法）**：构建未通过不得进入步骤 6。构建成功不等于功能正确，
但构建失败一定不能发布。

### 步骤 6：发布到 cargo20.com

用现成脚本（幂等 + 自校验）：

```bash
python3 /home/mogege/ohmygame/deploy-game.py /home/mogege/omg-projects/<slug> <slug>
```

脚本会：打包 dist → scp → 解压到 `/var/www/games.local/<slug>/` →
chown www-data → 外网 curl 校验 → 打印 `✓ 发布成功`。

### 步骤 7：更新 /games/ 列表页

列表页在 `/home/mogege/ohmygame/games-index/index.html`，
改 `GAMES` 数组后：

```bash
scp -i ~/lh0527.pem /home/mogege/ohmygame/games-index/index.html \
  ubuntu@139.199.194.20:/tmp/games-index.html
ssh -i ~/lh0527.pem ubuntu@139.199.194.20 \
  "sudo cp /tmp/games-index.html /var/www/games.local/index.html && sudo chown www-data:www-data /var/www/games.local/index.html"
```

## 模型 Provider 配置

OhMyGame 的 Agent 需要可用模型。本机方案：**MiniMax OpenAI 兼容端点**。

```bash
# 1. 建 provider
curl -s -X POST http://127.0.0.1:43110/settings/models/providers/custom \
  -H "Content-Type: application/json" \
  -d '{"name":"MiniMax","baseUrl":"https://api.minimax.cn/v1","api":"openai-completions","authentication":"api_key","apiKey":"<KEY>"}'

# 2. 发现模型（必须传完整连接信息！）
curl -s -X POST http://127.0.0.1:43110/settings/models/providers/discover \
  -H "Content-Type: application/json" \
  -d '{"providerId":"<PID>","name":"MiniMax","baseUrl":"https://api.minimax.cn/v1","api":"openai-completions","authentication":"api_key","apiKey":"<KEY>"}'

# 3. 保存（手动标记 usages.language=true）
curl -s -X PUT http://127.0.0.1:43110/settings/models/providers/<PID>/custom \
  -H "Content-Type: application/json" -d '{...同上加 "models":[...]}'
```

**Pitfall**：discover 路由**只补 apiKey，不补 api**。只传 `providerId` 会得到
`400 {"error":"Unsupported provider API"}`。必须带全 `name`/`baseUrl`/`api`/`authentication`/`preset`/`apiKey`。

**Pitfall**：MiniMax `/v1/models` 不返回 `architecture.output_modalities`，
自动发现不会标记哪些是语言模型。需手动把 `usages.language` 设为 true，
否则模型列表里全是 "Not suitable for Agent conversation"。

## 媒体生成 Provider

| 类型 | Provider | 状态 |
|---|---|---|
| 图像 | **Agnes 自定义** | ✅ 可用，OpenAI 兼容 `/images/generations` |
| 视频 | `minimax-video-cn` | ✅ 可用，`PUT /settings/models/providers/minimax-video-cn/minimax-key` |
| 图像 | OpenRouter 自定义 | ⚠️ 本机账号零充值（402） |
| 图像 | Volcengine Ark | ⚠️ 需 endpoint ID 格式的模型名 |

### Agnes 图像 provider（首选）

Agnes 是 OpenAI 兼容端点，一个 key 同时支持图像/视频/文本。

```bash
# key 不在 ~/.hermes/.env，在 /home/mogege/hive/agnes_integration/agnes_client.py 的代码默认值里。
# 提取到 0600 文件（不进代码、不进 Git）：
python3 - <<'PYEOF'
import re, os, stat
src = open('/home/mogege/hive/agnes_integration/agnes_client.py').read()
key = re.search(r'AGNES_API_KEY",\s*"([^"]+)"', src).group(1)
p = "/home/mogege/ohmygame/.data/agnes.key"
open(p, "w").write(key); os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
PYEOF

# 1. 建 provider（api 走 openai-completions，preset 留空让它按 openai-images 协议）
curl -s -X POST http://127.0.0.1:43110/settings/models/providers/custom \
  -H "Content-Type: application/json" \
  -d '{"name":"Agnes","baseUrl":"https://apihub.agnes-ai.com/v1","api":"openai-completions","authentication":"api_key","apiKey":"<KEY>"}'

# 2. discover —— 必须传完整连接信息
curl -s -X POST http://127.0.0.1:43110/settings/models/providers/discover \
  -H "Content-Type: application/json" \
  -d '{"providerId":"<PID>","name":"Agnes","baseUrl":"https://apihub.agnes-ai.com/v1","api":"openai-completions","authentication":"api_key","apiKey":"<KEY>"}'

# 3. 存模型 —— 手动打 usages.image（是对象，不是布尔值！）
#    模型 id: agnes-image-2.0-flash / agnes-image-2.1-flash / agnes-image-2.5-flash
```

**`usages.image` 完整结构**（字段写错会被 400 拒绝）：

```json
{
  "protocol": "openai-images",
  "resolutions": ["1K", "2K"],
  "aspectRatios": ["1:1", "3:4", "9:16", "16:9"],
  "maxReferenceImages": 0,
  "maxOutputs": 1
}
```

- `protocol` 必须是 `IMAGE_PROTOCOL_LABELS` 里的四个之一：
  `openai-images` / `gemini-generate-content` / `openrouter-images` / `volcengine-images`
- 非图像模型才用 `usages.language: true`
- `resolutions` 取值限定 `["512","1K","2K","4K"]`（`512` 仅 gemini/openrouter 协议可用）
- `aspectRatios` 取值限定 `["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]`

**验证**：`GET /image-models` 应能看到 Agnes 的三个图像模型。

**直连验证（绕开 daemon，先证明 key/路径/模型 id 都对）**：

```bash
curl -s -X POST "https://apihub.agnes-ai.com/v1/images/generations" \
  -H "Authorization: Bearer $AGNES_KEY" -H "Content-Type: application/json" \
  -d '{"model":"agnes-image-2.1-flash","prompt":"一只橘猫","n":1,"size":"1024x1024"}'
# 返回 {url, b64_json, revised_prompt}；url 需再 GET 一次下载
```

**Pitfall**：Agnes 的 key **不在** `~/.hermes/.env`，`/tmp/agnes.env` 也常常不存在。
在写 provider 之前先直连一次 `POST /v1/images/generations`，
200 才往下走——否则会误以为是 daemon 配置问题。

**Pitfall**：Agnes 返回 **PNG**。若项目里引用的是 `.webp` 扩展名会 404。
用 `.png` 扩展名，或自行转换格式后同步改代码引用。

**Pitfall**：Agent 可能在你配好 provider 之前就已经认定「生图不可用」并改用
SVG 替代。配好后要主动补一条 turn 告知 provider 已就绪 + providerId，
否则它会继续走降级方案。

### 视频 provider

```bash
curl -s -X PUT http://127.0.0.1:43110/settings/models/providers/minimax-video-cn/minimax-key \
  -H "Content-Type: application/json" -d '{"apiKey":"<KEY>"}'
```

### 设项目默认模型

```bash
curl -s -X PUT "http://127.0.0.1:43110/projects/<PID>/settings/generation-models" \
  -H "Content-Type: application/json" \
  -d '{"image":{"provider":"<PROVIDER_ID>","id":"<MODEL_ID>"}}'
```

### 图像 provider 不可用时

不要让 Agent 反复重试 `generate_canvas_media`。给它一条明确的转向指令：

> 停止排查生图。本机所有图像 provider 都不可用（OpenRouter 零充值、Ark 需 endpoint ID）。
> 改用 SVG / CSS 渐变 / Canvas 绘制所有视觉元素，不要引用任何外部图片文件。

Agent 收到后会转成纯代码方案。参考 `ember-route` 的 `relic-1.webp`——
它用项目调色板 + PIL 程序化绘制，同样能用。

## 把构建产物挂到子路径（静态托管）

web-game 的 `dist/` 是纯静态文件，**资源用相对路径引用**（vite `base: './'`），
所以挂到任意子路径都不需要改代码——这是能低成本上线的关键。

### 远端目录与 nginx

```bash
# 远端目录
sudo mkdir -p /var/www/games.local/<slug>
sudo tar xzf <slug>.tar.gz -C /var/www/games.local/<slug> --strip-components=1
sudo chown -R www-data:www-data /var/www/games.local
```

nginx location 照抄站上已有的 SPA 挂载结构（`/campus/`、`/ludi/`）：

```nginx
location ^~ /games/ {
    alias /var/www/games.local/;
    index index.html;
    try_files $uri $uri/ /games/index.html;
}
```

**Law（法）**：改 nginx 配置前必须备份，`nginx -t` 失败必须回滚。
用 `scripts/inject-games-nginx.py`（幂等 + 自动备份 + 失败回滚），不要手改。

### 上线后必查

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://cargo20.com/games/<slug>/          # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cargo20.com/games/<slug>/assets/xxx.js  # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cargo20.com/games/<slug>/art/yyy.webp    # 200
```

**Pitfall**：只查首页 200 不够。SPA 回退会让**任何**路径都返回 200，
资源 404 照样白屏。必须单独抽查一个 JS 和一个图片资源。

> 通用的子路径挂载方法（相对路径前提、`alias` vs `root`、注入脚本的幂等/备份/回滚要求）
> 见 `infrastructure-deployment` skill 的 `references/static-spa-subpath-hosting.md`。

## 写 Agent prompt 的要点

Agent 有工程判断力，但需求要**具体到可验收**。有效 prompt 结构：

```
做一个 XXX 小游戏（中文，Phaser 3 或纯 Canvas 均可）。要求：
1. <核心玩法，带具体数量>
2. <反馈机制：计分/解析/等级>
3. <技术约束：倒计时/竖屏/字体大/浅色背景>
4. <CTA：文案 + 跳转 URL>
5. 用 vite + TypeScript，npm run build 必须通过

请直接写代码实现，完成后运行 npm run build 验证。
```

**不要**只说"做个游戏"——Agent 会自行发挥，交付物往往偏离预期。

## Common Pitfalls

1. **workspace 在 `.data/projects` 里** → `OhMyGame's project storage cannot be used as a workspace`。改用 `/home/mogege/omg-projects/`。

2. **discover 只传 providerId** → `400 Unsupported provider API`。必须传完整连接信息（见上）。

3. **模型没标记 language** → 会话建不起来或 Agent 不响应。手动设 `usages.language=true`。

4. **OpenRouter 402** → 本机 OpenRouter 账号零充值，别浪费时间重试。视频用 MiniMax。

5. **SSH 用户名搞错** → 是 `ubuntu` 不是 `root`。`~/.hermes/.env` 里的 `SUDO_PASSWORD` 不是这台机器的密码。用 `ssh -i ~/lh0527.pem ubuntu@139.199.194.20`。

6. **nginx 注入前必须备份** → 脚本已自动做（`cargo20.com.bak-pre-games-<时间戳>`），
   `nginx -t` 失败自动回滚。

7. **资源路径必须是相对路径** → vite config 设 `base: './'`。
   绝对路径 `/assets/...` 挂到子路径后会 404。

8. **认为 `npm run build` 通过就等于游戏能玩** → Agent 自己的 skill 里就写着
   "Build success establishes compilation, not a successful playtest"。
   至少手工点一遍关键流程。

9. **图片资源按索引命名** → 如 `relic-0.webp`…插入新条目要同步重命名，
   否则 id 与图错位。参考 `ember-route` 的 `RELICS` 改动。

10. **当前会话看不到 `mcp_ohmygame_*` 工具** → skill loader 缓存。需重启 Hermes。
    急用时直接调 daemon 的 HTTP API（如上），效果等价。

11. **skill_manage description 有 60 字符硬上限** → 超过直接被拒。细节全放正文。

12. **图像 provider 不可用时 Agent 会反复重试** → 主动发一条转向指令
    （改用 SVG/CSS/Canvas 绘制），不要等它自己耗完几十次工具调用。

13. **Agent turn 显示 `inProgress` 但代码已落盘** → 轮询状态会滞后于实际改动。
    直接 grep 目标文件确认改动存在，再单独读 `final_answer`。等状态不如查产物。

14. **图片资源按索引命名时插入新条目会错位** → `relic-0.webp`…插入后要同步重命名，
    或用 `testOnly` 之类的标记避开。Agent 会自己发现并重编号 + 加 `migrateSave` 迁移旧存档。

15. **GitHub 推送前必扫密钥** → `grep -rn "sk-\|Bearer [A-Za-z0-9]\|apiKey.*=['\"][A-Za-z0-9_-]\{20,\}"`。
    仓库里可以放 IP、端口、文件路径，**不能放 key 值**。

16. **git 凭据未授权时不要反复试** → `gh auth status` 报未登录、`ssh -T git@github.com`
    报 `Permission denied (publickey)`，说明这台机器的 SSH key 还没加到 GitHub 账号。
    这需要用户在 GitHub 网页端操作，agent 无法自行解决——把仓库内容准备好、做完密钥扫描，
    然后一次性告诉用户需要做哪一步，别每 5 分钟重试。

## 配套 Skill

- `native-mcp` — MCP 服务接入、HTTP transport、token 自动同步、provider 媒体注册
  （`references/openai-compatible-provider-probing.md` 里有各厂商端点路径表）
- `git-project-workflow` — 仓库初始化与 GitHub 推送流程
- `infrastructure-deployment` — Nginx 子路径静态挂载
  （`references/static-spa-subpath-hosting.md`）

## Verification Checklist

发布前逐项确认：

- [ ] `systemctl --user is-active ohmygame-daemon.service` → active
- [ ] 项目 workspace 在 `/home/mogege/omg-projects/` 下
- [ ] Agent turn `status` = `completed`，且有 `final_answer`
- [ ] `npm run build` 通过，`dist/index.html` 存在
- [ ] `npm test` 通过（若项目有测试）
- [ ] `curl -s https://cargo20.com/games/<slug>/` → HTTP 200
- [ ] 抽查一个 JS 资源和一个图片资源 → HTTP 200（不是 404）
- [ ] 列表页 `/games/` → HTTP 200 且包含新游戏
- [ ] 手工点开玩一遍主流程

## 附带产物

**可复用脚本**（本 skill 目录下，复制到 `ohmygame/` 即可直接跑）：

- `scripts/deploy-game.py` — 一键发版（打包 → scp → 解压 → chown → 外网自校验）
- `scripts/inject-games-nginx.py` — nginx `/games/` 块注入（幂等 + 备份 + 回滚）
- `references/setup.md` — 服务器 / Daemon / MCP / systemd 单元配置参考

**官方示例**（已拉取到 `.runtime/examples/`）可作起点：

| slug | 类型 | 说明 |
|---|---|---|
| `ember-route` | web-game | 肉鸽卡牌，12 层 24 卡，Phaser 3 |
| `circuit-craftsman` | web-game | 40 关电路谜题，中英双语 |
| `tidal-workshop` | web-game | 放置经营，浮寇口 |
| `wetland-birdwatching` | web-game | 程序化湿地 + 鸟类 AI，Three.js |

用示例建项目：`POST /projects` 传 `{"exampleId":"ember-route", ...}`。